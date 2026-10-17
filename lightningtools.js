'use strict';

/**
 * Project Lightning tools (main process)
 * ---------------------------------------------------------------------------
 * Ports three features of Project Lightning
 * (https://github.com/LightnigFast/Project-Lightning) into Apex:
 *
 *   1. Catalogues  - the Bypass list (bypass.json) and the OnlineFix list
 *                    (data-fix.json). A bundled copy ships in `data/`; the
 *                    user can refresh both from the project's GitHub.
 *   2. Fix apply   - copies a fix the user already has on disk (a source
 *                    folder) and/or a fix archive from a GitHub URL onto a
 *                    game's install folder, backing up every file it replaces.
 *   3. SteamLess    - finds the Steamworks DLLs (steam_api.dll / steam_api64.dll)
 *                    inside a game and swaps them for the user's own copies.
 *
 * Nothing here downloads copyrighted content by itself. Apex ships the two
 * catalogue documents (plain metadata) and the tooling; the actual fix files
 * come from a folder or URL the user supplies, exactly as with SteamLess.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');

const archives = require('./net/archives');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const RAW_BASE = 'https://raw.githubusercontent.com/LightnigFast/Project-Lightning/main';

/** The catalogue documents: bundled copy, userData cache and remote source. */
const CATALOGS = {
  bypass: {
    file: 'bypass.json',
    remote: `${RAW_BASE}/bypass.json`,
    label: 'Bypass'
  },
  onlinefix: {
    file: 'data-fix.json',
    remote: `${RAW_BASE}/data-fix.json`,
    label: 'OnlineFix'
  }
};

/**
 * Hosts a fix download URL is allowed to come from. Apex refuses anything
 * else, so a catalog entry can never smuggle an arbitrary host into a fetch.
 */
const FIX_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'githubusercontent.com'
];

const STEAM_DLLS = ['steam_api.dll', 'steam_api64.dll'];

const FETCH_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Module context
// ---------------------------------------------------------------------------
let ctx = { userDataDir: null, appDir: __dirname };
let log = () => {};

/** Parsed catalogues, kept in memory so a view repaint is instant. */
const memory = {
  bypass: null,
  onlinefix: null,
  fetchedAt: null,
  source: { bypass: null, onlinefix: null }
};

function init(opts = {}) {
  ctx = {
    userDataDir: opts.userDataDir || ctx.userDataDir || os.tmpdir(),
    appDir: opts.appDir || ctx.appDir || __dirname
  };
  log = typeof opts.log === 'function' ? opts.log : log;
  return api;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The Project Lightning catalogues are written by .NET with trailing commas,
 * which strict JSON.parse rejects. This parses them the same lenient way the
 * original does (AllowTrailingCommas), without letting a broken document slip
 * through: anything still unparseable comes back as null.
 */
function parseJsonLoose(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  try { return JSON.parse(s); } catch { /* try the lenient pass below */ }
  try { return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

function readJson(file) {
  try { return parseJsonLoose(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const cacheFile = (kind) => path.join(ctx.userDataDir, `apex-pl-${kind}.json`);
const bundledFile = (kind) => path.join(ctx.appDir, 'data', CATALOGS[kind].file);

/** First https string found in a value (a plain string or an object of them). */
function firstImage(value) {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (isObj(value)) {
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    }
  }
  return null;
}

async function withTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Streams a URL to a file on disk. Returns the byte count. */
async function fetchToFile(url, destFile, onProgress) {
  const res = await withTimeout(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: '*/*' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  if (res.body && typeof Readable.fromWeb === 'function') {
    const rs = Readable.fromWeb(res.body);
    const ws = fs.createWriteStream(destFile);
    rs.on('data', (b) => { received += b.length; if (onProgress) onProgress(received, total); });
    await new Promise((resolve, reject) => {
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    received = buf.length;
    await fs.promises.writeFile(destFile, buf);
    if (onProgress) onProgress(received, total);
  }

  if (!received && fs.existsSync(destFile)) received = fs.statSync(destFile).size;
  return received;
}

/** True when `host` equals, or is a subdomain of, any entry in FIX_HOSTS. */
function hostAllowed(rawUrl) {
  try {
    const h = new URL(String(rawUrl)).hostname.toLowerCase();
    return FIX_HOSTS.some((e) => h === e || h.endsWith(`.${e}`));
  } catch {
    return false;
  }
}

function sha256File(file) {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(file);
      rs.on('data', (b) => hash.update(b));
      rs.on('error', () => resolve(null));
      rs.on('end', () => resolve(hash.digest('hex')));
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------
/** Flattens bypass.json (publisher -> appId -> record) into a plain list. */
function normalizeBypass(raw) {
  const items = [];
  const publishers = new Set();
  if (!isObj(raw)) return { items, publishers: [] };

  for (const [publisher, apps] of Object.entries(raw)) {
    if (!isObj(apps)) continue;
    publishers.add(publisher);
    for (const [appId, rec] of Object.entries(apps)) {
      if (!isObj(rec)) continue;
      items.push({
        kind: 'bypass',
        appId: String(appId),
        publisher,
        name: String(rec.name || appId),
        fixName: rec.nombre_fix ? String(rec.nombre_fix) : `${rec.name || appId} - bypass`,
        launchSteam: !!rec.launch_steam,
        launchExe: !!rec.launch_exe,
        exclusion: !!rec.exclusion,
        comments: String(rec.comentarios || ''),
        required: Array.isArray(rec.programas_necesarios) ? rec.programas_necesarios.filter(Boolean) : [],
        errors: Array.isArray(rec.errores) ? rec.errores.filter(Boolean) : [],
        image: firstImage(rec.custom_images)
      });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId));
  return { items, publishers: [...publishers].sort() };
}

/** Flattens data-fix.json (appId -> record) into a plain list. */
function normalizeOnlinefix(raw) {
  const items = [];
  if (!isObj(raw)) return { items };
  for (const [appId, rec] of Object.entries(raw)) {
    if (!isObj(rec)) continue;
    items.push({
      kind: 'onlinefix',
      appId: String(appId),
      name: String(rec.name || appId),
      fixName: rec.nombre_fix ? String(rec.nombre_fix) : `${rec.name || appId} - fix`,
      image: firstImage(rec.custom_images)
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId));
  return { items };
}

function normalize(kind, raw) {
  return kind === 'onlinefix' ? normalizeOnlinefix(raw) : normalizeBypass(raw);
}

/**
 * Loads one catalogue. Order: memory, the refreshed copy in userData, then the
 * bundled document that ships with Apex.
 */
function load(kind, force = false) {
  if (!CATALOGS[kind]) throw new Error(`Unknown catalogue "${kind}"`);
  if (!force && memory[kind]) return memory[kind];

  let raw = null;
  let source = null;

  const cache = cacheFile(kind);
  if (fs.existsSync(cache)) {
    raw = readJson(cache);
    if (raw) source = 'cache';
  }
  if (!raw) {
    const bundled = bundledFile(kind);
    raw = readJson(bundled);
    if (raw) source = 'bundled';
  }
  if (!raw) raw = {};

  const normalized = normalize(kind, raw);
  memory[kind] = normalized;
  memory.source[kind] = source || 'empty';
  return normalized;
}

/** Both catalogues plus their provenance, for the Tools view header. */
function catalogs(opts = {}) {
  const bypass = load('bypass', !!opts.force);
  const onlinefix = load('onlinefix', !!opts.force);
  return {
    ok: true,
    fetchedAt: memory.fetchedAt,
    counts: { bypass: bypass.items.length, onlinefix: onlinefix.items.length },
    publishers: bypass.publishers,
    source: { ...memory.source }
  };
}

function bypassList(query = '') {
  const { items, publishers } = load('bypass');
  const q = String(query || '').trim().toLowerCase();
  const filtered = !q ? items : items.filter((it) => (
    `${it.name} ${it.appId} ${it.fixName} ${it.publisher}`.toLowerCase().includes(q)
  ));
  return { ok: true, items: filtered, publishers, total: items.length };
}

function onlinefixList(query = '') {
  const { items } = load('onlinefix');
  const q = String(query || '').trim().toLowerCase();
  const filtered = !q ? items : items.filter((it) => (
    `${it.name} ${it.appId} ${it.fixName}`.toLowerCase().includes(q)
  ));
  return { ok: true, items: filtered, total: items.length };
}

/** Re-downloads both catalogues from GitHub, validates them and caches them. */
async function refresh() {
  const results = [];
  let any = false;

  for (const [kind, meta] of Object.entries(CATALOGS)) {
    try {
      const res = await withTimeout(meta.remote, {
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'application/json,*/*' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const raw = parseJsonLoose(text);
      if (!isObj(raw)) throw new Error('document is not a JSON object');

      writeJson(cacheFile(kind), raw);
      memory[kind] = null;              // force a re-normalise from the fresh file
      const norm = load(kind, true);
      memory.source[kind] = 'github';

      results.push({ kind, label: meta.label, ok: true, count: norm.items.length });
      any = true;
      log('info', `${meta.label} catalogue refreshed (${norm.items.length} entries)`);
    } catch (err) {
      results.push({ kind, label: meta.label, ok: false, error: (err && err.message) || 'refresh failed' });
      log('warn', `${meta.label} catalogue refresh failed: ${(err && err.message) || err}`);
    }
  }

  if (any) memory.fetchedAt = Date.now();
  return {
    ok: results.some((r) => r.ok),
    fetchedAt: memory.fetchedAt,
    results,
    counts: {
      bypass: load('bypass').items.length,
      onlinefix: load('onlinefix').items.length
    }
  };
}

// ---------------------------------------------------------------------------
// Fix application
// ---------------------------------------------------------------------------
/**
 * Copies a directory tree onto a game folder, backing up anything it replaces.
 * Every path is kept inside `destDir`; a source that tries to escape is skipped.
 */
async function copyTree(srcDir, destDir, opts, acc) {
  const backupRoot = opts.backupRoot;
  const backup = opts.backup !== false;
  const depthLimit = opts.depthLimit || 12;

  const walk = async (rel, depth) => {
    if (depth > depthLimit) { acc.errors.push(`Skipped (too deep): ${rel || '.'}`); return; }
    let entries;
    try { entries = await fs.promises.readdir(path.join(srcDir, rel), { withFileTypes: true }); }
    catch (err) { acc.errors.push(`Cannot read ${rel || '.'}: ${err.message}`); return; }

    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const srcPath = path.join(srcDir, childRel);
      const destPath = path.join(destDir, childRel);

      // Never write outside the destination folder.
      const relCheck = path.relative(destDir, destPath);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        acc.errors.push(`Skipped (escapes destination): ${childRel}`);
        continue;
      }

      if (ent.isDirectory()) {
        try { await fs.promises.mkdir(destPath, { recursive: true }); }
        catch (err) { acc.errors.push(`Cannot create ${childRel}: ${err.message}`); continue; }
        await walk(childRel, depth + 1);
      } else if (ent.isFile()) {
        try {
          if (backup && backupRoot && fs.existsSync(destPath)) {
            const bPath = path.join(backupRoot, childRel);
            await fs.promises.mkdir(path.dirname(bPath), { recursive: true });
            await fs.promises.copyFile(destPath, bPath);
            acc.backedUp.push(childRel);
          }
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          await fs.promises.copyFile(srcPath, destPath);
          acc.applied.push(childRel);
        } catch (err) {
          acc.errors.push(`Cannot write ${childRel}: ${err.message}`);
        }
      }
    }
  };

  await walk('', 0);
}

/**
 * Applies a fix to a game folder.
 *
 * @param {object} payload
 * @param {string} payload.dest       the game's install folder (required)
 * @param {string} [payload.appId]    catalog id, used to name the backup folder
 * @param {string} [payload.name]     display name, for logs
 * @param {string} [payload.sourceDir] a local folder the user prepared
 * @param {string[]} [payload.urls]   GitHub URLs of fix archives/files
 * @param {boolean} [payload.extract] extract archives (default true)
 * @param {boolean} [payload.backup]  back up replaced files (default true)
 */
async function applyFix(payload = {}) {
  const dest = String(payload.dest || '').trim();
  if (!dest) return { ok: false, error: 'Choose the game folder first.' };
  if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
    return { ok: false, error: `The game folder does not exist: ${dest}` };
  }

  const sourceDir = String(payload.sourceDir || '').trim();
  const urls = Array.isArray(payload.urls)
    ? payload.urls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  if (!sourceDir && !urls.length) {
    return { ok: false, error: 'Choose a fix source folder, or paste at least one fix URL.' };
  }
  if (sourceDir && (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory())) {
    return { ok: false, error: `The fix source folder does not exist: ${sourceDir}` };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(
    ctx.userDataDir, 'apex-fix-backups',
    String(payload.appId || 'fix').replace(/[^\w.-]+/g, '_'), stamp
  );

  const acc = { applied: [], backedUp: [], errors: [], downloaded: [] };
  const tempRoot = path.join(os.tmpdir(), `apex-fix-${Date.now()}`);

  try {
    if (sourceDir) {
      log('info', `Applying fix from ${sourceDir} -> ${dest}`);
      await copyTree(sourceDir, dest, { backup: payload.backup !== false, backupRoot }, acc);
    }

    for (const url of urls) {
      if (!hostAllowed(url)) {
        acc.errors.push(`Refused (host not allowed): ${url}`);
        continue;
      }
      try {
        const base = path.basename(new URL(url).pathname) || `fix-${Date.now()}.bin`;
        const file = path.join(tempRoot, base);
        await fetchToFile(url, file);
        acc.downloaded.push(base);

        const format = payload.extract !== false ? archives.sniff(file) : null;
        if (format) {
          const stage = path.join(tempRoot, 'stage', base);
          fs.mkdirSync(stage, { recursive: true });
          await archives.extract(file, stage, {
            onLog: (level, msg) => log(level, msg),
            onProgress: () => {}
          });
          await copyTree(stage, dest, { backup: payload.backup !== false, backupRoot }, acc);
        } else {
          const target = path.join(dest, base);
          if (payload.backup !== false && fs.existsSync(target)) {
            const bPath = path.join(backupRoot, base);
            await fs.promises.mkdir(path.dirname(bPath), { recursive: true });
            await fs.promises.copyFile(target, bPath);
            acc.backedUp.push(base);
          }
          await fs.promises.copyFile(file, target);
          acc.applied.push(base);
        }
      } catch (err) {
        acc.errors.push(`${url}: ${(err && err.message) || err}`);
      }
    }
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const ok = acc.applied.length > 0;
  log(ok ? 'info' : 'warn',
    `Fix for ${payload.name || payload.appId || dest}: ${acc.applied.length} file(s) written, ${acc.backedUp.length} backed up`);

  return {
    ok,
    error: ok ? undefined : (acc.errors[0] || 'Nothing was written to the game folder.'),
    dest,
    backupDir: acc.backedUp.length ? backupRoot : null,
    applied: acc.applied,
    backedUp: acc.backedUp,
    downloaded: acc.downloaded,
    errors: acc.errors
  };
}

// ---------------------------------------------------------------------------
// SteamLess
// ---------------------------------------------------------------------------
const SKIP_DIR = /^(node_modules|\.git|redist|redistributable|directx|vcredist|support|logs?|saves?|__pycache__)$/i;

/** Walks a folder looking for the Steamworks DLLs, up to a bounded depth. */
async function steamlessScan(payload = {}) {
  const dir = String(payload.dir || '').trim();
  if (!dir) return { ok: false, error: 'Choose a game folder to scan.', items: [] };
  if (!fs.existsSync(dir)) return { ok: false, error: `Folder not found: ${dir}`, items: [] };

  const maxDepth = Math.min(Math.max(1, Number(payload.maxDepth) || 6), 10);
  const maxItems = Math.min(Math.max(1, Number(payload.maxItems) || 40), 200);

  const items = [];
  const queue = [{ dir, depth: 0 }];

  while (queue.length && items.length < maxItems) {
    const { dir: cur, depth } = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIR.test(ent.name)) queue.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile() && STEAM_DLLS.includes(ent.name.toLowerCase())) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        items.push({
          path: full,
          name: ent.name,
          dir: cur,
          relative: path.relative(dir, full),
          size,
          sha256: await sha256File(full)
        });
        if (items.length >= maxItems) break;
      }
    }
  }

  return { ok: true, root: dir, items };
}

/**
 * Swaps the Steamworks DLLs for the user's own copies.
 *
 * @param {object} payload
 * @param {string[]} payload.targets   absolute paths returned by steamlessScan
 * @param {string} payload.sourceDir   folder holding the replacement DLLs
 * @param {object} [payload.mapping]   optional { absoluteTargetPath: replacementFile }
 * @param {boolean} [payload.backup]   back up the originals (default true)
 */
async function steamlessReplace(payload = {}) {
  const targets = Array.isArray(payload.targets)
    ? payload.targets.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const sourceDir = String(payload.sourceDir || '').trim();
  const mapping = isObj(payload.mapping) ? payload.mapping : {};

  if (!targets.length) return { ok: false, error: 'Scan a game folder first.', replaced: [] };
  if (!sourceDir && !Object.keys(mapping).length) {
    return { ok: false, error: 'Choose a folder that holds your replacement DLLs.', replaced: [] };
  }
  if (sourceDir && (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory())) {
    return { ok: false, error: `The replacement folder does not exist: ${sourceDir}` };
  }

  // Index the replacement folder by lowercase basename.
  const index = new Map();
  if (sourceDir) {
    try {
      for (const ent of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
        if (ent.isFile()) index.set(ent.name.toLowerCase(), path.join(sourceDir, ent.name));
      }
    } catch (err) {
      return { ok: false, error: `Cannot read ${sourceDir}: ${err.message}`, replaced: [] };
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const replaced = [];
  const errors = [];

  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) { errors.push(`Missing: ${target}`); continue; }

      const explicit = mapping[target];
      const replacement = explicit
        ? String(explicit)
        : index.get(path.basename(target).toLowerCase());

      if (!replacement || !fs.existsSync(replacement)) {
        errors.push(`No replacement found for ${path.basename(target)}`);
        continue;
      }

      const backupDir = path.join(ctx.userDataDir, 'apex-steamless-backups', stamp);
      const backupPath = path.join(backupDir, path.basename(target));
      if (payload.backup !== false) {
        await fs.promises.mkdir(backupDir, { recursive: true });
        await fs.promises.copyFile(target, backupPath);
      }

      await fs.promises.copyFile(replacement, target);
      replaced.push({
        target,
        replacement,
        backup: payload.backup !== false ? backupPath : null,
        sha256: await sha256File(target)
      });
    } catch (err) {
      errors.push(`${path.basename(target)}: ${(err && err.message) || err}`);
    }
  }

  const ok = replaced.length > 0;
  log(ok ? 'info' : 'warn', `SteamLess: ${replaced.length} DLL(s) replaced, ${errors.length} error(s)`);
  return {
    ok,
    error: ok ? undefined : (errors[0] || 'No DLL was replaced.'),
    replaced,
    errors
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
const api = {
  init,
  catalogs,
  bypassList,
  onlinefixList,
  refresh,
  applyFix,
  steamlessScan,
  steamlessReplace
};

module.exports = api;
module.exports.init = init;
module.exports.FIX_HOSTS = FIX_HOSTS;
module.exports.STEAM_DLLS = STEAM_DLLS;
module.exports.hostAllowed = hostAllowed;
