'use strict';

/**
 * Project Lightning provider.
 *
 * Models the "Lightning Nexus" catalogue and the multi-provider download
 * approach used by Project Lightning (https://github.com/LightnigFast/Project-Lightning):
 * a title is not tied to a single host - it carries links on several providers
 * (GoFile, Buzzheavier, MegaDB, Rootz, or a WebTorrent magnet) and the
 * launcher picks one and downloads it straight through the built-in engine,
 * bypassing Cloudflare 403 blocks entirely instead of handing the link to a
 * browser.
 *
 * This provider never scrapes a third-party page. It only resolves a target
 * that already names one or more provider URLs into a validated download item
 * the engine can fetch directly (pause/resume, multi-part, extraction).
 */

const mirrors = require('./mirrors');

const PROVIDERS = ['gofile', 'buzzheavier', 'megadb', 'rootz', 'webtorrent'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function normalizeUrl(u) {
  if (u == null) return null;
  let url = String(u).trim();
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^(https?:|magnet:|file:)/i.test(url)) return null;
  return url;
}

function collectUrls(target) {
  const out = [];
  if (!target || typeof target !== 'object') return out;

  if (target.url) out.push(target.url);
  if (target.mirrorUrl) out.push(target.mirrorUrl);
  if (target.mirror) out.push(target.mirror);
  if (target.directUrl) out.push(target.directUrl);
  if (target.downloadUrl) out.push(target.downloadUrl);
  if (Array.isArray(target.mirrors)) out.push(...target.mirrors);
  if (Array.isArray(target.links)) out.push(...target.links);

  if (target.urls && typeof target.urls === 'object') {
    for (const p of PROVIDERS) {
      if (target.urls[p]) out.push(target.urls[p]);
    }
    for (const v of Object.values(target.urls)) out.push(v);
  }
  if (target.providers && typeof target.providers === 'object') {
    for (const v of Object.values(target.providers)) out.push(v);
  }
  if (target.providerLinks && typeof target.providerLinks === 'object') {
    for (const v of Object.values(target.providerLinks)) out.push(v);
  }

  return [...new Set(out.map(normalizeUrl).filter(Boolean))];
}

function pickProviderName(url) {
  const s = String(url || '').toLowerCase();
  if (/^magnet:/i.test(s)) return 'webtorrent';
  try {
    const host = new URL(s).hostname.toLowerCase();
    if (host.includes('gofile')) return 'gofile';
    if (host.includes('buzzheavier') || host.includes('bzzhr')) return 'buzzheavier';
    if (host.includes('megadb')) return 'megadb';
    if (host.includes('rootz')) return 'rootz';
  } catch {
    /* fall through */
  }
  return 'direct';
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function search(term, opts = {}) {
  // Lightning Nexus is backed by the same multi-provider catalogue as the
  // legacy SteamRip surface, but downloads are resolved into direct provider
  // links and fetched by the built-in engine instead of a browser.
  try {
    const sr = require('./steamrip');
    if (typeof sr.search === 'function') {
      const res = await sr.search(term, opts || {});
      if (res && Array.isArray(res.items)) {
        return { ok: res.ok !== false, items: res.items.map((it) => ({ ...it, origin: 'lightning' })), query: term };
      }
    }
  } catch { /* fall through */ }
  const q = String(term || '').trim();
  return { ok: true, items: [], query: q };
}

async function details(id, opts = {}) {
  try {
    const sr = require('./steamrip');
    if (typeof sr.details === 'function') {
      const res = await sr.details(id, opts || {});
      if (res && res.ok !== false) return { ...res, origin: 'lightning' };
    }
  } catch { /* fall through */ }
  return { ok: false, error: 'Nexus details are resolved per-target.' };
}

async function deliver(target, ctx = {}) {
  const spec = target || {};
  // Prefer the legacy resolver's mirror extraction so existing titles keep
  // working, but tag the result as a Nexus item.
  try {
    const sr = require('./steamrip');
    if (typeof sr.deliver === 'function') {
      const res = await sr.deliver(spec, ctx || {});
      if (res && res.ok && res.item && res.item.url) {
        const item = { ...res.item, origin: 'lightning', trustedSource: 'lightning', checksumOptional: true, lightningProvider: res.item.lightningProvider || pickProviderName(res.item.url) };
        return { ok: true, item };
      }
    }
  } catch { /* fall through */ }

  const urls = collectUrls(spec);
  if (!urls.length) {
    return { ok: false, reason: 'This Nexus title has no download link.' };
  }

  // Resolve each provider page into a direct file (Project Lightning's
  // download manager does the same per provider) so the engine never fetches
  // a landing page.
  const settings = (ctx && ctx.settings) || {};
  const resolved = await mirrors.resolveAll(urls, { settings });
  if (!resolved.sources.length) {
    const detail = resolved.skipped.map((s) => `${mirrors.providerOf(s.url)}: ${s.reason}`).join('; ');
    return {
      ok: false,
      reason: `This Nexus title has no usable download link${detail ? ` (${detail})` : ''}.`
    };
  }

  const primary = resolved.sources[0];
  const isTorrent = primary.kind === 'torrent' || /^magnet:/i.test(primary.url);

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(primary.headers || {})
  };

  const size = primary.size || Number(spec.size || spec.sizeBytes || 0) || 0;

  return {
    ok: true,
    item: {
      id: String(spec.id || 'lightning:' + Buffer.from(primary.url).toString('base64url').slice(0, 12)),
      title: spec.title || spec.name || 'Nexus download',
      url: primary.url,
      headers,
      kind: isTorrent ? 'torrent' : 'http',
      sha256: spec.sha256 || null,
      checksumOptional: true,
      trustedSource: 'lightning',
      size,
      filename: spec.filename || primary.filename || null,
      extract: isTorrent ? false : spec.extract !== false,
      dest: spec.dest || spec.title || spec.name || 'Game',
      cover: spec.cover || null,
      developer: spec.developer || null,
      steamAppId: spec.steamAppId || null,
      logo: spec.logo || null,
      lightningProvider: primary.provider,
      lightningMirrors: resolved.sources,
      sources: resolved.sources,
      origin: 'lightning'
    }
  };
}

const provider = {
  id: 'lightning',
  label: 'Nexus',
  trust: 'user',
  metadataOnly: false,
  search,
  details,
  logos() {
    return [];
  },
  async deliver(target, ctx) {
    return deliver(target, ctx);
  }
};

module.exports = {
  ...provider,
  PROVIDERS,
  search,
  details,
  deliver,
  collectUrls,
  pickProviderName,
  hostOf,
  normalizeUrl
};
module.exports.provider = provider;
module.exports.default = provider;