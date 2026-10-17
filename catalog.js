'use strict';

/**
 * Live store catalogue (main process).
 * ------------------------------------------------------------------
 * The Store tab's built-in list is a curated handful of titles. This module
 * gives it the *entire* Steam store instead: search returns real store entries
 * with real AppIDs, real prices and real cover art, straight from the public
 * Steam storefront endpoints.
 *
 * Two endpoints are used, both public and key-less:
 *
 *   storesearch  - the same autocomplete the Steam store's own search box uses.
 *                  Fast, unauthenticated, ideal for type-ahead.
 *   appdetails   - full record for one AppID (description, release date,
 *                  coming-soon flag, screenshots). Rate limited by Valve, so
 *                  it is only called when a user actually opens a title, and
 *                  every response is cached.
 *
 * Everything here is metadata about games that are genuinely published on
 * Steam. Nothing downloads game files: picking a result still hands off to the
 * store that owns the licence, exactly like the rest of the app.
 */

const CURRENCY_FALLBACK = { cc: 'us', l: 'en' };

// ---------------------------------------------------------------------------
// Tiny TTL cache (per-process; the main process lives as long as the app)
// ---------------------------------------------------------------------------
const cache = new Map();

function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.value);
  return producer().then((value) => {
    cache.set(key, { at: now, value });
    // Keep the cache from growing without bound in a long session.
    if (cache.size > 400) {
      for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
    }
    return value;
  });
}

/** fetch with a hard timeout and a browser-ish UA. */
async function getJson(url, { timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApexLauncher/2.0',
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
/** Steam prices arrive as integer cents. */
function money(cents, currency) {
  if (cents == null) return null;
  const amount = Number(cents) / 100;
  const sym = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', CAD: 'C$', AUD: 'A$', JPY: '\u00a5', BRL: 'R$' }[currency];
  if (sym) return `${sym}${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency || ''}`.trim();
}

// Steam CDN art, by AppID. These are the same images the store page uses.
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
const artFor = (appId) => ({
  cover: `${STEAM_CDN}${appId}/library_600x900.jpg`,
  wide: `${STEAM_CDN}${appId}/header.jpg`,
  hero: `${STEAM_CDN}${appId}/library_hero.jpg`,
  logo: `${STEAM_CDN}${appId}/logo.png`
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
/**
 * Searches the whole Steam store.
 * @param {string} term
 * @param {{cc?:string, l?:string, limit?:number}} [opts]
 * @returns {Promise<{ok:boolean, items:Array<object>, error?:string}>}
 */
async function search(term, opts = {}) {
  const q = String(term || '').trim();
  if (q.length < 2) return { ok: true, items: [] };

  const cc = opts.cc || CURRENCY_FALLBACK.cc;
  const l = opts.l || CURRENCY_FALLBACK.l;
  const limit = Math.max(1, Math.min(60, opts.limit || 24));
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=${l}&cc=${cc}`;

  try {
    const data = await cached(`search:${cc}:${l}:${q.toLowerCase()}`, 5 * 60 * 1000, () => getJson(url));
    const raw = Array.isArray(data && data.items) ? data.items : [];

    const items = raw
      .filter((it) => it && it.type === 'app' && it.id)
      .slice(0, limit)
      .map((it) => {
        const appId = String(it.id);
        const currency = (it.price && it.price.currency) || null;
        const final = it.price ? it.price.final : null;
        const initial = it.price ? it.price.initial : null;
        const discounted = initial != null && final != null && final < initial;
        return {
          source: 'steam',
          appId,
          name: it.name,
          // What the app uses internally; the store card then renders exactly
          // like a curated catalogue entry.
          priceLabel: final == null ? 'Not for sale' : money(final, currency),
          listPrice: discounted ? money(initial, currency) : null,
          discountPct: discounted ? Math.round((1 - final / initial) * 100) : 0,
          platforms: it.platforms || {},
          metascore: it.metascore ? Number(it.metascore) : null,
          controller: it.controller_support || null,
          art: artFor(appId),
          // Steam always returns this thumbnail, so it can back a card whose
          // larger art has not been published yet.
          tinyImage: it.tiny_image || null,
          url: `https://store.steampowered.com/app/${appId}/`
        };
      });

    return { ok: true, items };
  } catch (err) {
    return { ok: false, items: [], error: (err && err.message) || 'Search failed' };
  }
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------
/**
 * Full store record for one AppID.
 * @param {string|number} appId
 * @param {{cc?:string, l?:string}} [opts]
 */
async function details(appId, opts = {}) {
  const id = String(appId || '').replace(/[^0-9]/g, '');
  if (!id) return { ok: false, error: 'No AppID given' };

  const cc = opts.cc || CURRENCY_FALLBACK.cc;
  const l = opts.l || CURRENCY_FALLBACK.l;
  const url = `https://store.steampowered.com/api/appdetails?appids=${id}&l=${l}&cc=${cc}`;

  try {
    const data = await cached(`details:${cc}:${l}:${id}`, 30 * 60 * 1000, () => getJson(url, { timeoutMs: 12000 }));
    const entry = data && data[id];
    if (!entry || !entry.success || !entry.data) {
      return { ok: false, error: 'Steam has no store record for this title' };
    }

    const d = entry.data;
    const price = d.price_overview || null;
    const release = d.release_date || {};

    return {
      ok: true,
      data: {
        appId: id,
        name: d.name,
        type: d.type,
        isFree: !!d.is_free,
        shortDescription: stripTags(d.short_description || ''),
        description: stripTags(d.detailed_description || '').slice(0, 1400),
        developers: d.developers || [],
        publishers: d.publishers || [],
        genres: (d.genres || []).map((g) => g.description),
        release: release.date || null,
        comingSoon: !!release.coming_soon,
        // An exact ISO day when Steam published one, else null. Backs the
        // release countdown; vague dates ("Q1 2027") simply have no countdown.
        releaseIso: parseReleaseDate(release.date),
        header: d.header_image || `${STEAM_CDN}${id}/header.jpg`,
        screenshots: (d.screenshots || []).slice(0, 6).map((s) => s.path_full),
        art: artFor(id),
        priceLabel: d.is_free ? 'Free to Play' : (price ? money(price.final, price.currency) : (release.coming_soon ? 'No price yet' : 'Not for sale')),
        listPrice: price && price.initial > price.final ? money(price.initial, price.currency) : null,
        discountPct: price && price.initial > price.final ? price.discount_percent : 0,
        website: d.website || null,
        url: `https://store.steampowered.com/app/${id}/`
      }
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not load details' };
  }
}

// ---------------------------------------------------------------------------
// Release dates
// ---------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "YYYY-MM-DD" from parts, or null when the day is nonsense. */
function isoDay(year, month, day) {
  if (!year || !month || !day || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Turns a Steam release date into an ISO day, when it actually is one.
 *
 * Steam writes full dates as "19 Nov, 2026" or "Nov 19, 2026", but also uses
 * vague strings such as "2026", "Q1 2027" or "Coming soon". Only exact dates
 * can back a live countdown, so anything else returns null rather than a guess.
 */
function parseReleaseDate(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const monthOf = (word) => MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());
  // "19 Nov, 2026" / "19 November 2026"
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*,?\s*(\d{4})$/);
  if (m && monthOf(m[2]) >= 0) return isoDay(+m[3], monthOf(m[2]) + 1, +m[1]);
  // "Nov 19, 2026" / "November 19, 2026"
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})\s*,?\s*(\d{4})$/);
  if (m && monthOf(m[1]) >= 0) return isoDay(+m[3], monthOf(m[1]) + 1, +m[2]);
  return null;
}

/** Steam descriptions are HTML; the renderer shows plain text. */
function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li)>/gi, '\n')
    .replace(/<li>/gi, ' \u2022 ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { search, details, artFor, money, stripTags, parseReleaseDate, cache };
