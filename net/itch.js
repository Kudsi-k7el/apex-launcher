'use strict';

/**
 * itch.io provider (main process).
 *
 * Discovery needs no credentials at all, because itch.io publishes two things
 * that are open to everyone:
 *
 *   - the browse pages as RSS      `<https://itch.io/games/free.xml>`
 *   - every game page as public JSON `<https://<author>.itch.io/<game>/data.json>`
 *
 * Those two are everything the discover surface needs, and neither costs the
 * user anything.
 *
 * Downloading is different. itch.io only hands out a file URL to a request it
 * can identify, so Apex asks for the user's *own* itch.io API key — the one
 * they generate at <https://itch.io/user/settings/api-keys> — and speaks to the
 * official API on their behalf. Nothing is fetched that the account could not
 * fetch itself, and the key is stored in local state with every other setting:
 * it never leaves this machine.
 *
 * Nothing here scrapes a download link out of a page, and nothing works around
 * a paywall: a paid build is only downloadable when the account already owns it.
 */

const WEB = 'https://itch.io';
const API = 'https://api.itch.io';
const UA = 'ApexLauncher/2.6 (+personal use)';
const TIMEOUT = 20000;

/** The browse feeds offered on the itch.io surface. */
const FEEDS = [
  { id: 'free',    label: 'Free games',    ico: 'gift',      path: '/games/free' },
  { id: 'popular', label: 'New & popular', ico: 'sparkles',  path: '/games/new-and-popular' },
  { id: 'rated',   label: 'Top rated',     ico: 'trophy',    path: '/games/top-rated' },
  { id: 'newest',  label: 'Just released', ico: 'rocket',    path: '/games/newest' },
  { id: 'demo',    label: 'Demos',         ico: 'download',  path: '/games/tag-demo' },
  { id: 'platformer', label: 'Platformers', ico: 'zap',      path: '/games/genre-platformer' },
  { id: 'roguelike',  label: 'Roguelikes',  ico: 'layers',   path: '/games/tag-roguelike' },
  { id: 'horror',     label: 'Horror',      ico: 'moon',     path: '/games/tag-horror' },
  { id: 'puzzle',     label: 'Puzzles',     ico: 'grid',     path: '/games/genre-puzzle' },
  { id: 'visual-novel', label: 'Visual novels', ico: 'bookmark', path: '/games/tag-visual-novel' },
  { id: 'multiplayer', label: 'Local multiplayer', ico: 'users', path: '/games/tag-local-multiplayer' }
];

async function httpGet(url, { headers = {}, timeoutMs = TIMEOUT } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
      redirect: 'follow',
      signal: ctl.signal
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, url: res.url, text, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(key, path, { method = 'GET' } = {}) {
  if (!key) throw new Error('No itch.io API key is configured.');
  const res = await httpGet(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    timeoutMs: TIMEOUT
  });
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = null; }
  if (!res.ok) {
    const msg = (json && Array.isArray(json.errors) && json.errors[0])
      || (res.status === 401 ? 'itch.io rejected the API key (401). Generate a fresh one at itch.io/user/settings/api-keys.'
        : res.status === 403 ? 'this account cannot download that build (403).'
          : `itch.io API error (${res.status}).`);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const out = json == null ? {} : json;
  // Preserve the final URL (after redirects) so callers can use it as a
  // download link when the endpoint answers with a redirect instead of JSON.
  if (!out.url && res.url && res.url !== `${API}${path}`) out.url = res.url;
  return out;
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function splitUrl(raw) {
  try {
    const u = new URL(String(raw));
    const m = /^([a-z0-9][a-z0-9-]*)\.itch\.io$/i.exec(u.hostname);
    if (!m) return null;
    const slug = u.pathname.split('/').filter(Boolean)[0] || '';
    if (!slug) return null;
    const author = m[1].toLowerCase();
    return { author, slug, id: `itch:${author}/${slug}` };
  } catch { return null; }
}

const FEED_NOISE = /^(free|windows|macos|osx|linux|android|html5|web|demo|browser|download)$/i;

function feedBrackets(title) {
  return [...title.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim()).filter(Boolean);
}

function feedValue(raw, name) {
  const m = raw.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function makeItem(meta, extra) {
  return {
    id: meta.id,
    title: extra.title || meta.slug,
    author: extra.author || meta.author,
    authorUrl: extra.authorUrl || `https://${meta.author}.itch.io`,
    url: `https://${meta.author}.itch.io/${meta.slug}`,
    cover: extra.cover || null,
    price: extra.price || 'Free',
    priceNote: extra.priceNote || null,
    tags: Array.isArray(extra.tags) ? extra.tags.slice(0, 6) : [],
    platforms: extra.platforms || {},
    blurb: extra.blurb || '',
    demo: !!extra.demo,
    published: extra.published || null
  };
}

function emptyPlatforms() { return { windows: false, osx: false, linux: false, android: false }; }

function parsePlatforms(raw) {
  const out = emptyPlatforms();
  const block = feedValue(raw, 'platforms');
  if (!block) return out;
  if (/<windows>yes<\/windows>/i.test(block)) out.windows = true;
  if (/<osx>yes<\/osx>/i.test(block)) out.osx = true;
  if (/<linux>yes<\/linux>/i.test(block)) out.linux = true;
  if (/<android>yes<\/android>/i.test(block)) out.android = true;
  return out;
}

function parseFeed(xml) {
  const out = [];
  const seen = new Set();
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const raw = m[1];
    const link = feedValue(raw, 'link').trim();
    const meta = splitUrl(link);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    const title = feedValue(raw, 'plainTitle') || feedValue(raw, 'title') || meta.slug;
    const brackets = feedBrackets(feedValue(raw, 'title'));
    const priceRaw = feedValue(raw, 'price').trim();
    const free = /^\$?0(\.0+)?$/.test(priceRaw) || brackets.some((b) => /^free$/i.test(b));
    const cover = feedValue(raw, 'imageurl').trim();
    out.push(makeItem(meta, {
      title,
      cover: cover || null,
      price: free ? 'Free' : (priceRaw || 'Paid'),
      tags: brackets.filter((b) => !FEED_NOISE.test(b)),
      platforms: parsePlatforms(raw),
      blurb: stripTags(feedValue(raw, 'description')).slice(0, 260),
      demo: brackets.some((b) => /^demo$/i.test(b)),
      published: feedValue(raw, 'pubDate').trim() || null
    }));
  }
  return out;
}

function parseSearch(html) {
  const cells = String(html || '').split(/<div class="game_cell[\s"]/).slice(1);
  const out = [];
  const seen = new Set();
  for (const cell of cells) {
    const href = (cell.match(/href="(https:\/\/[a-z0-9-]+\.itch\.io\/[^"?#]+)"/i) || [])[1] || '';
    const meta = splitUrl(href);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    const titleM = cell.match(/class="title game_link"[^>]*>([\s\S]*?)<\/a>/i);
    const cover = (cell.match(/data-lazy_src="([^"]+)"/i) || [])[1] || '';
    const authorM = cell.match(/class="game_author"><a[^>]*>([\s\S]*?)<\/a>/i);
    const genreM = cell.match(/class="game_genre">([\s\S]*?)<\/div>/i);
    const textM = cell.match(/class="game_text"[^>]*>([\s\S]*?)<\/div>/i);
    const priceM = cell.match(/class="price_value">([\s\S]*?)<\/div>/i);
    const platforms = emptyPlatforms();
    platforms.windows = /icon-windows8/.test(cell);
    platforms.osx = /icon-apple|icon-osx/.test(cell);
    platforms.linux = /icon-tux|icon-linux/.test(cell);
    platforms.android = /icon-android/.test(cell);
    const genre = genreM ? stripTags(genreM[1]) : '';
    out.push(makeItem(meta, {
      title: titleM ? stripTags(titleM[1]) : meta.slug,
      author: authorM ? stripTags(authorM[1]) : meta.author,
      cover: cover || null,
      price: priceM ? stripTags(priceM[1]) : 'Free',
      tags: genre ? [genre] : [],
      platforms,
      blurb: textM ? stripTags(textM[1]) : ''
    }));
  }
  return out;
}

const itch = {
  feeds() { return FEEDS.map((f) => ({ id: f.id, label: f.label, ico: f.ico })); },

  async browse(feedId = 'free', page = 1) {
    const feed = FEEDS.find((f) => f.id === feedId) || FEEDS[0];
    const p = Math.max(1, Math.min(20, Number(page) || 1));
    const url = `${WEB}${feed.path}.xml${p > 1 ? `?page=${p}` : ''}`;
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`itch.io could not be reached (${res.status}).`);
    return { ok: true, feed: feed.id, page: p, items: parseFeed(res.text) };
  },

  async search(query) {
    const q = String(query || '').trim();
    if (!q) return { ok: true, query: q, items: [] };
    const res = await httpGet(`${WEB}/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`itch.io search failed (${res.status}).`);
    return { ok: true, query: q, items: parseSearch(res.text) };
  },

  async detail(rawUrl) {
    const meta = splitUrl(rawUrl);
    if (!meta) throw new Error('That is not an itch.io game page.');
    const base = `https://${meta.author}.itch.io/${meta.slug}`;
    const res = await httpGet(`${base}/data.json`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`itch.io did not return details for this title (${res.status}).`);
    let json;
    try { json = JSON.parse(res.text); } catch { throw new Error('itch.io returned unreadable details.'); }
    const authors = Array.isArray(json.authors) ? json.authors : [];
    const price = json.price || null;
    return {
      ok: true,
      id: meta.id,
      gameId: json.id || null,
      title: json.title || meta.slug,
      author: authors[0] ? authors[0].name : meta.author,
      authorUrl: authors[0] ? authors[0].url : `https://${meta.author}.itch.io`,
      url: base,
      cover: json.cover_image || null,
      screenshots: Array.isArray(json.screenshots) ? json.screenshots.slice(0, 8) : [],
      tags: Array.isArray(json.tags) ? json.tags : [],
      price: price && !/^\$?0(\.0+)?$/.test(price) ? price : 'Free',
      suggestedPrice: json.suggested_price || null
    };
  },

  async profile(key) {
    const json = await apiRequest(key, '/profile');
    const u = json.user || json;
    return { ok: true, id: u.id || null, username: u.username || u.display_name || 'itch.io user', displayName: u.display_name || u.username || 'itch.io user' };
  },

  async uploads(key, gameId) {
    if (!gameId) throw new Error('This title has no numeric itch.io id yet.');
    const json = await apiRequest(key, `/games/${encodeURIComponent(String(gameId))}/uploads`);
    const list = Array.isArray(json.uploads) ? json.uploads : Array.isArray(json) ? json : [];
    return list.map((u) => ({
      id: u.id,
      filename: u.filename || u.display_name || `build-${u.id}`,
      size: Number(u.size) || 0,
      platform: u.platform || null,
      demo: !!u.demo,
      preorder: !!u.preorder,
      created: u.created_at || null
    }));
  },

  /**
   * A short-lived, signed URL for one build. itch.io has answered this as both
   * a JSON document (`{ url }`) and a 302 redirect to the file over the years,
   * so both shapes are handled. Redirects are followed manually so a large
   * file is never read into memory just to find out where it lives.
   */
  async resolveUpload(key, uploadId) {
    if (!uploadId) throw new Error('No build was selected.');
    const id = encodeURIComponent(String(uploadId));
    const endpoint = `${API}/uploads/${id}/download`;
    let last = null;

    for (const method of ['GET', 'POST']) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT);
        let res;
        try {
          res = await fetch(endpoint, {
            method,
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            redirect: 'manual',
            signal: ctl.signal
          });
        } finally {
          clearTimeout(timer);
        }

        // itch.io frequently answers with a 302 to the real (signed) file URL.
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (loc) return { ok: true, url: new URL(loc, endpoint).toString() };
        }

        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }

        if (!res.ok) {
          const msg = (json && Array.isArray(json.errors) && json.errors[0])
            || (res.status === 401 ? 'itch.io rejected the API key (401). Generate a fresh one at itch.io/user/settings/api-keys.'
              : res.status === 403 ? 'this account cannot download that build (403).'
                : `itch.io API error (${res.status}).`);
          const err = new Error(msg);
          err.status = res.status;
          throw err;
        }

        const url = typeof json === 'string' ? json
          : (json && (json.url || (json.download && json.download.url))) || null;
        if (url) return { ok: true, url, filename: (json && json.filename) || null };
        throw new Error('itch.io did not return a download URL for that build.');
      } catch (err) {
        last = err;
      }
    }
    throw last || new Error('itch.io did not return a download URL for that build.');
  }
};

module.exports = itch;
module.exports.FEEDS = FEEDS;
module.exports.splitUrl = splitUrl;
module.exports.parseFeed = parseFeed;
module.exports.parseSearch = parseSearch;