'use strict';

const mirrors = require('./mirrors');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://steamrip.com';
const TIMEOUT_MS = 20000;

const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchDirect(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        Connection: 'keep-alive',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        Referer: 'https://steamrip.com/'
      }
    });
    if (!res.ok) throw new Error(`SteamRip returned HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaJina(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS * 2);
  try {
    const res = await fetch('https://r.jina.ai/', {
      method: 'POST',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/html',
        'X-Return-Format': 'html'
      },
      body: JSON.stringify({ url })
    });
    if (!res.ok) throw new Error(`Jina reader returned HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const hit = _cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  let value;
  try {
    value = await fetchDirect(url);
  } catch (err) {
    value = await fetchViaJina(url);
  }
  _cache.set(url, { at: Date.now(), value });
  if (_cache.size > 100) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
  return value;
}

function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function decodeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function slugFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  } catch { return ''; }
}
function pageUrlFor(idOrUrl) {
  const raw = String(idOrUrl || '').trim();
  if (!raw) return BASE + '/';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return BASE + raw;
  return `${BASE}/${raw.replace(/^\/+/, '')}`;
}
function parseSizeToBytes(str) {
  const m = String(str || '').match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return 0;
  const unit = m[2].toUpperCase();
  const mult = unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
  return Math.round(num * mult);
}
function parseTitle(html) {
  let m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) return decodeHtml(stripTags(m[1])).trim();
  m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (m) return decodeHtml(stripTags(m[1])).replace(/\s*[-|].*$/, '').trim();
  return '';
}
function parseSize(html) {
  let m = html.match(/Game Size:[\s\S]{0,40}?([\d\\.,]+\s*(?:TB|GB|MB|KB))/i);
  if (m) return m[1].replace(/\\/g, '').trim();
  m = html.match(/(\d[\d.,]*\s*(?:TB|GB|MB))\s*(?:available space|game size)/i);
  if (m) return m[1].trim();
  return '';
}
function parseSteamAppId(html) {
  let m = html.match(/steamdb\.info\/app\/(\d+)/i);
  if (m) return m[1];
  m = html.match(/store\.steampowered\.com\/app\/(\d+)/i);
  if (m) return m[1];
  return null;
}
/** Best-effort provider name from a mirror button's own label. */
function providerLabelFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/\bgofile\b/.test(t)) return 'gofile';
  if (/\bbzzhr\b|\bbuzzheavier\b/.test(t)) return 'buzzheavier';
  if (/\bpixel/.test(t)) return 'pixeldrain';
  if (/\bfileditch\b|\bifd\b/.test(t)) return 'fileditch';
  if (/\bmega\b/.test(t)) return 'mega';
  if (/\b1fichier\b/.test(t)) return '1fichier';
  if (/\bmediafire\b/.test(t)) return 'mediafire';
  if (/\bdatanodes\b/.test(t)) return 'datanodes';
  if (/\bworkupload\b/.test(t)) return 'workupload';
  if (/\brootz\b/.test(t)) return 'rootz';
  if (/\bmegadb\b/.test(t)) return 'megadb';
  if (/\btorrent\b|\bmagnet\b/.test(t)) return 'webtorrent';
  return null;
}

/**
 * Mirror buttons with their provider label, in page order.
 *
 * The anchor text on a SteamRip page names the host ("GOFILE DOWNLOAD HERE",
 * "BZZHR DOWNLOAD HERE"), which is what lets us pick a resolver without
 * fetching the page.
 */
function parseMirrorList(html) {
  const out = [];
  const seen = new Set();
  const push = (rawHref, text) => {
    let href = String(rawHref || '').trim();
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const label = providerLabelFromText(text);
    out.push({ url: href, provider: label || mirrors.providerOf(href), label: stripTags(text) });
  };

  const re = /<a[^>]+href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[2]);
    if (!/download here/i.test(text)) continue;
    push(m[1], text);
  }
  return out;
}

function parseMirrors(html) {
  return parseMirrorList(html).map((entry) => entry.url);
}
function parseCover(html) {
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m) return m[1];
  return null;
}
function parseSearchResults(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href\s*=\s*"(\/?[^"]*free-download[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (!href) continue;
    if (!/^https?:\/\//i.test(href)) {
      href = href.startsWith('/') ? `${BASE}${href}` : `${BASE}/${href}`;
    }
    if (!/free-download/i.test(href)) continue;
    const title = decodeHtml(stripTags(m[2])).trim();
    if (!title || title.length < 3) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    const pos = m.index;
    const lookback = html.slice(Math.max(0, pos - 700), pos);
    let cover = null;
    const imgAttrs = ['data-back-webp', 'data-back', 'data-bg', 'data-background', 'data-lazy-src', 'data-src', 'data-original', 'src'];
    for (const attr of imgAttrs) {
      const reImg = new RegExp(attr + '\\s*=\\s*"([^"]+)"', 'gi');
      let im;
      let last = null;
      while ((im = reImg.exec(lookback))) last = im;
      if (last && last[1]) { cover = last[1]; break; }
    }
    if (cover && cover.startsWith('//')) cover = 'https:' + cover;
    if (cover && !/^https?:\/\//i.test(cover)) cover = `${BASE}${cover.startsWith('/') ? '' : '/'}${cover}`;

    const idx = html.indexOf(m[0]);
    const chunk = html.slice(Math.max(0, idx - 40), idx + m[0].length + 40);
    const sizeMatch = chunk.match(/([\d.,]+\s*(?:TB|GB|MB))/i);
    out.push({
      id: slugFromUrl(href),
      title,
      url: href,
      size: sizeMatch ? sizeMatch[1].trim() : null,
      sizeBytes: sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0,
      cover
    });
  }
  return out;
}

async function search(term, opts = {}) {
  const q = String(term || '').trim();
  const cacheKey = `search:${q}:${opts.limit || ''}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  try {
    const url = q ? `${BASE}/?s=${encodeURIComponent(q)}` : BASE + '/';
    const html = await fetchText(url);
    const parsed = parseSearchResults(html);
    const limit = Math.min(Math.max(1, Number(opts.limit) || 20), 60);

    // The listing page already carries everything a card needs - title, page
    // URL and box art - in a single request. Size, Steam app id and mirrors
    // live on the per-title page, which is fetched lazily (the renderer fills
    // the cards in the background, and `deliver` re-reads it at install time).
    // Enriching every result here meant ~20 *serial* page fetches with a
    // throttle between each, so the catalogue took ~20s to appear at all.
    const result = { ok: true, items: parsed.slice(0, limit) };
    _cache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    return { ok: false, items: [], error: (err && err.message) || 'SteamRip search failed' };
  }
}

const _detailsCache = new Map();
async function details(idOrUrl, opts = {}) {
  const cacheKey = String(idOrUrl || '');
  const hit = _detailsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const url = pageUrlFor(idOrUrl);
  try {
    const html = await fetchText(url);
    const title = parseTitle(html);
    const sizeText = parseSize(html);
    const steamAppId = parseSteamAppId(html);
    const mirrorList = parseMirrorList(html);
    const mirrorUrls = mirrorList.map((entry) => entry.url);
    const cover = parseCover(html);
    const result = {
      ok: true,
      id: slugFromUrl(url),
      title: title || slugFromUrl(url),
      url,
      size: sizeText,
      sizeBytes: parseSizeToBytes(sizeText),
      steamAppId,
      mirrors: mirrorUrls,
      mirrorList,
      cover,
      logo: steamAppId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/logo.png` : null,
      mirror: mirrorUrls.length ? mirrorUrls[0] : null
    };
    _detailsCache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not load SteamRip page' };
  }
}

function resolveMirror(u) {
  if (!u) return null;
  let url = String(u).trim();
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https?:\/\//i.test(url)) return null;
  const pd = url.match(/pixeldrain\.com\/(?:u|l)\/([A-Za-z0-9_-]+)/i);
  if (pd) return `https://pixeldrain.com/api/file/${pd[1]}`;
  return url;
}

async function deliver(target, ctx) {
  const spec = target || {};
  const settings = (ctx && ctx.settings) || {};
  let pageUrl = spec.url || spec.pageUrl || null;
  let det = null;
  try { det = await details(pageUrl || spec.id, {}); } catch (err) { det = { ok: false, error: err.message }; }
  if (det && det.ok === false) det = null;
  if (det && det.url) pageUrl = det.url;

  const listed = Array.isArray(det && det.mirrorList) && det.mirrorList.length
    ? det.mirrorList.map((entry) => entry.url)
    : (Array.isArray(det && det.mirrors) ? det.mirrors : []);

  // An explicitly supplied mirror (or a non-SteamRip direct URL) leads the list.
  const explicit = spec.mirrorUrl || spec.mirror || spec.directUrl
    || (spec.url && /^https?:\/\//i.test(spec.url) && !/steamrip\.com/i.test(spec.url) ? spec.url : null);
  const candidateMirrors = explicit ? [explicit, ...listed] : [...listed];
  if (Array.isArray(spec.mirrors)) candidateMirrors.push(...spec.mirrors);

  const resolved = await mirrors.resolveAll(candidateMirrors, { settings });
  if (!resolved.sources.length) {
    const detail = resolved.skipped.length
      ? resolved.skipped.map((s) => `${mirrors.providerOf(s.url)}: ${s.reason}`).join('; ')
      : 'the page exposed no download buttons';
    return { ok: false, reason: `No usable mirror for this title (${detail}).` };
  }

  const primary = resolved.sources[0];
  const title = spec.title || (det && det.title) || slugFromUrl(pageUrl || primary.url);
  const sizeBytes = primary.size || Number(spec.size) || (det && det.sizeBytes) || 0;
  const steamAppId = spec.steamAppId || (det && det.steamAppId) || null;

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: pageUrl || 'https://steamrip.com/',
    ...(primary.headers || {})
  };

  return {
    ok: true,
    item: {
      id: String(spec.id || (det && det.id) || slugFromUrl(pageUrl || primary.url)),
      title,
      url: primary.url,
      headers,
      kind: primary.kind || 'http',
      sha256: null,
      checksumOptional: true,
      trustedSource: 'steamrip',
      size: sizeBytes,
      filename: spec.filename || primary.filename || null,
      extract: spec.extract !== false,
      dest: spec.dest || title,
      cover: spec.cover || (det && det.cover) || null,
      developer: spec.developer || null,
      steamAppId,
      logo: steamAppId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/logo.png` : null,
      lightningProvider: primary.provider,
      lightningMirrors: resolved.sources,
      sources: resolved.sources,
      origin: 'steamrip'
    }
  };
}

const provider = {
  id: 'steamrip',
  label: 'SteamRip',
  trust: 'user',
  metadataOnly: false,
  async search(term, opts) { return search(term, opts); },
  async details(id, opts) { return details(id, opts); },
  logos() { return []; },
  async deliver(target, ctx) { return deliver(target, ctx); }
};

module.exports = { ...provider, search, details, parseSizeToBytes, parseMirrors, parseMirrorList, providerLabelFromText, parseTitle, parseSize, parseSearchResults, fetchText, pageUrlFor, slugFromUrl, resolveMirror };
module.exports.provider = provider;