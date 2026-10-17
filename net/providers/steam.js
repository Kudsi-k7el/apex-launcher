'use strict';

/**
 * Steam provider - official metadata only.
 * ---------------------------------------------------------------------------
 * This talks to the two public, unauthenticated Steam endpoints that power the
 * storefront itself:
 *
 *   GET /api/storesearch/?term=...   -> real titles with real AppIDs
 *   GET /api/appdetails?appids=...   -> one title's full record
 *
 * It returns *descriptions of games*: name, blurb, long description, developer,
 * publisher, genres, release date, art URLs, transparent logo candidates and
 * price. It never returns, guesses or derives a download location.
 *
 * `deliver()` is the hook the download queue asks "can you hand me a file for
 * this?". Steam's answer is no, by design: Steam content is delivered by the
 * Steam client against a licence the user already owns, so this provider
 * declines and every other provider (a manifest pointing at an authorised
 * mirror, or itch.io with the user's own API key) keeps its normal path.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STORE = 'https://store.steampowered.com/api/';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
const TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map();

function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.p;
  const p = Promise.resolve().then(producer).catch(() => null);
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return p;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/json,*/*', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------
/** Steam ships long descriptions as HTML; Apex only ever shows plain text. */
function stripHtml(html) {
  return String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\u2022 ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');

/** Transparent wordmark candidates on the Steam CDN (verified downstream). */
function logoCandidates(appId) {
  const id = digits(appId);
  if (!id) return [];
  return [
    `${STEAM_CDN}${id}/logo.png`,
    `${STEAM_CDN}${id}/logo_2x.png`,
    `${STEAM_CDN}${id}/logo_3x.png`
  ];
}

function normalizeSearch(json, limit) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  return items
    .filter((it) => it && it.type === 'app' && digits(it.id))
    .slice(0, limit)
    .map((it) => ({
      appId: digits(it.id),
      title: it.name,
      tinyImage: it.tiny_image || null,
      price: it.price ? { final: it.price.final, currency: it.price.currency } : null,
      platforms: {
        windows: !!(it.platforms && it.platforms.windows),
        mac: !!(it.platforms && it.platforms.mac),
        linux: !!(it.platforms && it.platforms.linux)
      }
    }));
}

function normalizeDetails(appId, data) {
  const price = data.price_overview || null;
  return {
    appId: digits(appId),
    title: data.name || '',
    free: !!data.is_free,
    shortDescription: stripHtml(data.short_description),
    description: stripHtml(data.detailed_description),
    developers: data.developers || [],
    publishers: data.publishers || [],
    genres: (data.genres || []).map((g) => g && g.description).filter(Boolean),
    categories: (data.categories || []).map((c) => c && c.description).filter(Boolean),
    releaseDate: (data.release_date && data.release_date.date) || null,
    comingSoon: !!(data.release_date && data.release_date.coming_soon),
    header: data.header_image || null,
    capsule: data.capsule_image || null,
    background: data.background_raw || data.background || null,
    screenshots: (data.screenshots || []).map((s) => s && (s.path_full || s.path_thumbnail)).filter(Boolean),
    // The hero renders one of these instead of printing the title as text.
    logos: logoCandidates(appId),
    website: data.website || null,
    storeUrl: `https://store.steampowered.com/app/${digits(appId)}`,
    price: price
      ? {
        final: price.final_formatted || null,
        initial: price.initial_formatted || null,
        discountPct: Number(price.discount_percent) || 0,
        currency: price.currency || null
      }
      : null,
    requiredAge: Number(data.required_age) || 0
  };
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------
const provider = {
  id: 'steam',
  label: 'Steam',
  trust: 'official',
  /** True: this provider is a catalogue, not a file source. */
  metadataOnly: true,

  /**
   * @param {string} term
   * @param {{cc?:string,lang?:string,limit?:number}} [opts]
   */
  async search(term, opts = {}) {
    const q = String(term || '').trim();
    if (!q) return { ok: true, items: [] };

    const cc = String(opts.cc || 'us').toLowerCase();
    const lang = String(opts.lang || 'en').toLowerCase();
    const limit = Math.min(Math.max(1, Number(opts.limit) || 20), 50);

    const json = await cached(`search:${q}:${cc}:${lang}`, () =>
      getJson(`${STORE}storesearch/?term=${encodeURIComponent(q)}&l=${lang}&cc=${cc}`));

    if (!json) return { ok: false, items: [], error: 'Steam search unavailable' };
    return { ok: true, items: normalizeSearch(json, limit) };
  },

  /**
   * @param {string|number} appId
   * @param {{cc?:string,lang?:string}} [opts]
   */
  async details(appId, opts = {}) {
    const id = digits(appId);
    if (!id) return { ok: false, error: 'A Steam AppID is required' };

    const cc = String(opts.cc || 'us').toLowerCase();
    const lang = String(opts.lang || 'en').toLowerCase();

    const json = await cached(`details:${id}:${cc}:${lang}`, () =>
      getJson(`${STORE}appdetails?appids=${id}&l=${lang}&cc=${cc}`));

    const entry = json && json[id];
    // Mature titles answer `{ success: false }` until the caller presents the
    // storefront's age cookie; that is reported, never worked around.
    if (!entry || !entry.success || !entry.data) {
      return { ok: false, appId: id, error: 'Steam returned no data for this AppID' };
    }
    return { ok: true, ...normalizeDetails(id, entry.data) };
  },

  /** The hero's transparent wordmark candidates, without a network round trip. */
  logos(appId) {
    return logoCandidates(appId);
  },

  /**
   * The download queue asks every provider for a file for a title. Steam
   * declines: its content is installed by the Steam client against a licence
   * the user already owns, and Apex has no business fetching it.
   */
  deliver() {
    return {
      ok: false,
      reason: 'Steam titles are installed by the Steam client. Apex only mirrors their metadata.'
    };
  }
};

module.exports = { ...provider, logoCandidates, stripHtml };
