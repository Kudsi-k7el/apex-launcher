'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://fitgirl-repacks.site';
const TIMEOUT_MS = 20000;

const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9', Referer: BASE + '/' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function decode(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

function pageUrlFor(idOrUrl) {
  const raw = String(idOrUrl || '').trim();
  if (!raw) return BASE + '/';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return BASE + raw;
  return `${BASE}/${raw.replace(/^\/+/, '')}`;
}

async function search(term, opts = {}) {
  const q = String(term || '').trim();
  const cacheKey = `search:${q}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const url = q ? `${BASE}/?s=${encodeURIComponent(q)}` : BASE + '/';
  try {
    const html = await fetchText(url);
    const items = [];
    const seen = new Set();
    // FitGirl posts: <h1 class="entry-title"><a href="URL">Title</a></h1> or <h2>
    const re = /<h[123][^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]+href="(https?:\/\/fitgirl-repacks\.site\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = m[1];
      if (seen.has(href)) continue;
      seen.add(href);
      const title = decode(stripTags(m[2])).trim();
      if (!title) continue;
      // cover: preceding img
      const idx = html.indexOf(m[0]);
      const lookback = html.slice(Math.max(0, idx - 500), idx);
      const imgMatch = lookback.match(/src="(https?:\/\/[^"]+\.(?:webp|jpg|png|jpeg))"/i);
      items.push({
        id: href.replace(BASE + '/', '').replace(/\/$/, ''),
        title,
        developer: 'FitGirl Repack',
        url: href,
        size: '',
        sizeBytes: 0,
        cover: imgMatch ? imgMatch[1] : null,
        steamAppId: null,
        logo: null,
        mirrors: []
      });
    }
    const limit = Math.min(Math.max(1, Number(opts.limit) || 20), 60);
    const result = { ok: true, items: items.slice(0, limit) };
    _cache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    return { ok: false, items: [], error: (err && err.message) || 'FitGirl search failed' };
  }
}

async function details(idOrUrl, opts = {}) {
  const url = pageUrlFor(idOrUrl);
  const cacheKey = `details:${url}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  try {
    const html = await fetchText(url);
    const titleMatch = html.match(/<h1[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? decode(stripTags(titleMatch[1])).trim() : (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';

    // magnet links
    const magnets = [];
    const magRe = /href="(magnet:\?[^"]+)"/gi;
    let mm;
    while ((mm = magRe.exec(html))) magnets.push(decodeURIComponent(mm[1].replace(/&#0?38;/g, '&')));

    // direct hoster links (datanodes, fuckingfast, etc.)
    const direct = [];
    const linkRe = /href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(html))) {
      const href = lm[1];
      const text = stripTags(lm[2]).toLowerCase();
      if (/datanodes|fuckingfast|rapidgator|nitroflare|uploaded|1fichier|mega\.nz|mediafire/i.test(href) && /download|part\d/i.test(text + ' ' + href)) {
        if (!direct.includes(href)) direct.push(href);
      }
    }

    // cover image
    const coverMatch = html.match(/<img[^>]+class="[^"]*wp-post-image[^"]*"[^>]+src="([^"]+)"/i) || html.match(/property="og:image"[^>]+content="([^"]+)"/i);
    const cover = coverMatch ? coverMatch[1] : null;

    const result = {
      ok: true,
      id: url.replace(BASE + '/', '').replace(/\/$/, ''),
      title: title || url,
      url,
      size: '',
      sizeBytes: 0,
      steamAppId: null,
      mirrors: direct.length ? direct : [],
      magnet: magnets.length ? magnets[0] : null,
      magnets,
      cover,
      logo: null
    };
    _cache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not load FitGirl page' };
  }
}

async function deliver(target, ctx) {
  const spec = target || {};
  const det = await details(spec.id || spec.url, {});
  if (!det || !det.ok) {
    return { ok: false, reason: (det && det.error) || 'Could not resolve FitGirl item.' };
  }
  // Prefer direct hoster links; fall back to magnet (not downloadable by HTTP engine).
  const direct = Array.isArray(det.mirrors) && det.mirrors.length ? det.mirrors[0] : null;
  const url = spec.mirrorUrl || spec.mirror || spec.directUrl || direct || det.magnet || null;
  if (!url) {
    return { ok: false, reason: 'No downloadable link found for this item.' };
  }
  const isMagnet = /^magnet:/i.test(url);
  return {
    ok: true,
    item: {
      id: String(spec.id || det.id),
      title: spec.title || det.title,
      url,
      kind: isMagnet ? 'torrent' : 'http',
      sha256: null,
      checksumOptional: true,
      trustedSource: 'steamrip',
      size: spec.size || det.sizeBytes || 0,
      filename: spec.filename || null,
      extract: spec.extract !== false,
      dest: spec.dest || det.title,
      cover: spec.cover || det.cover || null,
      developer: spec.developer || 'FitGirl Repack',
      steamAppId: null,
      logo: null,
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: det.url },
      origin: 'fitgirl',
      magnet: det.magnet || null
    }
  };
}

const provider = {
  id: 'steamrip',
  label: 'FitGirl Repacks',
  trust: 'user',
  metadataOnly: false,
  async search(term, opts) { return search(term, opts); },
  async details(id, opts) { return details(id, opts); },
  logos() { return []; },
  async deliver(target, ctx) { return deliver(target, ctx); }
};

module.exports = { ...provider, search, details, deliver };
module.exports.provider = provider;