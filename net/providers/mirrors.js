'use strict';

/**
 * Lightning Nexus mirror resolution.
 * ---------------------------------------------------------------------------
 * A SteamRip/Lightning page never links to a file directly: its "DOWNLOAD
 * HERE" buttons point at a *provider landing page* (Buzzheavier, GoFile,
 * FileDitch, Pixeldrain, ...). Feeding one of those to the transfer engine
 * downloads an HTML document, which then fails extraction - or answers the
 * ranged request with a bare 403.
 *
 * This is the piece Project Lightning's download manager adds: resolve the
 * landing page on each provider into a direct file URL (and carry the request
 * headers that provider needs) *before* the engine is involved.
 *
 * Cloudflare-fronted providers (Buzzheavier, FileDitch) cannot be resolved over
 * a plain socket at all, so they are flagged `needsBrowser` and handed to the
 * hidden-window resolver in net/providers/browser.js instead.
 *
 * It is deliberately small and dependency-free, and it never throws: an
 * unresolvable mirror is reported so the caller can fall through to the next
 * one instead of guessing.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 20000;

// GoFile's public website token (embedded in gofile.io's own client). The
// account token, when one is configured, is what actually authorises the call.
const GOFILE_WEBSITE_TOKEN = '4fd6sg89d7s6';

const ARCHIVE_RE = /\.(zip|rar|7z|z\d{2}|tar|gz|tgz|xz|bz2|iso|bin|img|exe|part\d*\.rar)(\?|#|$)/i;

const HOSTS = [
  { provider: 'buzzheavier', re: /(^|\.)(buzzheavier\.com|bzzhr\.to|bzzhr\.co)$/i, landing: true, cloudflare: true },
  { provider: 'gofile', re: /(^|\.)gofile\.io$/i, landing: true },
  { provider: 'pixeldrain', re: /(^|\.)pixeldrain\.com$/i, landing: true },
  { provider: 'fileditch', re: /fileditchfiles\.(st|me)$|(^|\.)fileditch\.com$/i, landing: false, cloudflare: true },
  { provider: 'datanodes', re: /(^|\.)datanodes\.to$/i, landing: true },
  { provider: 'mediafire', re: /(^|\.)mediafire\.com$/i, landing: true },
  { provider: 'mega', re: /(^|\.)mega\.nz$/i, landing: true },
  { provider: '1fichier', re: /(^|\.)(1fichier\.com|1fichier\.to)$/i, landing: true },
  { provider: 'workupload', re: /(^|\.)workupload\.com$/i, landing: true },
  { provider: 'sabercathost', re: /(^|\.)sabercathost\.com$/i, landing: true },
  { provider: 'rootz', re: /(^|\.)rootz\.(so|to)$/i, landing: true },
  { provider: 'megadb', re: /(^|\.)megadb\.(net|to)$/i, landing: true }
];

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when `url` already names a file rather than a provider page. */
function looksDirect(rawUrl) {
  const s = String(rawUrl || '');
  if (/^magnet:/i.test(s)) return true;
  try {
    const u = new URL(s);
    return ARCHIVE_RE.test(u.pathname) || ARCHIVE_RE.test(u.href);
  } catch {
    return false;
  }
}

function providerOf(rawUrl) {
  const s = String(rawUrl || '');
  if (/^magnet:/i.test(s)) return 'webtorrent';
  const host = hostOf(s);
  if (!host) return 'unknown';
  const hit = HOSTS.find((h) => h.re.test(host));
  return hit ? hit.provider : 'direct';
}

function metaFor(provider) {
  return HOSTS.find((h) => h.provider === provider) || null;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'follow', ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _status: res.status, _text: text.slice(0, 200) };
  }
}

// --- Buzzheavier -----------------------------------------------------------
// bzzhr.to/{id} and buzzheavier.com/{id} are Cloudflare-fronted *pages*; only a
// real browser can open them, and the page's own "Download File" button yields
// the signed CDN link. {id}.bzzhr.co entries are the CDN nodes and are already
// direct.
function buzzIdOf(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const cdn = u.hostname.match(/^([a-z0-9]+)\.bzzhr\.co$/i);
  if (cdn) return { cdn: true, id: cdn[1], url: rawUrl, host: u.hostname };
  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length) return null;
  const host = /bzzhr\.to$/i.test(u.hostname) ? 'buzzheavier.com' : u.hostname;
  return { cdn: false, id: segs[0], host };
}

function resolveBuzzheavier(rawUrl) {
  const info = buzzIdOf(rawUrl);
  if (!info) return null;
  if (info.cdn) {
    // {id}.bzzhr.co entries are already the CDN node; no page to resolve.
    return { url: rawUrl, provider: 'buzzheavier', direct: true, headers: { Referer: 'https://buzzheavier.com/' } };
  }
  // The landing page is Cloudflare-fronted: the engine only ever gets a 403
  // here, so hand it to the hidden browser, which presses "Download File" and
  // returns the signed CDN link the engine *can* fetch.
  const page = `https://${info.host}/${info.id}`;
  return {
    url: page,
    provider: 'buzzheavier',
    filename: null,
    needsBrowser: true,
    referrer: 'https://steamrip.com/'
  };
}

// --- Pixeldrain ------------------------------------------------------------
function pixeldrainId(rawUrl) {
  const m = String(rawUrl).match(/pixeldrain\.com\/(?:u|l)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function resolvePixeldrain(rawUrl) {
  const id = pixeldrainId(rawUrl);
  if (!id) return null;
  return { url: `https://pixeldrain.com/api/file/${id}`, provider: 'pixeldrain' };
}

// --- GoFile ----------------------------------------------------------------
function gofileId(rawUrl) {
  const m = String(rawUrl).match(/gofile\.io\/(?:d|\?c=|\?content=)?\/?([A-Za-z0-9_-]{6,})/i);
  return m ? m[1] : null;
}

async function gofileServer() {
  try {
    const j = await fetchJson('https://api.gofile.io/servers');
    const list = (j && j.data && j.data.servers) || [];
    const pick = list.find((s) => /store\d+$/.test(s.name)) || list[0];
    if (pick && pick.name) return pick.name;
  } catch { /* fall back below */ }
  return 'store1';
}

async function gofileAccount(ctx) {
  const settings = (ctx && ctx.settings) || {};
  const configured = String((settings.pl && settings.pl.gofileToken) || '').trim();
  if (configured) return { token: configured, source: 'settings' };
  try {
    const j = await fetchJson('https://api.gofile.io/accounts', { method: 'POST' });
    if (j && j.data && j.data.token) return { token: j.data.token, source: 'guest' };
  } catch { /* ignore */ }
  return null;
}

/** Flattens a GoFile contents tree into { name, size, link } file records. */
function gofileFiles(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'file' && node.link) {
    out.push({ name: node.name || '', size: Number(node.size) || 0, link: node.link, id: node.id || null });
  }
  const children = node.children || {};
  for (const child of Object.values(children)) gofileFiles(child, out);
  return out;
}

/** Largest archive wins; a lone file needs no guessing. */
function pickGofileFile(files) {
  if (!files.length) return null;
  if (files.length === 1) return files[0];
  const archives = files.filter((f) => ARCHIVE_RE.test(f.name));
  const pool = archives.length ? archives : files;
  return pool.slice().sort((a, b) => b.size - a.size)[0];
}

async function resolveGofile(rawUrl, ctx) {
  const id = gofileId(rawUrl);
  if (!id) return { ok: false, reason: 'GoFile link has no content id' };

  const account = await gofileAccount(ctx);
  if (!account) return { ok: false, reason: 'GoFile needs an account token (Settings → Project Lightning tools)' };

  const server = await gofileServer();
  const url = `https://${server}.gofile.io/contents/${id}?wt=${GOFILE_WEBSITE_TOKEN}`;
  let body;
  try {
    body = await fetchJson(url, {
      headers: { Authorization: `Bearer ${account.token}` }
    });
  } catch (err) {
    return { ok: false, reason: `GoFile request failed: ${err.message}` };
  }

  if (!body || body.status !== 'ok') {
    const status = (body && (body.status || body._status)) || 'no response';
    if (status === 'error-notPremium') {
      return { ok: false, reason: 'GoFile refused the API call (guest accounts are no longer allowed); add a GoFile token in Settings' };
    }
    return { ok: false, reason: `GoFile returned "${status}"` };
  }

  const files = gofileFiles(body.data);
  const file = pickGofileFile(files);
  if (!file) return { ok: false, reason: 'GoFile folder is empty' };

  return {
    ok: true,
    url: file.link,
    provider: 'gofile',
    filename: file.name || null,
    size: file.size || 0,
    fileCount: files.length,
    resolvedFile: true,
    headers: { Cookie: `accountToken=${account.token}`, Referer: 'https://gofile.io/' }
  };
}

// --- dispatch --------------------------------------------------------------
/**
 * Resolves one mirror URL into something the engine can fetch.
 *
 * @returns {{ok:true, url, provider, headers?, filename?, size?, kind?}
 *          | {ok:false, reason}}
 */
async function resolve(rawUrl, ctx = {}) {
  const url = String(rawUrl || '').trim();
  if (!url) return { ok: false, reason: 'empty mirror url' };

  if (/^magnet:/i.test(url)) {
    return { ok: true, url, provider: 'webtorrent', kind: 'torrent' };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, reason: `unsupported mirror scheme: ${url.slice(0, 24)}` };
  }

  const provider = providerOf(url);

  try {
    if (provider === 'buzzheavier') {
      const r = resolveBuzzheavier(url);
      if (r) return { ok: true, ...r, kind: 'http' };
      return { ok: false, reason: 'Buzzheavier link had no file id' };
    }
    if (provider === 'pixeldrain') {
      const r = resolvePixeldrain(url);
      if (r) return { ok: true, ...r, kind: 'http', resolvedFile: true };
      return { ok: false, reason: 'Pixeldrain link had no file id' };
    }
    if (provider === 'gofile') {
      return await resolveGofile(url, ctx);
    }
  } catch (err) {
    return { ok: false, reason: `${provider} resolution failed: ${err.message}` };
  }

  // FileDitch (and any unknown host) may already serve the file: hand it over
  // as-is and let the caller's HTML guard reject a page that slipped through.
  // Cloudflare-fronted hosts are flagged so the coordinator can go straight to
  // the hidden browser instead of burning a request on a guaranteed 403.
  const meta = metaFor(provider);
  const cloudflare = !!(meta && meta.cloudflare);
  return {
    ok: true,
    url,
    provider,
    headers: cloudflare ? { Referer: 'https://steamrip.com/' } : undefined,
    referrer: cloudflare ? 'https://steamrip.com/' : undefined,
    kind: 'http',
    needsBrowser: cloudflare,
    direct: looksDirect(url)
  };
}

/**
 * Resolves a whole mirror list, best-first.
 *
 * Provider pages that cannot be resolved are dropped rather than handed to the
 * engine (downloading them only produces HTML); direct-looking URLs and
 * unknown hosts are kept as later candidates.
 *
 * @returns {{sources:object[], skipped:{url:string,reason:string}[]}}
 */
async function resolveAll(mirrors, ctx = {}) {
  const urls = [...new Set((mirrors || []).map((m) => String(m || '').trim()).filter(Boolean))];
  const sources = [];
  const skipped = [];
  const seen = new Set();

  for (const url of urls) {
    const res = await resolve(url, ctx);
    if (!res.ok) {
      skipped.push({ url, reason: res.reason });
      continue;
    }
    const key = `${res.kind || 'http'}:${res.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      url: res.url,
      provider: res.provider,
      kind: res.kind || 'http',
      headers: res.headers || null,
      referrer: res.referrer || null,
      // Cloudflare-fronted mirrors can only be resolved by the hidden browser.
      needsBrowser: !!res.needsBrowser,
      // A provider API already turned the landing page into a real file link.
      resolvedFile: !!res.resolvedFile,
      filename: res.filename || null,
      size: Number(res.size) || 0,
      // Whether the *original* mirror was already a file, as opposed to a
      // provider page we had to resolve. Ranking uses this, because a resolved
      // URL also ends up looking direct.
      direct: looksDirect(url)
    });
  }

  // Ordering, cheapest-and-most-reliable first:
  //   0  a provider API already named the file (GoFile, Pixeldrain)
  //   1  a plainly direct file the engine can just fetch
  //   2  a provider landing page whose own Download button can be pressed
  //   3  an unknown host, handed over as-is
  //   4  a file behind a Cloudflare interstitial (FileDitch): its page never
  //      offers a control to press, so it can only ever be a last resort
  //   5  a torrent
  const rank = (s) => {
    if (s.kind === 'torrent') return 5;
    if (s.resolvedFile) return 0;
    if (s.needsBrowser) return s.direct ? 4 : 2;
    return s.direct ? 1 : 3;
  };
  sources.sort((a, b) => rank(a) - rank(b));
  return { sources, skipped };
}

module.exports = {
  UA,
  GOFILE_WEBSITE_TOKEN,
  ARCHIVE_RE,
  hostOf,
  providerOf,
  looksDirect,
  resolve,
  resolveAll,
  resolveBuzzheavier,
  resolvePixeldrain,
  resolveGofile,
  gofileFiles,
  pickGofileFile,
  buzzIdOf
};
