'use strict';

/**
 * Lua tools - the read side of SteamTools' per-user folders.
 *
 * SteamTools (and the LuaTools generator that feeds it) works from
 * `<steam>/userdata/<id>/config/stplug-in`, where `.lua` scripts declare the app
 * ids and depots a game needs, and `depotcache` holds the matching manifests.
 *
 * Apex reads that folder and nothing else:
 *   - scan()    lists the Steam users, the plugin files, how many manifests are
 *               cached, and any loader DLL sitting in the user folder;
 *   - inspect() parses one dropped .lua / .acf file and says what it targets;
 *   - remove()  / clear() delete files the user put there - an uninstall, not an
 *               install. Neither ever writes a .lua or a manifest.
 *
 * The path checks in remove()/clear() exist because a renderer should never be
 * able to name an arbitrary file: the target has to sit inside a plugin folder
 * that scan() itself found.
 */

const fs = require('fs');
const path = require('path');
const detect = require('./detect');

const MAX_FILE = 512 * 1024;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Every `<steam>/userdata/<id>` that has a config folder, across every Steam. */
async function users() {
  const roots = await detect.findSteamRoots().catch(() => []);
  const out = [];
  for (const root of roots) {
    const userdata = path.join(root, 'userdata');
    let ids = [];
    try {
      ids = fs.readdirSync(userdata, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { ids = []; }

    for (const id of ids) {
      const home = path.join(userdata, id);
      const config = path.join(home, 'config');
      if (!isDir(config)) continue;
      out.push({
        steam: root,
        id,
        home,
        config,
        plugins: path.join(config, 'stplug-in'),
        depotcache: path.join(config, 'depotcache')
      });
    }
  }
  return out;
}

/** App ids and depot lines out of a SteamTools .lua script. */
function parseLua(text) {
  const appids = [];
  const depots = [];
  const manifests = [];
  const push = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

  const addRe = /addappid\s*\(\s*(\d+)/g;
  let m;
  while ((m = addRe.exec(text))) push(appids, m[1]);

  const manifestRe = /setManifestid\s*\(\s*(\d+)\s*,\s*"?(\d+)/g;
  while ((m = manifestRe.exec(text))) {
    push(manifests, m[2]);
    push(appids, m[1]);
  }

  // A second addappid argument is the depot count; the depot ids themselves are
  // usually named in comments, so take every 3-8 digit number that follows a
  // "depot" word as well.
  const depotRe = /depot[s]?\D{0,12}(\d{3,8})/gi;
  while ((m = depotRe.exec(text))) push(depots, m[1]);

  return { kind: 'lua', appids, depots, manifests };
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

/** Reads one .lua / .acf / .manifest and reports what it targets. */
async function inspect(file) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'No file given' };
  const ext = path.extname(file).toLowerCase();
  if (ext === '.zip') {
    return {
      ok: false,
      file,
      name: path.basename(file),
      error: 'Apex does not unpack archives into Steam. Extract the .lua and drop that instead.'
    };
  }
  const text = await readText(file);
  const base = { ok: true, file, name: path.basename(file), size: Buffer.byteLength(text) };

  if (ext === '.lua') {
    return { ...base, ...parseLua(text), title: null };
  }

  if (ext === '.acf' || ext === '.manifest' || ext === '.txt') {
    const acf = parseAcf(text);
    return {
      ...base,
      kind: 'manifest',
      appids: acf.appid ? [acf.appid] : [],
      depots: [],
      manifests: [],
      title: acf.name || null,
      installdir: acf.installdir || null,
      sizeOnDisk: acf.SizeOnDisk || null,
      state: acf.StateFlags || null
    };
  }

  // Unknown extension: still try the lua grammar, but say what it was.
  return { ...base, ...parseLua(text), ext, title: null };
}

async function scan() {
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
      let appids = [];
      try {
        const st = await fs.promises.stat(full);
        size = st.size;
        at = st.mtimeMs;
        if (/\.lua$/i.test(name) && size <= MAX_FILE) {
          const text = await fs.promises.readFile(full, 'utf8');
          appids = parseLua(text).appids;
        } else if (/\.acf$/i.test(name) && size <= MAX_FILE) {
          const acf = parseAcf(await fs.promises.readFile(full, 'utf8'));
          appids = acf.appid ? [acf.appid] : [];
        }
      } catch { /* gone between readdir and stat */ }
      files.push({ name, size, at, lua: /\.lua$/i.test(name), appids });
    }

    steam.push({
      steam: u.steam,
      id: u.id,
      plugins: u.plugins,
      hasPlugins: isDir(u.plugins),
      depotcache: u.depotcache,
      depotCount,
      loaders,
      files
    });
  }

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

async function remove(file, dir) {
  const allowed = await knownPluginDirs();
  const target = path.resolve(file);
  const owner = allowed.find((d) => inside(d, target));
  if (!owner) return { ok: false, error: 'That file is not inside a Steam plugin folder' };
  if (dir && path.resolve(dir) !== path.resolve(owner)) {
    return { ok: false, error: 'That file is not inside the folder you named' };
  }
  await fs.promises.unlink(target);
  return { ok: true };
}

/** Removes everything inside one plugin folder - the "delete all" cleanup. */
async function clear(dir) {
  const allowed = await knownPluginDirs();
  const target = path.resolve(dir || '');
  if (!allowed.some((d) => path.resolve(d) === target)) {
    return { ok: false, error: 'That is not a Steam plugin folder' };
  }
  let removed = 0;
  const rows = await fs.promises.readdir(target, { withFileTypes: true });
  for (const row of rows) {
    const full = path.join(target, row.name);
    if (row.isDirectory()) {
      await fs.promises.rm(full, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(full).catch(() => {});
    }
    removed++;
  }
  return { ok: true, removed };
}

module.exports = { scan, inspect, remove, clear, parseLua, parseAcf };
