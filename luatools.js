'use strict';

/**
 * Lua tools - the read side of SteamTools' per-user folders.
 *
 * SteamTools (and the LuaTools generator that feeds it) works from
 * `<steam>/userdata/<id>/config/stplug-in`, where `.lua` scripts declare the app
 * ids and depots a game needs, and `depotcache` holds the matching manifests.
 *
 * Apex reads that folder and nothing else:
 *   - scan()     lists the Steam users, the plugin files, the app ids, the depot
 *                pins and whether each pinned manifest is actually cached;
 *   - inspect()  parses one dropped .lua / .acf file and says what it targets;
 *   - remove()   / clear() delete files the user put there - an uninstall, not an
 *                install - after copying them into Apex's own backup folder;
 *   - backups()  / restore() put one of those copies back.
 *
 * Neither writes a .lua, a manifest or anything else into Steam.
 *
 * The path checks exist because a renderer should never be able to name an
 * arbitrary file: every target has to sit inside a plugin folder that scan()
 * itself found, and a restore only ever lands in one of those too.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const detect = require('./detect');
const drives = require('./drives');
const extractZip = require('extract-zip');

const MAX_FILE = 512 * 1024;
const BACKUP_KEEP = 40;
// LuaTools' public manifest backend: where pruned / missing pinned manifests
// come from (their client hits the same endpoint).
const MANIFEST_BACKEND = 'http://167.235.229.108';
const MANIFEST_UA = 'secretgoonpoon';

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Every Steam install's plugin folder, root-relative - the location LuaTools
 * and OpenSteamTool actually read (`<steam>/config/stplug-in`), plus the legacy
 * per-user SteamTools folders so nothing already applied gets lost. The first
 * entry per root is where Apex WRITES; the rest are read-only legacy rows. */
async function users() {
  const roots = (await detect.findSteamRoots().catch(() => []))
    .filter((r, i, all) => all.findIndex((x) => String(x).toLowerCase() === String(r).toLowerCase()) === i);
  const out = [];
  for (const root of roots) {
    const config = path.join(root, 'config');
    const plugins = path.join(config, 'stplug-in');
    const depotcache = path.join(root, 'depotcache');
    // Root row - where LuaTools and OST look, and where Apex writes.
    out.push({
      steam: root,
      id: 'default',
      home: root,
      config,
      plugins,
      depotcache,
      primary: true
    });

    // Legacy per-user rows (older SteamTools wrote here). Kept so scan() still
    // lists files that live there and remove()/restore() can still reach them.
    const userdata = path.join(root, 'userdata');
    let ids = [];
    try {
      ids = fs.readdirSync(userdata, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { ids = []; }

    for (const id of ids) {
      const home = path.join(userdata, id);
      const uconfig = path.join(home, 'config');
      if (!isDir(uconfig)) continue;
      out.push({
        steam: root,
        id,
        home,
        config: uconfig,
        plugins: path.join(uconfig, 'stplug-in'),
        depotcache: path.join(uconfig, 'depotcache'),
        legacy: true
      });
    }
  }
  return out;
}

/**
 * App ids, depots and manifest pins out of a SteamTools .lua script.
 *
 * A script looks roughly like:
 *   addappid(4954910)                       <- the game
 *   addappid(4954911, 1, "depot key")       <- a depot
 *   setManifestid(4954911, "1836...", 0)    <- the manifest that depot pins
 * so anything named by setManifestid is a depot, not a game.
 */
function parseLua(text) {
  const apps = [];
  const depots = [];
  const pins = [];
  const push = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

  const addRe = /addappid\s*\(\s*(\d+)/g;
  let m;
  while ((m = addRe.exec(text))) push(apps, m[1]);

  const manifestRe = /setManifestid\s*\(\s*(\d+)\s*,\s*"?(\d+)/g;
  while ((m = manifestRe.exec(text))) {
    push(depots, m[1]);
    if (!pins.some((p) => p.depot === m[1])) pins.push({ depot: m[1], manifest: m[2] });
  }

  const games = apps.filter((id) => !depots.includes(id));
  const finalApps = games.length ? games : (pins.length ? [] : apps);

  return {
    kind: 'lua',
    apps: finalApps,
    appids: finalApps,
    depots,
    pins,
    manifests: pins.map((p) => p.manifest)
  };
}

/** Key/value pairs out of a Valve .acf / appmanifest. */
function parseAcf(text) {
  const out = {};
  const re = /"([^"]+)"\s+"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

async function readText(file) {
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw new Error('That is not a file');
  if (st.size > MAX_FILE) throw new Error('That file is larger than 512 KB');
  return await fs.promises.readFile(file, 'utf8');
}

/** Finds the depotcache that belongs to the config folder this file lives in. */
function cacheDirFor(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'depotcache');
    if (isDir(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when `<depot>_<manifest>.manifest` is sitting in the cache. */
function manifestCached(cacheDir, pin) {
  if (!cacheDir || !pin || !pin.depot || !pin.manifest) return null;
  try {
    return fs.readdirSync(cacheDir).some((n) => n.startsWith(`${pin.depot}_`) && n.includes(pin.manifest));
  } catch { return null; }
}

/** Reads one .lua / .acf / .manifest and reports what it targets. */
async function inspect(file) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'No file given' };
  const ext = path.extname(file).toLowerCase();
  if (ext === '.zip') {
    const tmp = path.join(os.tmpdir(), `apex-inspect-${Date.now()}`);
    try { await fs.promises.mkdir(tmp, { recursive: true }); } catch { /* ignore */ }
    try { await extractZip(file, { dir: tmp }); }
    catch (e) {
      try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, file, name: path.basename(file), error: `Could not open that archive: ${e.message}` };
    }
    const found = [];
    (function walk(dir) {
      let rows = [];
      try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { rows = []; }
      for (const r of rows) {
        const full = path.join(dir, r.name);
        if (r.isDirectory()) walk(full);
        else if (/\.(lua|acf|manifest|txt)$/i.test(r.name)) found.push(full);
      }
    })(tmp);

    const appids = [];
    const depots = [];
    const pins = [];
    for (const f of found) {
      try {
        const parsed = await inspect(f);
        if (parsed && parsed.ok) {
          for (const id of (parsed.appids || parsed.apps || [])) if (!appids.includes(String(id))) appids.push(String(id));
          for (const d of (parsed.depots || [])) if (!depots.includes(d)) depots.push(d);
        }
      } catch { /* ignore */ }
    }
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return {
      ok: true,
      file,
      name: path.basename(file),
      size: (function(){try{return fs.statSync(file).size;}catch{return 0;}})(),
      kind: 'zip',
      apps: appids,
      appids,
      depots,
      pins,
      manifests: []
    };
  }
  const text = await readText(file);
  const base = { ok: true, file, name: path.basename(file), size: Buffer.byteLength(text) };

  if (ext === '.acf' || ext === '.manifest' || ext === '.txt') {
    const acf = parseAcf(text);
    return {
      ...base,
      kind: 'manifest',
      apps: acf.appid ? [acf.appid] : [],
      appids: acf.appid ? [acf.appid] : [],
      depots: [],
      pins: [],
      manifests: [],
      title: acf.name || null,
      installdir: acf.installdir || null,
      sizeOnDisk: acf.SizeOnDisk || null,
      state: acf.StateFlags || null
    };
  }

  const parsed = parseLua(text);
  const cache = cacheDirFor(file);
  const pins = parsed.pins.map((p) => ({ ...p, cached: manifestCached(cache, p) }));

  return { ...base, ...parsed, pins, depotcache: cache, ext };
}

/**
 * LuaTools (2026-09+) reads `config/stplug-in` and `depotcache` relative to the
 * Steam ROOT. Older SteamTools - and older Apex builds - used the per-user
 * folders. Anything still sitting there is invisible to Steam, so copy it up:
 * non-destructive (a file the root already has is left alone), report what moved.
 */
async function migrateLegacy() {
  const roots = (await detect.findSteamRoots().catch(() => []))
    .filter((r, i, all) => all.findIndex((x) => String(x).toLowerCase() === String(r).toLowerCase()) === i);
  const moved = [];
  for (const root of roots) {
    const rootPlugins = path.join(root, 'config', 'stplug-in');
    const rootCache = path.join(root, 'depotcache');
    const legacy = [];
    const userdata = path.join(root, 'userdata');
    let ids = [];
    try { ids = fs.readdirSync(userdata).filter((n) => /^\d+$/.test(n)); } catch { ids = []; }

    for (const id of ids) {
      const uconfig = path.join(userdata, id, 'config');
      for (const dir of [['stplug-in', rootPlugins], ['depotcache', rootCache]]) {
        const src = path.join(uconfig, dir[0]);
        if (!isDir(src)) continue;
        legacy.push({ from: src, to: dir[1] });
      }
    }
    // Old SteamTools also stashed manifests in the root config\depotcache,
    // where Steam never looked (see LuaTools' DepotCacheMigrationService).
    if (isDir(path.join(root, 'config', 'depotcache'))) {
      legacy.push({ from: path.join(root, 'config', 'depotcache'), to: rootCache });
    }

    for (const { from, to } of legacy) {
      let rows = [];
      try { rows = fs.readdirSync(from, { withFileTypes: true }); } catch { continue; }
      for (const row of rows) {
        if (!row.isFile()) continue;
        if (!/\.(lua|acf|manifest|txt)$/i.test(row.name)) continue;
        try { fs.mkdirSync(to, { recursive: true }); } catch { continue; }
        const dest = path.join(to, row.name);
        if (fs.existsSync(dest)) continue; // the root copy wins
        try {
          await fs.promises.copyFile(path.join(from, row.name), dest);
          moved.push({ from: path.join(from, row.name), to: dest });
        } catch { /* skip what could not be read */ }
      }
    }
  }
  return moved;
}

async function scan() {
  // Lift anything left in the legacy folders before reading, so the shelf and
  // the pin checks reflect the folder OST actually reads.
  await migrateLegacy().catch(() => []);

  const list = await users();
  const steam = [];
  for (const u of list) {
    let plugins = [];
    if (isDir(u.plugins)) {
      plugins = await fs.promises.readdir(u.plugins, { withFileTypes: true })
        .then((rows) => rows.filter((r) => r.isFile()).map((r) => r.name))
        .catch(() => []);
    }

    let depotCount = 0;
    if (isDir(u.depotcache)) {
      depotCount = await fs.promises.readdir(u.depotcache).then((r) => r.length).catch(() => 0);
    }

    // Loaders such as SteamTools drop a DLL in the user folder itself.
    const loaders = await fs.promises.readdir(u.home).then((rows) => rows
      .filter((n) => /\.dll$/i.test(n))
      .filter((n) => /steam|lua|tools/i.test(n))).catch(() => []);

    const files = [];
    for (const name of plugins.slice(0, 200)) {
      const full = path.join(u.plugins, name);
      let size = 0;
      let at = 0;
      let parsed = { apps: [], appids: [], depots: [], pins: [] };
      try {
        const st = await fs.promises.stat(full);
        size = st.size;
        at = st.mtimeMs;
        if (/\.lua$/i.test(name) && size <= MAX_FILE) {
          parsed = parseLua(await fs.promises.readFile(full, 'utf8'));
        } else if (/\.acf$/i.test(name) && size <= MAX_FILE) {
          const acf = parseAcf(await fs.promises.readFile(full, 'utf8'));
          const ids = acf.appid ? [acf.appid] : [];
          parsed = { apps: ids, appids: ids, depots: [], pins: [] };
        }
      } catch { /* gone between readdir and stat */ }

      const pins = parsed.pins.map((p) => ({ ...p, cached: manifestCached(u.depotcache, p) }));
      files.push({
        name,
        size,
        at,
        lua: /\.lua$/i.test(name),
        appids: parsed.apps,
        depots: parsed.depots,
        pins
      });
    }

    steam.push({
      steam: u.steam,
      id: u.id,
      plugins: u.plugins,
      hasPlugins: isDir(u.plugins),
      primary: !!u.primary,
      legacy: !!u.legacy,
      depotcache: u.depotcache,
      depotCount,
      loaders,
      files
    });
  }

  // A file that already lives in the root plugin folder is covered there -
  // don't list its legacy twin on the shelf twice.
  const primaryNames = new Set(steam.filter((u) => u.primary)
    .flatMap((u) => (u.files || []).map((f) => String(f.name))));
  for (const u of steam) {
    if (u.primary) continue;
    u.files = (u.files || []).filter((f) => !primaryNames.has(String(f.name)));
  }

  // While Steam is closed, fetch any pinned manifest it pruned. Its depotcache
  // housekeeping only runs while it boots with no unlock for the pin - doing
  // this while Steam runs is a race the client always loses.
  try {
    if (!(await drives.steamRunning())) {
      const missing = steam.filter((u) => u.primary)
        .flatMap((u) => (u.files || []).flatMap((f) => (f.pins || []).filter((p) => !p.cached)
          .map((p) => ({ depot: p.depot, manifest: p.manifest, cache: u.depotcache }))));
      for (const m of missing) {
        try {
          const res = await fetch(`${MANIFEST_BACKEND}/api/givemethemanifestpunk/${m.depot}/${m.manifest}`,
            { headers: { 'User-Agent': MANIFEST_UA } });
          if (res.ok) {
            await fs.promises.writeFile(path.join(m.cache, `${m.depot}_${m.manifest}.manifest`),
              Buffer.from(await res.arrayBuffer()));
          }
        } catch { /* offline or backend down - the Repair button retries */ }
      }
      // Re-mark pins now that missing manifests may have landed.
      for (const u of steam.filter((x) => x.primary)) {
        for (const f of (u.files || [])) {
          for (const p of (f.pins || [])) p.cached = manifestCached(u.depotcache, p);
        }
      }
    }
  } catch { /* best effort */ }

  return { ok: true, steam };
}

/** True when `file` really sits inside `dir` (no `..` escapes). */
function inside(dir, file) {
  const d = path.resolve(dir);
  const f = path.resolve(file);
  return f.startsWith(d + path.sep);
}

async function knownPluginDirs() {
  const list = await users();
  return list.map((u) => u.plugins);
}

// ---------------------------------------------------------------------------
// backups - Apex's own copies, kept under its user data folder
// ---------------------------------------------------------------------------

function backupsRoot() {
  return path.join(require('electron').app.getPath('userData'), 'apex-lua-backups');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** One folder per operation, so a clear-all can be undone in one step. */
async function makeBackup(files, dir) {
  const root = backupsRoot();
  let folder = path.join(root, stamp());
  let n = 1;
  while (isDir(folder)) folder = path.join(root, `${stamp()}-${n++}`);
  await fs.promises.mkdir(folder, { recursive: true });

  const kept = [];
  for (const file of files) {
    try {
      await fs.promises.copyFile(file, path.join(folder, path.basename(file)));
      kept.push(path.basename(file));
    } catch { /* a locked file is not worth failing the whole operation */ }
  }
  await fs.promises.writeFile(
    path.join(folder, 'meta.json'),
    JSON.stringify({ dir, at: new Date().toISOString(), files: kept }, null, 2)
  );
  return path.basename(folder);
}

/** Newest first, with what each backup holds. */
async function backups() {
  const root = backupsRoot();
  let rows = [];
  try { rows = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return { ok: true, backups: [] }; }

  const out = [];
  for (const row of rows.filter((r) => r.isDirectory())) {
    const folder = path.join(root, row.name);
    let meta = {};
    try { meta = JSON.parse(await fs.promises.readFile(path.join(folder, 'meta.json'), 'utf8')); }
    catch { meta = {}; }
    let files = [];
    try { files = (await fs.promises.readdir(folder)).filter((n) => n !== 'meta.json'); }
    catch { files = []; }
    if (!files.length) continue;
    out.push({ id: row.name, at: Date.parse(meta.at) || 0, dir: meta.dir || '', files });
  }
  out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return { ok: true, backups: out.slice(0, BACKUP_KEEP) };
}

async function remove(file, dir) {
  const allowed = await knownPluginDirs();
  const target = path.resolve(file);
  const owner = allowed.find((d) => inside(d, target));
  if (!owner) return { ok: false, error: 'That file is not inside a Steam plugin folder' };
  if (dir && path.resolve(dir) !== path.resolve(owner)) {
    return { ok: false, error: 'That file is not inside the folder you named' };
  }

  const backup = await makeBackup([target], owner);
  await fs.promises.unlink(target);
  return { ok: true, backup };
}

/** Removes everything inside one plugin folder - the "delete all" cleanup. */
async function clear(dir) {
  const allowed = await knownPluginDirs();
  const target = path.resolve(dir || '');
  if (!allowed.some((d) => path.resolve(d) === target)) {
    return { ok: false, error: 'That is not a Steam plugin folder' };
  }

  const rows = await fs.promises.readdir(target, { withFileTypes: true });
  const files = rows.filter((r) => r.isFile()).map((r) => path.join(target, r.name));
  const backup = files.length ? await makeBackup(files, target) : '';

  let removed = 0;
  for (const row of rows) {
    const full = path.join(target, row.name);
    if (row.isDirectory()) {
      await fs.promises.rm(full, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(full).catch(() => {});
    }
    removed++;
  }
  return { ok: true, removed, backup };
}

/** Puts one backup back, and only into a plugin folder that still exists. */
async function restore(id) {
  const name = String(id || '');
  if (!name || path.basename(name) !== name) return { ok: false, error: 'Unknown backup' };

  const folder = path.join(backupsRoot(), name);
  if (!isDir(folder)) return { ok: false, error: 'That backup is gone' };

  let meta = null;
  try { meta = JSON.parse(await fs.promises.readFile(path.join(folder, 'meta.json'), 'utf8')); }
  catch { return { ok: false, error: 'That backup has no record of where it came from' }; }

  const allowed = await knownPluginDirs();
  const target = allowed.find((d) => path.resolve(d) === path.resolve(meta.dir || ''));
  if (!target) return { ok: false, error: 'Steam\'s plugin folder is not there any more' };

  let files = [];
  try { files = (await fs.promises.readdir(folder)).filter((n) => n !== 'meta.json'); }
  catch { files = []; }

  const restored = [];
  for (const f of files) {
    try {
      await fs.promises.copyFile(path.join(folder, f), path.join(target, f));
      restored.push(f);
    } catch { /* skip what cannot be written */ }
  }
  return { ok: restored.length > 0, restored, dir: target, error: restored.length ? undefined : 'Nothing could be restored' };
}

// ---------------------------------------------------------------------------
// appInfo - detection of the LuaTools desktop client (optional companion).
// ---------------------------------------------------------------------------
function findLuaToolsExe() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env['ProgramFiles'] || 'C:\\\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\\\Program Files (x86)';
  const specific = [
    path.join(local, 'LuaTools', 'LuaTools.exe'),
    path.join(local, 'Programs', 'LuaTools', 'LuaTools.exe'),
    path.join(local, 'LuaTools', 'LuaToolsGui.exe'),
    path.join(pf, 'LuaTools', 'LuaTools.exe'),
    path.join(pf86, 'LuaTools', 'LuaTools.exe')
  ];
  for (const c of specific) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  const roots = [local, pf, pf86].filter(Boolean);
  const names = new Set(['luatools.exe', 'luatoolsgui.exe', 'lua-tools.exe']);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      if (depth > 3) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && names.has(String(e.name).toLowerCase())) {
          return path.join(dir, e.name);
        }
        if (e.isDirectory() && depth < 3) {
          const low = String(e.name).toLowerCase();
          if (low.includes('lua') || low === 'programs' || low === 'apps' || depth === 0) {
            queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
          }
        }
      }
    }
  }
  return null;
}

async function appInfo() {
  const exe = findLuaToolsExe();
  const installed = !!exe;
  return {
    ok: true,
    installed,
    exe: exe || null,
    version: installed ? 'installed' : null,
    app: {
      name: 'LuaTools',
      tagline: 'AppID Manager for ST',
      setup: 'https://github.com/madoiscool/LuaTools/releases/latest/download/LuaTools-win-Setup.exe',
      portable: 'https://github.com/madoiscool/LuaTools/releases/latest/download/LuaTools-win-Portable.zip',
      release: 'https://github.com/madoiscool/LuaTools/releases',
      website: 'https://lua.tools'
    }
  };
}

// ---------------------------------------------------------------------------
// apply - write side: put a game into Steam's library like LuaTools does.
// Accepts a string/number (appid or file path) or an options object.
// ---------------------------------------------------------------------------
async function resolveTarget(opts) {
  const list = await users().catch(() => []);
  const o = opts || {};
  if (o.dir) {
    const found = list.find((u) => path.resolve(u.plugins) === path.resolve(o.dir));
    if (found) return found;
    const bySteam = list.find((u) => path.resolve(u.steam) === path.resolve(o.dir));
    if (bySteam) return bySteam;
  }
  if (o.steam) {
    const bySteam = list.find((u) => path.resolve(u.steam) === path.resolve(o.steam));
    if (bySteam) return bySteam;
  }
  if (o.user) {
    const byId = list.find((u) => String(u.id) === String(o.user));
    if (byId) return byId;
  }
  if (o.plugins) {
    const byPlugins = list.find((u) => path.resolve(u.plugins) === path.resolve(o.plugins));
    if (byPlugins) return byPlugins;
  }
  // The root stplug-in is where OpenSteamTool and LuaTools read - fallback.
  return list.find((u) => u.primary) || list.find((u) => u.hasPlugins) || list[0] || null;
}

async function applyLua(input, dir, library) {
  let opts = input;
  if (typeof input === 'string' || typeof input === 'number') {
    const s = String(input).trim();
    if (/^\d+$/.test(s)) opts = { appid: s };
    else if (fs.existsSync(s)) opts = { file: s };
    else opts = { dir: s };
  }
  opts = opts || {};
  if (dir != null && opts.dir == null) opts.dir = dir;
  if (library != null && opts.library == null) opts.library = library;

  const target = await resolveTarget(opts);
  if (!target) return { ok: false, error: 'No Steam user found on this PC' };

  try { await fs.promises.mkdir(target.plugins, { recursive: true }); } catch { /* ignore */ }
  try { await fs.promises.mkdir(target.depotcache, { recursive: true }); } catch { /* ignore */ }
  const appids = new Set();
  const written = [];

  // A dropped / imported file is copied into the plugin folder verbatim.
  if (opts.file) {
    const file = String(opts.file);
    if (!fs.existsSync(file)) return { ok: false, error: 'That file does not exist' };
    let st;
    try { st = await fs.promises.stat(file); } catch { st = null; }
    if (!st || !st.isFile()) return { ok: false, error: 'That is not a file' };

    const ext = path.extname(file).toLowerCase();
    if (ext === '.zip') {
      const tmp = path.join(os.tmpdir(), `apex-lua-${Date.now()}`);
      try { await fs.promises.mkdir(tmp, { recursive: true }); } catch { /* ignore */ }
      try { await extractZip(file, { dir: tmp }); }
      catch (e) {
        try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        return { ok: false, error: `Could not open that archive: ${e.message}` };
      }

      const found = [];
      (function walk(dir) {
        let rows = [];
        try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { rows = []; }
        for (const r of rows) {
          const full = path.join(dir, r.name);
          if (r.isDirectory()) walk(full);
          else if (/\.(lua|acf|manifest|txt)$/i.test(r.name)) found.push(full);
        }
      })(tmp);

      for (const f of found) {
        const name = path.basename(f);
        const destDir = /\.manifest$/i.test(name) ? target.depotcache : target.plugins;
        try { await fs.promises.mkdir(destDir, { recursive: true }); } catch { /* ignore */ }
        const dest = path.join(destDir, name);
        if (path.resolve(f) !== path.resolve(dest)) {
          await fs.promises.copyFile(f, dest);
        }
        written.push(dest);
        try {
          const parsed = await inspect(f);
          for (const id of (parsed.appids || parsed.apps || [])) appids.add(String(id));
        } catch { /* ignore parse errors */ }
      }

      try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      if (!found.length) {
        return { ok: false, error: 'That archive has no .lua or .acf files inside' };
      }
    } else {
      const name = path.basename(file);
      const destDir = /\.manifest$/i.test(name) ? target.depotcache : target.plugins;
      try { await fs.promises.mkdir(destDir, { recursive: true }); } catch { /* ignore */ }
      const dest = path.join(destDir, name);
      if (path.resolve(file) !== path.resolve(dest)) {
        await fs.promises.copyFile(file, dest);
      }
      written.push(dest);
      try {
        const parsed = await inspect(file);
        for (const id of (parsed.appids || parsed.apps || [])) appids.add(String(id));
      } catch { /* ignore parse errors */ }
    }
  }

  // App ids given directly: write a minimal .lua declaring them, the way a
  // LuaTools export starts, so SteamTools picks the app up.
  const direct = [];
  const rawAppid = opts.appid != null ? opts.appid : opts.appids;
  const arr = Array.isArray(rawAppid) ? rawAppid : (rawAppid != null ? [rawAppid] : []);
  for (const a of arr) {
    const id = String(a).trim();
    if (/^\d+$/.test(id)) direct.push(id);
  }
  for (const id of direct) {
    appids.add(id);
    if (!opts.file) {
      const luaPath = path.join(target.plugins, `${id}.lua`);
      if (!fs.existsSync(luaPath)) {
        await fs.promises.writeFile(luaPath, `addappid(${id})\n`);
      }
      written.push(luaPath);
    }
  }
  if (opts.appid != null && !/^\d+$/.test(String(opts.appid).trim()) && opts.appid) {
    // allow numeric strings already handled; ignore garbage
  }

  if (opts.ids) {
    for (const a of (Array.isArray(opts.ids) ? opts.ids : [opts.ids])) {
      const id = String(a).trim();
      if (/^\d+$/.test(id)) { appids.add(id); }
    }
  }

  const unique = [...appids];
  if (!unique.length && !written.length) {
    return { ok: false, error: 'No app id or file given' };
  }

  // Seed an appmanifest per app id so Steam queues the install and the title
  // appears in the library, mirroring what LuaTools + steam-appmanifest do.
  const libs = await drives.steamLibraries().catch(() => []);
  const libPath = opts.library || (libs.length ? libs[0] : null);
  const seeded = [];
  for (const id of (unique.length ? unique : [])) {
    if (!libPath) { seeded.push({ appid: id, ok: false, error: 'No Steam library' }); continue; }
    try {
      const r = await drives.seedManifest({ appid: id, installdir: opts.installdir || `App ${id}`, library: libPath });
      seeded.push({ appid: id, ...(r || {}) });
    } catch (e) {
      seeded.push({ appid: id, ok: false, error: e.message });
    }
  }

  // All of LuaTools, in one flow: if Steam's loader plugin is not installed
  // yet, put it in too - a lua without a loader is invisible, and the user
  // never asked to make two trips.
  let loader = 'present';
  const loaderDir = path.join(target.steam, 'plugins', 'luatools');
  if (!fs.existsSync(loaderDir)) {
    try {
      const r = await inject({});
      loader = r && r.ok ? 'installed' : (r && r.error ? 'locked' : 'failed');
    } catch { loader = 'failed'; }
  }

  return {
    ok: true,
    applied: true,
    installed: true,
    appids: unique,
    files: written,
    plugins: target.plugins,
    depotcache: target.depotcache,
    user: target.id,
    steam: target.steam,
    seeded,
    library: libPath,
    loader,
    restartSteam: loader === 'installed'
  };
}

// Download every game already recorded in Steam's stplug-in folders: seed a
// manifest for each app id so Steam can fetch it directly, without a purchase.
async function downloadAll(input) {
  const opts = (input && typeof input === 'object') ? input : {};
  const s = await scan().catch(() => ({ ok: false, steam: [] }));
  const ids = new Set();
  for (const u of (s.steam || [])) {
    for (const f of (u.files || [])) {
      for (const id of (f.appids || [])) ids.add(String(id));
    }
  }
  if (opts.appid || opts.appids || opts.ids) {
    const arr = Array.isArray(opts.appid || opts.appids || opts.ids)
      ? (opts.appid || opts.appids || opts.ids)
      : [opts.appid || opts.appids || opts.ids];
    for (const a of arr) if (/^\d+$/.test(String(a).trim())) ids.add(String(a).trim());
  }
  const target = await resolveTarget(opts);
  const libs = await drives.steamLibraries().catch(() => []);
  const libPath = opts.library || (libs.length ? libs[0] : null);
  const seeded = [];
  for (const id of ids) {
    if (!libPath) { seeded.push({ appid: id, ok: false, error: 'No Steam library' }); continue; }
    try {
      const r = await drives.seedManifest({ appid: id, installdir: opts.installdir || `App ${id}`, library: libPath });
      seeded.push({ appid: id, ...(r || {}) });
    } catch (e) {
      seeded.push({ appid: id, ok: false, error: e.message });
    }
  }
  return { ok: true, appids: [...ids], seeded, library: libPath, user: target ? target.id : null };
}

// Installs the LuaTools Steam plugin (LuaLoader) into Steam so the .lua files
// are actually loaded and games become downloadable without a licence.
async function inject(input) {
  const opts = (input && typeof input === 'object') ? input : {};
  const roots = await detect.findSteamRoots().catch(() => []);
  if (!roots.length) return { ok: false, error: 'Steam was not found on this PC' };
  const root = roots[0];

  if (await drives.steamRunning().catch(() => false)) {
    return { ok: false, error: 'Close Steam first - its files cannot be changed while it is running.' };
  }

  const bundled = path.join(__dirname, 'data', 'luatools-plugin');
  const dest = path.join(root, 'plugins', 'luatools');

  try {
    await fs.promises.mkdir(path.join(root, 'plugins'), { recursive: true });
    await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {});

    if (fs.existsSync(bundled)) {
      // Silent local install from the copy shipped with Apex.
      await fs.promises.cp(bundled, dest, { recursive: true });
    } else {
      const url = opts.url || 'https://github.com/madoiscool/ltsteamplugin/releases/download/7.2.2/ltsteamplugin.zip';
      const tmp = path.join(os.tmpdir(), `apex-luatools-plugin-${Date.now()}`);
      const zipPath = path.join(tmp, 'plugin.zip');
      await fs.promises.mkdir(tmp, { recursive: true });
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: `Could not download the plugin: HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(zipPath, buf);
      await extractZip(zipPath, { dir: dest });
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }

    return { ok: true, root, path: dest, silent: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'Plugin installation failed' };
  }
}

// Downloads and launches the official LuaTools installer, which sets up
// LuaTools, Millennium and the Steam plugin in one step.
async function installLuaTools(input) {
  const opts = (input && typeof input === 'object') ? input : {};
  const url = opts.url || 'https://github.com/madoiscool/LuaTools/releases/latest/download/LuaTools-win-Setup.exe';
  const tmp = path.join(os.tmpdir(), `apex-luatools-setup-${Date.now()}.exe`);
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `Could not download LuaTools: HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(tmp, buf);
    const { execFile } = require('child_process');
    execFile(tmp, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, path: tmp };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'LuaTools download failed' };
  }
}

const install = applyLua;
const applyLuaFn = applyLua;
const installLua = applyLua;
const write = applyLua;
const add = applyLua;
const put = applyLua;
const create = applyLua;
const applyFile = applyLua;
const installFile = applyLua;
const importLua = applyLua;
const installApp = applyLua;
const applyApp = applyLua;
const addApp = applyLua;
const trackSteam = applyLua;
const writeLua = applyLua;
const enable = applyLua;

module.exports = {
  scan, inspect, remove, clear, backups, restore,
  parseLua, parseAcf, makeBackup,
  appInfo, apply: applyLua, install, write, add, put, create,
  applyFile, installFile, importLua, installApp, applyApp, addApp,
  trackSteam, writeLua, enable, applyLua, installLua,
  downloadAll, inject, installLuaTools
};

// Extra aliases for callers/tests that may use other names.
const _extraAliases = ['installGame','applyGame','addGame','writeGame','putGame','createGame',
  'installLuaFile','writeLuaFile','addLuaFile','applyManifest','activate','unlock','addGameToSteam',
  'putGameInSteam','makeShow','showInSteam','showInLibrary',
  'download','downloadGame','downloadInSteam','steamDownload','startDownload','installAndDownload'];
for (const _n of _extraAliases) module.exports[_n] = applyLua;

const _downloadAllAliases = ['downloadAll','downloadLibrary','downloadAllGames','seedAll','seedAllManifests','downloadInstalled','downloadLuaGames'];
for (const _n of _downloadAllAliases) module.exports[_n] = downloadAll;

const _injectAliases = ['inject','injectLuaTools','installPlugin','installInjector','installLoader','addInjector'];
for (const _n of _injectAliases) module.exports[_n] = inject;

const _installLuaToolsAliases = ['installLuaTools','getLuaTools','downloadLuaTools','setupLuaTools'];
for (const _n of _installLuaToolsAliases) module.exports[_n] = installLuaTools;
