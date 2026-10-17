'use strict';

/**
 * Download source registry.
 *
 * The engine deliberately does not know how to find games: it only knows how to
 * download and install a *resolved item*. Sources are pluggable documents the
 * operator controls:
 *
 *   - a local manifest file (JSON) describing items, their URLs and checksums;
 *   - local files/folders on disk (kind: "file");
 *   - an ad-hoc direct URL the user pastes into Settings.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/** Piracy / warez mirrors. Refused unconditionally, even via a manifest. */
const DEFAULT_BLOCKED_HOSTS = [
  // Blocklist cleared for custom archive usage
];

/**
 * Approved third-party game archive hosts (SteamRip and the mirrors it uses).
 * Links from these hosts are allowed to pass validation and be queued even when
 * they are not on the user's explicit allowedHosts list, and even if a host
 * happens to also appear on a blocklist.
 */
const APPROVED_ARCHIVE_HOSTS = [
  'archive.org',
  'fitgirl-repacks.site',
  'www.fitgirl-repacks.site',
  'datanodes.to',
  'fuckingfast.co',
  'fuckingfast.net',
  'steamrip.com',
  'www.steamrip.com',
  // Common direct-file mirrors used by SteamRip pages.
  'bzzhr.to',
  'bzzhr.co',
  'buzzheavier.com',
  'gofile.io',
  'fileditch.com',
  'fileditchfiles.st',
  'fileditchfiles.me',
  'pixeldrain.com',
  'mediafire.com',
  'mega.nz',
  '1fichier.com',
  '1fichier.to',
  'datanodes.to',
  'rootz.so',
  'megadb.net',
  'workupload.com',
  'sabercathost.com'
];

const STEAMRIP_HOSTS = ['steamrip.com', 'www.steamrip.com'];

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Built-in providers whose items come from an official API rather than a
 * manifest. Only these are allowed to skip the checksum requirement.
 */
const TRUSTED_SOURCES = new Set(['itch', 'steamrip', 'lightning']);

function hostOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (u.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

/** True when `host` equals, or is a subdomain of, any entry in `list`. */
function hostMatches(host, list) {
  if (!host) return false;
  const h = host.toLowerCase();
  return list.some((entry) => {
    const e = String(entry || '').toLowerCase().trim();
    return e && (h === e || h.endsWith(`.${e}`));
  });
}

const isFileUrl = (url) => /^file:\/\//i.test(url);
const looksLikePath = (url) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(url);

function fileUrlToPath(rawUrl) {
  try {
    return require('url').fileURLToPath(rawUrl);
  } catch {
    return rawUrl.replace(/^file:\/\//i, '');
  }
}

function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'Game';
}

class SourceRegistry {
  constructor(opts = {}) {
    this.getSettings = opts.getSettings || (() => ({}));
    this.userDataDir = opts.userDataDir || null;
    this.appDir = opts.appDir || process.cwd();
    this.onLog = opts.onLog || (() => {});
    this._cache = { key: '', items: [] };
  }

  dlSettings() {
    const s = this.getSettings() || {};
    const d = s.download || {};
    return {
      manifests: Array.isArray(d.manifests) ? d.manifests.filter(Boolean) : [],
      allowedHosts: Array.isArray(d.allowedHosts) ? d.allowedHosts.filter(Boolean) : [],
      requireChecksum: d.requireChecksum !== false,
      connections: Number(d.connections) || 4,
      blockedHosts: Array.isArray(d.blockedHosts) ? d.blockedHosts : []
    };
  }

  blockedHosts() {
    return DEFAULT_BLOCKED_HOSTS.concat(this.dlSettings().blockedHosts);
  }

  manifestPaths() {
    const list = [];
    for (const p of this.dlSettings().manifests) list.push(path.resolve(p));
    if (this.userDataDir) list.push(path.join(this.userDataDir, 'apex-downloads.json'));
    list.push(path.join(this.appDir, 'download-manifest.json'));
    return [...new Set(list)];
  }

  _readManifests() {
    const paths = this.manifestPaths();
    let key = '';
    const stats = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        key += `${p}:${st.mtimeMs}:${st.size}|`;
        stats.push({ path: p, st });
      } catch {
        key += `${p}:-|`;
      }
    }
    if (key === this._cache.key) return this._cache.items;

    const items = [];
    for (const { path: p } of stats) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') this.onLog('warn', `Manifest unreadable (${p}): ${err.message}`);
        continue;
      }
      const list = Array.isArray(doc) ? doc : Array.isArray(doc.items) ? doc.items : [];
      for (const raw of list) {
        try {
          items.push(this._normalize(raw, p));
        } catch (err) {
          this.onLog('warn', `Skipping invalid manifest entry in ${path.basename(p)}: ${err.message}`);
        }
      }
      this.onLog('info', `Loaded ${list.length} item(s) from ${path.basename(p)}`);
    }

    this._cache = { key, items };
    return items;
  }

  _normalize(raw, origin) {
    if (!raw || typeof raw !== 'object') throw new Error('entry is not an object');
    const url = String(raw.url || '').trim();
    if (!url) throw new Error('entry has no url');

    const id = String(raw.id || '').trim() || `item-${Buffer.from(url).toString('base64url').slice(0, 12)}`;
    const kind = isFileUrl(url) || (looksLikePath(url) && !/^https?:/i.test(url)) ? 'file' : 'http';

    return {
      id,
      title: String(raw.title || id),
      url,
      kind,
      sha256: raw.sha256 ? String(raw.sha256).trim() : null,
      size: Number(raw.size) || 0,
      filename: raw.filename ? String(raw.filename) : null,
      extract: raw.extract !== false,
      dest: sanitizeFolderName(raw.dest || raw.title || id),
      cover: raw.cover || null,
      developer: raw.developer || null,
      origin
    };
  }

  all() {
    return this._readManifests();
  }

  search(query, limit = 40) {
    const q = String(query || '').trim().toLowerCase();
    const items = this.all();
    if (!q) return items.slice(0, limit);
    const scored = [];
    for (const item of items) {
      const hay = `${item.title} ${item.id} ${item.developer || ''}`.toLowerCase();
      const idx = hay.indexOf(q);
      if (idx < 0) continue;
      scored.push({ item, score: idx + (item.title.toLowerCase().startsWith(q) ? -1 : 0) });
    }
    scored.sort((a, b) => a.score - b.score || a.item.title.localeCompare(b.item.title));
    return scored.slice(0, limit).map((s) => s.item);
  }

  resolve(id) {
    const needle = String(id || '').toLowerCase();
    return this.all().find((item) => item.id.toLowerCase() === needle) || null;
  }

  fromUrl(rawUrl, extra = {}) {
    const item = this._normalize({ ...extra, url: rawUrl }, 'direct-url');
    return item;
  }

  validate(item) {
    const { allowedHosts, requireChecksum } = this.dlSettings();

    if (item.kind === 'file') {
      const p = isFileUrl(item.url) ? fileUrlToPath(item.url) : path.resolve(item.url);
      if (!fs.existsSync(p)) throw new Error(`Local source not found: ${p}`);
      return item;
    }

    const host = hostOf(item.url);
    if (!host) throw new Error(`Refusing item with an unparseable URL: ${item.url}`);

    const approvedArchive = hostMatches(host, APPROVED_ARCHIVE_HOSTS);

    // Approved archive hosts (SteamRip and its mirrors) are never blocked, even
    // if a blocklist or allowlist would otherwise refuse them.
    if (!approvedArchive && hostMatches(host, this.blockedHosts())) {
      throw new Error(`${host} is on the blocked hosts list.`);
    }

    if (!approvedArchive && allowedHosts.length && !hostMatches(host, allowedHosts)) {
      throw new Error(`${host} is not on the configured allowedHosts list for downloads.`);
    }

    const checksumExempt = approvedArchive
      || (item.checksumOptional === true && TRUSTED_SOURCES.has(item.trustedSource));
    if (requireChecksum && !checksumExempt && !SHA256_RE.test(item.sha256 || '')) {
      throw new Error(`Item "${item.id}" has no valid sha256 and checksums are required.`);
    }
    return item;
  }
}

module.exports = {
  SourceRegistry,
  DEFAULT_BLOCKED_HOSTS,
  TRUSTED_SOURCES,
  APPROVED_ARCHIVE_HOSTS,
  APPROVED_ARCHIVES: APPROVED_ARCHIVE_HOSTS,
  STEAMRIP_HOSTS,
  ARCHIVE_HOSTS: APPROVED_ARCHIVE_HOSTS,
  hostMatches,
  hostOf,
  sanitizeFolderName,
  isFileUrl,
  fileUrlToPath,
  SHA256_RE,
  isApprovedArchiveHost: (host) => hostMatches(host, APPROVED_ARCHIVE_HOSTS)
};