'use strict';

/**
 * Artwork resolver (main process).
 * ------------------------------------------------------------------
 * Finds a real banner for a game that has none of its own. Given a title it
 * tries, in order of authority:
 *
 *   1. a known Steam AppID   -> the Steam CDN's own cover art
 *   2. the title itself      -> the public Steam store search, but only when a
 *                               result matches the name closely enough
 *   3. the official home page-> that page's `og:image` / `twitter:image`
 *   4. Wikipedia             -> the article's lead image
 *
 * This only ever returns a URL for an <img> tag: no game files are downloaded,
 * no store page is scraped for installers, and nothing is invented. Every
 * candidate is fetched once and checked for a 200 + an image content type
 * before it is handed back, so the renderer never receives a dead link.
 *
 * Results are cached for the life of the process (the main process lives as
 * long as the app), which keeps a library-wide pass to one request per game.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';

/** Same candidate list the renderer walks, in the same order. */
const steamCandidates = (appId) => {
  const id = String(appId || '').replace(/[^0-9]/g, '');
  if (!id) return [];
  return [
    `${STEAM_CDN}${id}/library_600x900.jpg`,
    `${STEAM_CDN}${id}/header.jpg`,
    `${STEAM_CDN}${id}/library_hero.jpg`,
    `${STEAM_CDN}${id}/capsule_616x353.jpg`,
    `${STEAM_CDN}${id}/capsule_231x87.jpg`
  ];
};

// ---------------------------------------------------------------------------
// Tiny cache
// ---------------------------------------------------------------------------
const cache = new Map();

function cached(key, producer) {
  if (cache.has(key)) return cache.get(key);
  const p = producer().catch(() => null);
  cache.set(key, p);
  if (cache.size > 300) {
    const first = cache.keys().next().value;
    if (first !== key) cache.delete(first);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Fetching helpers
// ---------------------------------------------------------------------------
async function get(url, { timeoutMs = 9000, type = 'text' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: type === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) return null;
    return type === 'json' ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when `url` really serves an image. */
async function isImage(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    const type = res.headers.get('content-type') || '';
    try { await res.body.cancel(); } catch { /* ignore */ }
    return res.ok && /^image\//i.test(type);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** First candidate that actually resolves to an image. */
async function firstImage(urls) {
  for (const url of urls) {
    if (!url) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isImage(url)) return url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
async function fromSteam(appId) {
  if (!appId) return null;
  return cached(`steam:${appId}`, () => firstImage(steamCandidates(appId)));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The Steam store's own search. Only trusted when a result matches the title
 * closely, so "Valorant" cannot silently resolve to somebody else's game.
 */
async function appIdForTitle(title) {
  const want = norm(title);
  if (want.length < 3) return null;

  return cached(`find:${want}`, async () => {
    const data = await get(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=en&cc=us`,
      { type: 'json' }
    );
    const items = (data && Array.isArray(data.items) ? data.items : [])
      .filter((it) => it && it.type === 'app' && it.id);

    for (const it of items) {
      const got = norm(it.name);
      const close = got === want
        || (got.length > 3 && want.length > 3 && (got.startsWith(want) || want.startsWith(got)));
      if (close) return String(it.id);
    }
    return null;
  });
}

/** The `og:image` (or `twitter:image`) a page advertises as its banner. */
function pickMetaImage(html, base) {
  if (!html) return null;
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const url = m[1].replace(/&amp;/g, '&').trim();
      try { return new URL(url, base).href; } catch { return url; }
    }
  }
  return null;
}

async function fromOfficialPage(url) {
  if (!url) return null;
  return cached(`page:${url}`, async () => {
    const html = await get(url);
    const img = pickMetaImage(html, url);
    return img && await isImage(img) ? img : null;
  });
}

/** Wikipedia's lead image, preferring the full-size original. */
async function fromWikipedia(title) {
  if (!title) return null;
  return cached(`wiki:${title}`, async () => {
    const data = await get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { type: 'json' }
    );
    if (!data) return null;
    const urls = [
      data.originalimage && data.originalimage.source,
      data.thumbnail && data.thumbnail.source
    ].filter(Boolean);
    return firstImage(urls);
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * @param {{id?:string, name?:string, appId?:string|number, url?:string, wiki?:string}} spec
 * @returns {Promise<{ok:boolean, url?:string, source?:string, appId?:string, error?:string}>}
 */
async function resolve(spec = {}) {
  const { name, url, wiki } = spec;
  const appId = spec.appId != null && String(spec.appId).replace(/[^0-9]/g, '') || null;

  try {
    // 1. A Steam AppID we already know about.
    let art = await fromSteam(appId);
    if (art) return { ok: true, url: art, source: 'steam', appId };

    // 2. Look the title up on Steam.
    if (!appId && name) {
      const found = await appIdForTitle(name);
      if (found) {
        art = await fromSteam(found);
        if (art) return { ok: true, url: art, source: 'steam-search', appId: found };
      }
    }

    // 3. The publisher's own page.
    art = await fromOfficialPage(url);
    if (art) return { ok: true, url: art, source: 'official' };

    // 4. Wikipedia.
    art = await fromWikipedia(wiki || name);
    if (art) return { ok: true, url: art, source: 'wikipedia' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not resolve art' };
  }

  return { ok: false, error: 'No artwork found online' };
}

module.exports = { resolve, steamCandidates, appIdForTitle, pickMetaImage, isImage, cache };
