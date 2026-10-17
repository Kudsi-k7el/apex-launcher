'use strict';

/**
 * Transparent logo / wordmark resolver (main process).
 * ---------------------------------------------------------------------------
 * The detail view does not print a game's name as text: the hero shows the
 * title's official transparent wordmark, centred over the banner art, and only
 * falls back to a typed <h1> when no wordmark can be found.
 *
 * Given a game this resolver tries, in order of authority:
 *
 *   1. a URL the game already declares (`logo` on the catalogue entry);
 *   2. a known Steam AppID -> the Steam CDN's own transparent `logo.png`;
 *   3. SteamGridDB (only when the user supplied their own API key) -> that
 *      project's community-curated *official* transparent logos;
 *   4. the title itself -> the public Steam store search, then back to (2).
 *
 * Two rules keep this honest:
 *   - It only ever returns a URL for an <img> tag. No installer, archive or
 *     game file is ever fetched here - nothing but image headers;
 *   - Every candidate is fetched with a `Range: bytes=0-63` request and its
 *     container is sniffed *before* the URL is handed back. A PNG whose IHDR
 *     declares no alpha channel is rejected outright, so the hero never gets
 *     an opaque rectangle pasted over the artwork it is supposed to sit on.
 *
 * Results are cached for the life of the process, so a library-wide pass costs
 * one request per title.
 */

const coverart = require('./coverart');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
const STEAM_STORE = 'https://store.steampowered.com/api/';
const SGDB = 'https://www.steamgriddb.com/api/v2';
const FETCH_TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HEAD_BYTES = 64;

// ---------------------------------------------------------------------------
// Tiny TTL cache
// ---------------------------------------------------------------------------
const cache = new Map();

function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.p;
  const p = Promise.resolve()
    .then(producer)
    .catch(() => null);
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 400) {
    for (const [k, v] of cache) {
      if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    // Still oversized: drop the oldest insertion.
    if (cache.size > 400) cache.delete(cache.keys().next().value);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Fetching helpers
// ---------------------------------------------------------------------------
const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');

function timeoutSignal(ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (timer.unref) timer.unref();
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function getJson(url, headers = {}) {
  const t = timeoutSignal();
  try {
    const res = await fetch(url, {
      signal: t.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...headers }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    t.done();
  }
}

/**
 * Reads just the first bytes of a remote image. Returns the bytes plus the
 * advertised content type, or null when the resource is unreachable.
 * @returns {Promise<{url:string, contentType:string, header:Buffer}|null>}
 */
async function readHead(url, bytes = HEAD_BYTES) {
  const t = timeoutSignal();
  try {
    const res = await fetch(url, {
      signal: t.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*', Range: `bytes=0-${bytes - 1}` }
    });
    if (!res.ok) return null;

    const out = [];
    let got = 0;
    const reader = res.body.getReader();
    try {
      while (got < bytes) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        out.push(Buffer.from(value));
        got += value.length;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }

    return {
      url: res.url || url,
      contentType: String(res.headers.get('content-type') || '').toLowerCase(),
      header: Buffer.concat(out).subarray(0, bytes)
    };
  } catch {
    return null;
  } finally {
    t.done();
  }
}

// ---------------------------------------------------------------------------
// Container sniffing
// ---------------------------------------------------------------------------
/**
 * Decides whether an image container carries a real alpha channel.
 *
 * @param {Buffer} buf first bytes of the file
 * @returns {boolean|null} true = alpha, false = provably opaque, null = unknown
 */
function sniffAlpha(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;

  // --- PNG ---------------------------------------------------------------
  // 8-byte signature, then the IHDR chunk: 4 length, 4 type, 4 width,
  // 4 height, 1 bit depth, 1 colour type (offset 25).
  if (
    buf.length >= 26
    && buf.readUInt32BE(0) === 0x89504e47
    && buf.readUInt32BE(4) === 0x0d0a1a0a
    && buf.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const colourType = buf[25];
    if (colourType === 4 || colourType === 6) return true;  // grey+alpha / truecolour+alpha
    if (colourType === 0 || colourType === 2) return false; // no alpha channel exists
    return null;                                            // palette: tRNS decides
  }

  // --- WebP --------------------------------------------------------------
  // Extended format only: 'RIFF' .... 'WEBP' 'VP8X' then a flags byte at 20
  // whose Alpha bit is 0x10. Simple (non-extended) WebP has no alpha.
  if (
    buf.length >= 21
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP'
    && buf.toString('ascii', 12, 16) === 'VP8X'
  ) {
    return (buf[20] & 0x10) !== 0;
  }

  // --- JPEG --------------------------------------------------------------
  // JPEG has no alpha channel in any standard encoding, so a JPEG can never be
  // a transparent wordmark. Returned as a hard `false`, not "unknown".
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return false;

  return null;
}

const isPngLike = (contentType, url) => /image\/png/i.test(contentType) || /\.png(\?|$)/i.test(String(url || ''));

/**
 * Fetches a candidate's header and reports what it actually is.
 * @returns {Promise<{url:string, ok:boolean, alpha:boolean|null, contentType:string}|null>}
 */
async function probeLogo(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;
  const head = await readHead(url);
  if (!head) return null;
  if (head.contentType && !/^image\//i.test(head.contentType)) return null;

  const alpha = sniffAlpha(head.header);
  // The header was fully readable: if it is a PNG with no alpha channel at all
  // it can never be a wordmark, so it is refused rather than merely deprioritised.
  if (alpha === false) return { url: head.url, ok: false, alpha, contentType: head.contentType };

  return { url: head.url, ok: true, alpha, contentType: head.contentType };
}

/**
 * First candidate that is genuinely transparent; a candidate whose alpha is
 * merely unknown is remembered as a fallback and only used if nothing better
 * exists.
 */
async function firstLogo(urls) {
  let fallback = null;
  for (const url of urls) {
    if (!url) continue;
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeLogo(url);
    if (!probe || !probe.ok) continue;
    if (probe.alpha === true) return probe;
    if (!fallback) fallback = probe;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
/** The Steam CDN serves each title its own transparent wordmark. */
function steamLogoCandidates(appId) {
  const id = digits(appId);
  if (!id) return [];
  return [
    `${STEAM_CDN}${id}/logo.png`,
    `${STEAM_CDN}${id}/logo_2x.png`,
    `${STEAM_CDN}${id}/logo_3x.png`
  ];
}

async function fromSteam(appId) {
  const id = digits(appId);
  if (!id) return null;
  return cached(`steam:${id}`, () => firstLogo(steamLogoCandidates(id)));
}

async function sgdbRequest(path, apiKey) {
  return getJson(`${SGDB}${path}`, { Authorization: `Bearer ${apiKey}` });
}

/** SteamGridDB indexes games by Steam AppID; that mapping is one call. */
async function sgdbGameId(appId, apiKey) {
  const id = digits(appId);
  if (!id) return null;
  return cached(`sgdbid:${id}`, async () => {
    const res = await sgdbRequest(`/games/steam/${id}`, apiKey);
    const game = res && res.success ? res.data : null;
    return game && game.id ? String(game.id) : null;
  });
}

/**
 * Community logos, filtered hard: official style, PNG only, no NSFW. The
 * `mimes` filter is a server-side hint, the alpha probe below is the real gate.
 */
async function sgdbLogoCandidates(gameId, apiKey) {
  if (!gameId) return [];
  const res = await cached(`sgdblogos:${gameId}`, () =>
    sgdbRequest(`/logos/game/${gameId}?styles=official&nsfw=false&mimes=image/png`, apiKey));

  const list = res && res.success && Array.isArray(res.data) ? res.data : [];
  return list
    .filter((a) => a && a.url && !a.nsfw && isPngLike(a.mime || '', a.url))
    .map((a) => a.url);
}

/**
 * The Steam store's own search. Only trusted when a result matches the title
 * closely, so "Valorant" can never silently resolve to somebody else's game.
 * (Same match rule the banner resolver uses - one implementation, one answer.)
 */
async function appIdForTitle(title) {
  try {
    return await coverart.appIdForTitle(title);
  } catch {
    return null;
  }
}

function result(probe, source, appId) {
  return {
    ok: true,
    url: probe.url,
    source,
    alpha: probe.alpha,
    transparent: probe.alpha === true,
    appId: digits(appId) || null
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * @param {{id?:string,name?:string,appId?:string|number,logo?:string}} spec
 * @param {{apiKey?:string}} [opts] SteamGridDB key (never required)
 * @returns {Promise<{ok:boolean,url?:string,source?:string,transparent?:boolean,
 *                    alpha?:boolean|null,appId?:string|null,error?:string}>}
 */
async function resolve(spec = {}, opts = {}) {
  const apiKey = String(opts.apiKey || process.env.STEAMGRIDDB_API_KEY || '').trim();
  const declared = typeof spec.logo === 'string' && /^https:\/\//i.test(spec.logo) ? spec.logo : null;
  let appId = digits(spec.appId) || null;

  try {
    // 1. A logo the game already declares.
    if (declared) {
      const probe = await probeLogo(declared);
      if (probe && probe.ok) return result(probe, 'declared', appId);
    }

    // 2. A known AppID -> the Steam CDN wordmark.
    let probe = await fromSteam(appId);
    if (probe) return result(probe, 'steam-cdn', appId);

    // 3. SteamGridDB, only with the user's own key.
    if (apiKey) {
      let gameId = appId ? await sgdbGameId(appId, apiKey) : null;
      if (!gameId && spec.name) {
        const found = await appIdForTitle(spec.name);
        if (found) gameId = await sgdbGameId(found, apiKey);
      }
      if (gameId) {
        probe = await firstLogo(await sgdbLogoCandidates(gameId, apiKey));
        if (probe) return result(probe, 'steamgriddb', appId);
      }
    }

    // 4. No AppID known yet: look the title up, then retry the CDN.
    if (!appId && spec.name) {
      const found = await appIdForTitle(spec.name);
      if (found) {
        appId = found;
        probe = await fromSteam(found);
        if (probe) return result(probe, 'steam-search', found);
      }
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not resolve logo' };
  }

  return { ok: false, error: 'No transparent logo found online' };
}

module.exports = {
  resolve,
  steamLogoCandidates,
  sgdbGameId,
  sgdbLogoCandidates,
  sniffAlpha,
  probeLogo,
  firstLogo,
  readHead,
  cache
};
