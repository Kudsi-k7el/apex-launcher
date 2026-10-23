'use strict';

/**
 * The parts of the LuaTools desktop app Apex didn't have yet - ported from
 * madoiscool/LuaTools (MIT), which is WPF/.NET.
 *
 * Three features, the way the original ships them:
 *
 *   1. Lua editor (their "Manage" page). Depots are switched on or off by
 *      commenting the addappid line in or out, and a depot is pinned to a
 *      manifest by writing / commenting a setManifestid line. That's the whole
 *      mechanism the lua format has, so it's what we do too. Off is a comment,
 *      on is the same line uncommented.
 *
 *   2. CDN depot downloads (their "Depots" page). DepotDownloaderMod.exe is
 *      downloaded once from the repack repo and run one process per depot,
 *      anonymously (never a username), with the depot key and manifest from
 *      Steam's depotcache - or fetched from the public manifest backend if
 *      Steam doesn't have it yet. A manifest is required: an anonymous session
 *      owns no licence, so both key and manifest must be supplied.
 *
 *   3. Unlocker modes (their "Mode" page). Three mutually exclusive backends:
 *      OpenSteamTools (nightly), BetterSteamTools (the fork) and Custom (the
 *      user manages their own). Installing a mode downloads its release zip,
 *      verifies it, and copies dwmapi.dll / xinput1_4.dll / OpenSteamTool.dll
 *      into Steam's root, then registers config/stplug-in in opensteamtool.toml
 *      so the unlocker reads the lua files Apex writes.
 *
 * Every path the renderer can name has to sit inside a plugin folder that
 * luatools.scan() found, and every delete/rewrite backs the file up first.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const detect = require('./detect');
const extractZip = require('extract-zip');
const luatools = require('./luatools');

const MANIFEST_BACKEND = 'http://167.235.229.108';
const MANIFEST_UA = 'secretgoonpoon';
const CLOUD_REDIRECT_REPO = 'Selectively11/CloudRedirect';
const DEPOT_DOWNLOADER_REPO = 'mendy-tools/DepotDownloaderMod';
// GitHub download mirrors (same list the original app uses for blocked regions).
const GH_DL_MIRRORS = ['https://ghproxy.net/', 'https://ghfast.top/', 'https://gh.ddlc.top/'];
const MAX_LUA = 512 * 1024;
const MAX_CHUNKS = 32; // DepotDownloader's -max-downloads, the same value LuaTools raises to

// ---------------------------------------------------------------------------
// GitHub helpers - direct first, download mirrors as fallback
// ---------------------------------------------------------------------------

function ghCandidates(url) {
  const out = [url];
  if (!/^https:\/\/(raw\.githubusercontent\.com|github\.com)\//i.test(url)) {
    for (const m of GH_DL_MIRRORS) out.push(m + url);
  }
  return out;
}

async function ghJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'apex-launcher', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function ghDownload(url, dest, onProgress) {
  const tries = ghCandidates(url);
  let lastErr = null;
  for (const u of tries) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'apex-launcher' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const web = res.body;
      if (!web) throw new Error('Empty response');
      let got = 0;
      const rows = [];
      for await (const chunk of web) {
        rows.push(Buffer.from(chunk));
        got += chunk.length;
        if (onProgress && total) onProgress(got, total);
      }
      await fs.promises.writeFile(dest, Buffer.concat(rows));
      return dest;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not download ${url}: ${(lastErr && lastErr.message) || 'network error'}`);
}

// ---------------------------------------------------------------------------
// 1. Lua editor
// ---------------------------------------------------------------------------

/**
 * Full parse of a stplug-in lua: every addappid line with its decryption key and
 * on/off state, every setManifestid pin (active or commented out).
 *
 * A line like `-- addappid(4954911, 1, "key")` is a DISABLED depot: the entry
 * exists, but Steam ignores it. `addappid(4954911)` without a third argument is
 * a plain entitlement (a DLC id), not a content depot. Pins commented out mean
 * "Steam keeps this depot updated" - not pinned.
 */
function parseLuaDetails(text, filenameHint) {
  const RE_ADD = /addappid\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*(?:,\s*"([^"]*)")?)?\s*\)\s*(?:--\s*(.*?)\s*)?$/i;
  const RE_PIN = /setManifestid\s*\(\s*(\d+)\s*,\s*"(\d+)"\s*(?:,\s*(\d+))?/i;

  const byId = new Map(); // keeps first-seen order
  const pins = new Map();

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    const isCommented = /^--/.test(line);
    const code = isCommented ? line.replace(/^--+\s*/, '') : line;

    const mAdd = RE_ADD.exec(code);
    if (mAdd) {
      const id = String(mAdd[1]);
      let e = byId.get(id);
      if (!e) {
        e = { id, key: null, flag: 1, active: true, comment: null };
        byId.set(id, e);
      }
      if (isCommented) e.active = false;
      if (mAdd[3]) e.key = mAdd[3];
      if (mAdd[2] != null && mAdd[2] !== '') e.flag = Number(mAdd[2]);
      const comment = (mAdd[4] || '').trim();
      // Reject commented-out code that a sloppy writer left as the "comment".
      if (comment && !/(setManifestid|addappid|addtoken)/i.test(comment) && !e.comment) e.comment = comment;
    }

    const mPin = RE_PIN.exec(code);
    if (mPin) {
      const depot = String(mPin[1]);
      pins.set(depot, {
        depot,
        manifest: String(mPin[2]),
        size: mPin[3] ? Number(mPin[3]) : null,
        commented: isCommented
      });
    }
  }

  const entries = [...byId.values()].map((e) => ({
    ...e,
    // A depot is enabled when its line is active AND its flag is 1. flag 0 with a
    // key happens too (a key without unlock); LuaTools treats the line comment as
    // the switch, the 0/1 argument rides along.
    enabled: e.active && e.flag === 1,
    hasKey: !!e.key
  }));

  const pinList = [...pins.values()].map((p) => ({ ...p, locked: !p.commented }));
  const depots = entries.filter((e) => e.hasKey);

  // LuaTools takes the base app id from the FILE NAME (4954910.lua), because a
  // generator writes the main appid with a depot key too. Fall back to the
  // first keyless, un-pinned id inside the text.
  let base = null;
  const hint = /^(\d+)/.exec(String(filenameHint || ''));
  if (hint && byId.has(hint[1])) base = hint[1];
  if (!base) {
    const notDepot = new Set();
    for (const e of entries) if (e.key) notDepot.add(e.id);
    for (const p of pins.keys()) notDepot.add(p);
    for (const e of entries) { if (!notDepot.has(e.id)) { base = e.id; break; } }
  }

  return {
    appId: base,
    entries,
    depots: depots.map((e) => ({ ...e, pinned: false, pin: pinList.find((p) => p.depot === e.id) || null })),
    dlc: entries.filter((e) => !e.hasKey && e.id !== base),
    pins: pinList,
    activePins: pinList.filter((p) => p.locked),
    depotCount: depots.length,
    dlcCount: entries.filter((e) => !e.hasKey && e.id !== base).length
  };
}

/** True when `file` sits in a plugin folder scan() itself found. */
async function authorizeLuaFile(file) {
  const scan = await luatools.scan().catch(() => ({ steam: [] }));
  const allowed = (scan.steam || []).map((u) => u.plugins);
  const resolved = path.resolve(String(file || ''));
  const owner = allowed.find((d) => resolved.startsWith(path.resolve(d) + path.sep));
  return { ok: !!owner, owner, allowed };
}

/** Read one lua out of Steam's plugin folder and report everything in it. */
async function readLua(file) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'No file given' };
  const gate = await authorizeLuaFile(file);
  if (!gate.ok) return { ok: false, error: 'That file is not inside a Steam plugin folder' };

  let text = '';
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return { ok: false, error: 'That is not a file' };
    if (st.size > MAX_LUA) return { ok: false, error: 'That file is larger than 512 KB' };
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const details = parseLuaDetails(text, path.basename(file));
  return {
    ok: true,
    file: path.resolve(file),
    name: path.basename(file),
    dir: gate.owner,
    ...details
  };
}

/**
 * Comment in/out every line matching `core` (a per-id fragment of the addappid /
 * setManifestid call). Port of LuaTools' LuaEditor.Rewrite: the '"' toggle is the
 * only mechanism the format has, and every match for the id is rewritten (an id
 * can appear twice - a bare line plus a keyed one).
 */
function toggleLines(text, core, active) {
  const re = new RegExp(`^(\\s*)(?:(--+)\\s*)?(${core})`, 'i');
  return text.split('\n').map((line) => {
    const m = re.exec(line);
    if (!m) return line;
    const isCommented = !!m[2];
    if (isCommented === !active) return line; // already in the wanted state
    const indent = m[1];
    const rest = line.slice(indent.length + (m[2] ? m[2].length : 0));
    return active ? indent + rest : indent + '--' + rest;
  }).join('\n');
}

// `setManifestid(depot, ...)` / `addappid(depot, ...)`, commented or not.
const pinLineCore = (depot) => `setManifestid\\s*\\(\\s*${depot}\\s*[,)]`;
const addAppLineCore = (depot) => `addappid\\s*\\(\\s*${depot}\\s*[,)]`;



/**
 * Apply one edit to a lua file inside Steam's plugin folders.
 * opts: { file, op, depot, manifest, enabled, key, appid, text }
 *
 * ops:
 *   enable / disable       - comment the depot's addappid line in/out
 *   lock / unlock          - comment the depot's setManifestid line out/in
 *   setPin / addPin        - write or move the depot's setManifestid to a manifest
 *   addPin                 - alias of setPin
 *   removePin              - the same as unlock (commenting is the format's off)
 *   addDepot               - add (or rewrite) the addappid line, optionally with key
 *   removeDepot            - comment the depot's addappid line out
 *   addApp                 - append a bare addappid(appid)
 *   addToken               - append addtoken("<token>")
 *   save                   - write the renderer's raw text back verbatim
 */
async function editLua(opts) {
  const o = opts || {};
  const op = String(o.op || '').trim();
  const gate = await authorizeLuaFile(o.file);
  if (!gate.ok) return { ok: false, error: 'That file is not inside a Steam plugin folder' };
  const file = path.resolve(o.file);

  if (op === 'save') {
    if (typeof o.text !== 'string' || o.text.length > MAX_LUA) {
      return { ok: false, error: 'Nothing valid to write' };
    }
    let backup = '';
    try { backup = await luatools.makeBackup([file], gate.owner); } catch { /* best effort */ }
    await fs.promises.writeFile(file, o.text, 'utf8');
    return { ok: true, op, file, backup };
  }

  let text = '';
  try {
    const st = await fs.promises.stat(file);
    if (st.size > MAX_LUA) return { ok: false, error: 'That file is larger than 512 KB' };
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // One depot per operation: comment toggles work per addappid/setManifestid line.
  if (op === 'enable' || op === 'disable' || op === 'addDepot' || op === 'removeDepot') {
    if (!/^\d+$/.test(String(o.depot || ''))) return { ok: false, error: 'No depot id given' };
    const id = String(o.depot);
    const wantOn = op === 'enable';
    const adding = op === 'addDepot';
    const removing = op === 'removeDepot';

    if (adding) {
      const entries = parseLuaDetails(text);
      const known = entries.entries.find((e) => e.id === id);
      const key = o.key != null ? String(o.key) : '';
      if (known) {
        // Rewrite the first keyed line, or the first active bare line, to the
        // wanted call. Keep indentation and the line's trailing-name comment.
        const keyLineRe = new RegExp(`^(\\s*)(--\\s*)?(addappid\\s*\\(\\s*${id}\\s*,\\s*\\d+\\s*(?:,\\s*"[^"]*"\\s*)?\\))(.*)$`, 'i');
        const anyLineRe = new RegExp(`^(\\s*)(--\\s*)?(addappid\\s*\\(\\s*${id}\\b[^)]*\\))(.*)$`, 'i');
        const wantKey = !!String(key || '').trim();
        const pick = text.split('\n').map((line) => {
          const m = keyLineRe.exec(line) || anyLineRe.exec(line);
          return m ? { line, m } : null;
        }).find(Boolean);
        if (pick) {
          const [, indent, cm, , tail] = pick.m;
          const inline = tail.includes('--') ? tail.slice(tail.indexOf('--')) : '';
          const call = wantKey
            ? `addappid(${id}, ${o.enabled === false ? 0 : 1}, "${key.trim()}")`
            : `addappid(${id}, ${o.enabled === false ? 0 : 1})`;
          const newline = `${indent}${cm || ''}${call}${inline ? ' ' + inline : ''}`;
          text = text.split('\n').map((line) =>
            line === pick.line ? newline : line).join('\n');
          // A rewrite is either active or commented, per `enabled`.
          text = toggleLines(text, addAppLineCore(id), o.enabled !== false);
        } else {
          return { ok: false, error: 'Depot line could not be rewritten' };
        }
      } else {
        const args = ['1'];
        if (key) args.push(`"${key}"`);
        const nl = text.endsWith('\n') ? '' : '\n';
        text += `${nl}addappid(${id}, ${args.join(', ')})\n`;
      }
    } else if (op === 'removeDepot' || op === 'disable') {
      text = toggleLines(text, addAppLineCore(String(id)), wantOn);
    } else {
      text = toggleLines(text, addAppLineCore(String(id)), true);
    }
  }

  if (op === 'lock' || op === 'unlock' || op === 'removePin') {
    if (!/^\d+$/.test(String(o.depot || ''))) return { ok: false, error: 'No depot id given' };
    text = toggleLines(text, pinLineCore(String(o.depot)), op === 'lock');
  }

  if (op === 'setPin' || op === 'addPin') {
    if (!/^\d+$/.test(String(o.depot || ''))) return { ok: false, error: 'No depot id given' };
    if (!/^\d+$/.test(String(o.manifest || ''))) return { ok: false, error: 'No manifest id given' };
    const id = String(o.depot);
    const hasPinLine = new RegExp(pinLineCore(id), 'i').test(text);
    if (hasPinLine) {
      let hit = false;
      text = text.split('\n').map((line) => {
        const m = new RegExp(`^(\\s*)(--\\s*)?(setManifestid\\s*\\(\\s*${id}\\s*,\\s*)"?\\d+"?(\\s*,\\s*\\d+)?(.*)$`, 'i').exec(line);
        if (!m || hit) return line;
        hit = true;
        const [, indent, cm, fn, size, tail] = m;
        return `${indent}${cm || ''}${fn}"${String(o.manifest)}"${size || ''}${tail || ''}`;
      }).join('\n');
      text = toggleLines(text, pinLineCore(id), true); // an edited pin is an active pin
      if (!hit) return { ok: false, error: 'Pin line could not be rewritten' };
    } else {
      const nl = text.endsWith('\n') ? '' : '\n';
      text += `${nl}setManifestid(${id}, "${String(o.manifest)}")\n`;
    }
  }

  if (op === 'addApp') {
    if (!/^\d+$/.test(String(o.appid || ''))) return { ok: false, error: 'No app id given' };
    const id = String(o.appid);
    if (!new RegExp(`addappid\\s*\\(\\s*${id}\\b`, 'i').test(text)) {
      const nl = text.endsWith('\n') ? '' : '\n';
      text += `${nl}addappid(${id})\n`;
    }
  }

  if (op === 'addToken') {
    const token = String(o.token || '').replace(/["\r\n]/g, '');
    if (!token) return { ok: false, error: 'No token given' };
    if (!/addtoken\s*\(/i.test(text)) {
      const nl = text.endsWith('\n') ? '' : '\n';
      text += `${nl}addtoken("${token}")\n`;
    }
  }

  // Backup then write - the failure mode to avoid is a half-applied toggle.
  let backup = '';
  try { backup = await luatools.makeBackup([file], gate.owner); } catch { /* best effort */ }
  await fs.promises.writeFile(file, text, 'utf8');
  const details = parseLuaDetails(text);
  return { ok: true, op, file, backup, ...details };
}

// ---------------------------------------------------------------------------
// 2. CDN depot downloads (DepotDownloaderMod)
// ---------------------------------------------------------------------------

function downloaderDir() {
  return path.join(require('electron').app.getPath('userData'), 'depotdownloader');
}
function downloaderExe() {
  return path.join(downloaderDir(), 'DepotDownloaderMod.exe');
}

/**
 * DepotDownloaderMod sits under Apex's user data folder. Checked against GitHub's
 * latest release; a version file records the tag we last fetched.
 */
async function ensureDownloader(onProgress) {
  const dir = downloaderDir();
  const exe = downloaderExe();
  if (fs.existsSync(exe)) return exe;

  let rel = null;
  try {
    rel = await ghJson(`https://api.github.com/repos/${DEPOT_DOWNLOADER_REPO}/releases/latest`);
  } catch (e) {
    throw new Error(`Could not look up DepotDownloaderMod: ${e.message}`);
  }
  const asset = (rel.assets || []).find((a) => /\.zip$/i.test(a.name));
  if (!asset) throw new Error('DepotDownloaderMod has no zip asset to fetch');

  const tmp = path.join(os.tmpdir(), `apex-ddmod-${Date.now()}.zip`);
  await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
  await ghDownload(asset.browser_download_url || asset.download_url, tmp, (got, total) => {
    if (onProgress) onProgress(Math.min(1, got / total), total);
  });
  await extractZip(tmp, { dir }).catch(() => {});
  try { await fs.promises.rm(tmp, { force: true }); } catch { /* ignore */ }
  if (!fs.existsSync(exe)) {
    // The repack is a flat zip; a nested one needs the exe lifted up.
    const found = (function walk(sub, depth) {
      if (depth > 3) return null;
      let rows = [];
      try { rows = fs.readdirSync(sub, { withFileTypes: true }); } catch { rows = []; }
      for (const r of rows) {
        if (r.isFile() && /^DepotDownloaderMod\.exe$/i.test(r.name)) return path.join(sub, r.name);
        if (r.isDirectory()) {
          const hit = walk(path.join(sub, r.name), depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    })(dir, 0);
    if (!found) { await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); throw new Error('DepotDownloaderMod.exe was not in the archive'); }
    try { await fs.promises.rename(found, exe); } catch { throw new Error('DepotDownloaderMod.exe could not be moved into place'); }
  }
  try {
    await fs.promises.writeFile(path.join(dir, 'version.json'),
      JSON.stringify({ tag: rel.tag_name, at: Date.now() }));
  } catch { /* ignore */ }
  return exe;
}

/** Returns what the downloader needs to know to paint itself. */
async function downloaderStatus() {
  const exe = downloaderExe();
  let version = null;
  try { version = JSON.parse(await fs.promises.readFile(path.join(downloaderDir(), 'version.json'), 'utf8')).tag || null; } catch { /* ignore */ }
  return { ok: true, installed: fs.existsSync(exe), exe: fs.existsSync(exe) ? exe : null, version };
}

/**
 * Fetches one depot's manifest into a depotcache when Steam does not have it
 * yet (the public backend way, so anonymous depot downloads still work).
 */
async function fetchDepotManifest(depotId, manifestId, depotcache, onProgress) {
  const url = `${MANIFEST_BACKEND}/api/givemethemanifestpunk/${depotId}/${manifestId}`;
  const res = await fetch(url, { headers: { 'User-Agent': MANIFEST_UA } });
  if (!res.ok) throw new Error(`The manifest backend answered HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(depotcache, `${depotId}_${manifestId}.manifest`);
  await fs.promises.writeFile(dest, buf);
  return dest;
}

// One depot at a time, the same serialization LuaTools runs behind: parallel
// anonymous sessions disconnect each other, and parallel GBs split bandwidth.
let depotGate = Promise.resolve();
const running = new Map(); // id -> { proc, id }

function buildKeysFile(depotKeys, dir) {
  const file = path.join(dir, `depotkeys_${Date.now().toString(36)}.txt`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const body = Object.entries(depotKeys || {}).map(([id, key]) => `${id};${key}`).join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Download depot content with DepotDownloaderMod.
 * opts: { appId, file (lua to take the keys from), depots: [{ depot, manifest }], outDir, validate }
 * emit: (event) => void, streamed to the renderer (progress, phases).
 */
async function downloadDepots(opts, emit) {
  const o = opts || {};
  const send = (evt) => { try { emit && emit(evt); } catch { /* ignore */ } };

  if (!o.outDir) return { ok: false, error: 'No output folder given' };

  const appId = String(o.appId || '').trim();
  if (!/^\d+$/.test(appId)) return { ok: false, error: 'No app id given' };

  // The keys come from the lua itself, read in this process - never passed over
  // the wire from a renderer.
  const keys = {};
  if (o.file) {
    try {
      const gate = await authorizeLuaFile(o.file);
      if (!gate.ok) return { ok: false, error: 'That lua is not inside a Steam plugin folder' };
      const text = await fs.promises.readFile(path.resolve(o.file), 'utf8');
      for (const e of parseLuaDetails(text).entries) if (e.key) keys[e.id] = e.key;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  for (const [k, v] of Object.entries(o.keys || {})) if (k && v) keys[String(k)] = String(v);

  const depots = (Array.isArray(o.depots) ? o.depots : []).filter((d) => d && /^\d+$/.test(String(d.depot)));
  if (!depots.length) return { ok: false, error: 'No depots were selected' };

  const missing = depots.filter((d) => !keys[String(d.depot)]);
  if (missing.length) {
    return { ok: false, error: `No decryption key for depot ${missing[0].depot} inside the lua`, depots: missing.map((d) => String(d.depot)) };
  }

  const id = `dd:${appId}:${Date.now()}`;
  const plan = depots.map((d) => ({ depot: String(d.depot), manifest: String(d.manifest || '') }));
  // The cancel record lives its own life: cancelDepots marks it and kills the
  // child, while the run loop owns the run() chain below.
  const rec = { id, cancel: false, proc: null };
  running.set(id, rec);

  // Where Steam keeps manifests for this depot: the depotcache of whatever
  // Steam install owns the file's plugin folder.
  let depotcache = o.depotcache;
  if ((!depotcache || !fs.existsSync(depotcache)) && o.file) {
    const cacheDir = (function find(up, depth) {
      if (depth > 4) return null;
      try {
        const cand = path.join(path.dirname(up), 'depotcache');
        if (fs.existsSync(cand)) return cand;
        return find(path.dirname(up), depth + 1);
      } catch { return null; }
    })(o.file, 0);
    if (cacheDir) depotcache = cacheDir;
  }
  if (!depotcache) {
    try {
      const users = await luatools.scan();
      const first = (users.steam || [])[0];
      if (first) depotcache = first.depotcache;
    } catch { /* ignore */ }
  }

  // Everything runs after the previous depot is done, from a single chain.
  depotGate = depotGate.then(() => run());
  function run() {
    return new Promise(async (resolve) => {
      try {
        const dir = downloaderDir();
        await fs.promises.mkdir(path.join(dir, 'staging'), { recursive: true }).catch(() => {});
        const exe = await ensureDownloader((f) => send({ id, type: 'tool', pct: f }))
          .catch((e) => { throw new Error(`DepotDownloaderMod could not be fetched: ${e.message}`); });

        const keysFile = buildKeysFile(keys, path.join(os.tmpdir(), `apex-ddkeys-${Date.now()}`));
        await fs.promises.mkdir(o.outDir, { recursive: true }).catch(() => {});

        send({ id, type: 'start', appId, depots: plan, outDir: o.outDir });

        let phase = null;
        const PROGRESS = /^\s*([0-9]+(?:\.[0-9]+)?)%\s+(.+)$/;
        let lastPct = -1;

        for (let i = 0; i < plan.length; i++) {
          const sel = plan[i];
          if (!/^\d+$/.test(sel.manifest)) {
            send({ id, type: 'skip', depot: sel.depot, error: 'No manifest id for that depot' });
            continue;
          }

          // A shared manifest may already be cached by Steam; if not, ask the
          // public backend so the anonymous run has one to open.
          let manifestPath = null;
          if (depotcache && fs.existsSync(depotcache)) {
            try {
              manifestPath = fs.readdirSync(depotcache)
                .map((n) => path.join(depotcache, n))
                .find((p) => path.basename(p).startsWith(`${sel.depot}_`) && path.basename(p).includes(sel.manifest)) || null;
            } catch { manifestPath = null; }
          }
          if (!manifestPath && depotcache) {
            try {
              send({ id, type: 'manifest', depot: sel.depot });
              manifestPath = await fetchDepotManifest(sel.depot, sel.manifest, depotcache);
            } catch (e) {
              // Backend down or that version gone: run without -manifestfile
              // and let the tool fetch the manifest from Steam itself.
              manifestPath = null;
              send({ id, type: 'manifest', depot: sel.depot, error: e.message });
            }
          }
          // Backend down or that version gone is not fatal: run without
          // -manifestfile and let the tool fetch the manifest from Steam.
          const args = [
            '-app', appId,
            '-depot', sel.depot,
            '-manifest', sel.manifest,
            '-depotkeys', keysFile,
            '-dir', o.outDir,
            '-max-downloads', String(MAX_CHUNKS)
          ];
          if (manifestPath) args.push('-manifestfile', manifestPath);
          if (o.validate) args.push('-validate');

          const stillWanted = () => !rec.cancel;
          await new Promise((doneSel) => {
            const { spawn } = require('child_process');
            const proc = spawn(exe, args, { cwd: dir, windowsHide: true });
            rec.proc = proc;

            let sinceOutput = Date.now();
            const watchdog = setInterval(() => {
              if (Date.now() - sinceOutput > 10 * 60 * 1000) {
                // The tool has printed nothing for 10 minutes: it is prompting
                // (which it never should) or wedged. Kill and say so.
                try { proc.kill(); } catch { /* ignore */ }
                clearInterval(watchdog);
              }
            }, 15000);

            proc.stdout.on('data', (d) => {
              sinceOutput = Date.now();
              for (const raw of String(d).split(/\r?\n/)) {
                const line = raw.trim();
                if (!line) continue;
                const m = PROGRESS.exec(line);
                if (m) {
                  const pct = Math.min(1, Number(m[1]) / 100);
                  if (pct !== lastPct) {
                    lastPct = pct;
                    phase = 'downloading';
                    send({ id, type: 'progress', depot: sel.depot, pct, phase });
                  }
                  continue;
                }
                if (/Downloading depot .* manifest/i.test(line) && phase !== 'manifest') {
                  phase = 'manifest';
                  send({ id, type: 'phase', depot: sel.depot, phase });
                } else if (/Pre-allocating/i.test(line) && phase !== 'pre-allocating') {
                  phase = 'pre-allocating';
                  send({ id, type: 'phase', depot: sel.depot, phase, note: line });
                } else if (/Validating/i.test(line) && phase !== 'validating') {
                  phase = 'validating';
                  send({ id, type: 'phase', depot: sel.depot, phase });
                } else if (/\.(dll|exe|steam|bin|vpk|zip|bin)$/i.test(line) || /^(Writing|Copied)/i.test(line)) {
                  send({ id, type: 'file', depot: sel.depot, note: line.slice(0, 120) });
                }
              }
            });
            proc.stderr.on('data', (d) => {
              sinceOutput = Date.now();
              send({ id, type: 'stderr', note: String(d).trim().slice(0, 200) });
            });
            proc.on('exit', (code) => {
              clearInterval(watchdog);
              send({ id, type: 'depot-done', depot: sel.depot, ok: code === 0, code });
              doneSel();
            });
            proc.on('error', (e) => {
              clearInterval(watchdog);
              send({ id, type: 'depot-done', depot: sel.depot, ok: false, error: e.message });
              doneSel();
            });
          });
          if (!stillWanted()) break; // the user cancelled mid-run
        }

        send({ ok: true, id, type: 'done' });
        resolve();
      } catch (e) {
        send({ ok: false, id, type: 'done', error: e.message });
        resolve();
      } finally {
        running.delete(id);
      }
    });
  }

  return { ok: true, id, depots: plan, outDir: o.outDir };
}

/** Cancels a run: marks it stopped and kills the current child. */
function cancelDepots(id) {
  const rec = running.get(String(id));
  if (!rec) return { ok: false, error: 'No such run' };
  rec.cancel = true;
  try { rec.proc && rec.proc.kill(); } catch { /* ignore */ }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. Unlocker modes (OpenSteamTools / BetterSteamTools / Custom)
// ---------------------------------------------------------------------------

const MODE_DEFS = {
  ost: {
    name: 'OpenSteamTools',
    desc: 'The nightly channel of OpenSteamTool, built into the OST-Nightly repo. Carries native CloudRedirect support.',
    repo: 'madoiscool/OST-Nightly',
    place: ['dwmapi.dll', 'xinput1_4.dll', 'OpenSteamTool.dll'],
    zip: 'OpenSteamTool-{v}-Release.zip'
  },
  bst: {
    name: 'BetterSteamTools',
    desc: 'The BetterSteamTools fork of OpenSteamTool. Files keep the upstream names; the dll gets versioned by its own update manifest.',
    repo: 'madoiscool/BetterSteamTools',
    place: ['dwmapi.dll', 'xinput1_4.dll', 'OpenSteamTool.dll'],
    zip: 'OpenSteamTool-{v}-Release.zip',
    manifestUrl: 'https://raw.githubusercontent.com/madoiscool/BetterSteamTools/refs/heads/updates/opensteamtool/latest.toml'
  },
  custom: {
    name: 'Custom',
    desc: 'You install and update your own unlocker. Apex downloads nothing and places nothing.',
    manual: true
  }
};
const BST_MANIFEST_URL = MODE_DEFS.bst.manifestUrl;

function modeStateFile() {
  return path.join(require('electron').app.getPath('userData'), 'apex-luatools-mode.json');
}
async function readModeState() {
  try { return JSON.parse(await fs.promises.readFile(modeStateFile(), 'utf8')); } catch { return {}; }
}
async function writeModeState(state) {
  try { await fs.promises.writeFile(modeStateFile(), JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}

function sha256File(file) {
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

/** Flat `key = "value"` TOML with the two known shapes (version/file/sha256). */
function parseLatestToml(toml) {
  const out = {};
  for (const raw of String(toml).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return out;
}

async function steamRoot() {
  const roots = await detect.findSteamRoots().catch(() => []);
  if (!roots.length || !fs.existsSync(roots[0])) return null;
  return roots[0];
}

/** One row per mode, with its current status, latest version and active flag. */
async function modes() {
  const state = await readModeState();
  const selected = state.mode || null;
  const root = await steamRoot();
  const out = [];

  for (const id of ['ost', 'bst', 'custom']) {
    const def = MODE_DEFS[id];
    const active = selected === id;
    const row = { id, name: def.name, description: def.desc, active, status: 'unknown', version: null };

    if (def.manual) {
      row.status = 'user-managed';
      out.push(row);
      continue;
    }
    if (!root) { row.status = 'unknown'; out.push(row); continue; }

    try {
      if (def.manifestUrl) {
        // BST publishes version + payload hash in a raw-hosted TOML.
        const res = await fetch(BST_MANIFEST_URL, { headers: { 'User-Agent': 'apex-launcher' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const toml = parseLatestToml(await res.text());
        const local = path.join(root, toml.file || 'OpenSteamTool.dll');
        if (!fs.existsSync(local)) row.status = 'not-installed';
        else row.status = sha256File(local) === (toml.sha256 || '') ? 'up-to-date' : 'update-available';
        row.version = toml.version || null;
      } else {
        // OST: OpenSteamTool.dll is the nightly's change indicator; the loaders
        // (dwmapi/xinput) rarely move, so only the payload is compared.
        const rel = await ghJson(`https://api.github.com/repos/${def.repo}/releases/latest`);
        const ostDll = path.join(root, 'OpenSteamTool.dll');
        const asset = (rel.assets || []).find((a) => a.name === 'OpenSteamTool.dll');
        const want = asset && asset.digest ? String(asset.digest).replace(/^sha256:/, '') : null;
        if (!fs.existsSync(ostDll)) row.status = 'not-installed';
        else if (want && sha256File(ostDll) === want) row.status = 'up-to-date';
        else row.status = 'update-available';
        row.version = rel.tag_name || null;
      }
    } catch {
      row.status = 'unknown';
    }
    out.push(row);
  }

  // No mode ever picked in Apex: derive it from what is on disk, the way
  // LuaTools' mode detection does - BST's up-to-date hash match, then OST's.
  const resolved = selected
    || (out.find((m) => m.id === 'bst' && m.status === 'up-to-date') || {}).id
    || (out.find((m) => m.id === 'ost' && m.status === 'up-to-date') || {}).id
    || null;
  for (const m of out) m.active = resolved === m.id;

  return { ok: true, steamRoot: root, selected: resolved, modes: out };
}

/** Minimal port of EnsureOpenSteamToolLuaPath: keep `[lua] paths` pointing at
 * config/stplug-in so OST/BST re-read the lua files Apex writes. */
async function ensureLuaPathRegistered(root) {
  const tomlPath = path.join(root, 'opensteamtool.toml');
  const want = 'config/stplug-in';
  if (!fs.existsSync(tomlPath)) {
    await fs.promises.writeFile(tomlPath, `[lua]\npaths = ["${want}"]\n`);
    return true;
  }
  const lines = (await fs.promises.readFile(tomlPath, 'utf8')).split('\n');
  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '[lua]' && !lines[i].trimStart().startsWith('#')) { header = i; break; }
  }
  const registered = () => lines.some((l) => /["']\s*config[/\\]+stplug-in\s*["']/i.test(l));
  if (registered()) return true;
  if (header < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push('[lua]');
    lines.push(`paths = ["${want}"]`);
  } else lines.splice(header + 1, 0, `paths = ["${want}"]`);
  await fs.promises.writeFile(tomlPath, lines.join('\n'));
  return true;
}

/** Install (or switch) an unlocker mode. progress: (fraction | null) => void */
async function setMode(opts, emit) {
  const o = opts || {};
  const id = String(o.mode || '').trim();
  const def = MODE_DEFS[id];
  if (!def) return { ok: false, error: 'Unknown mode' };
  const send = (evt) => { try { emit && emit(evt); } catch { /* ignore */ } };

  // Custom: selecting it is the whole job.
  if (def.manual) {
    await writeModeState({ mode: id, at: new Date().toISOString() });
    send({ type: 'mode-done', mode: id, ok: true });
    return { ok: true, mode: id, selected: true };
  }

  const root = await steamRoot();
  if (!root) return { ok: false, error: 'Steam was not found on this PC' };

  const staging = path.join(os.tmpdir(), `apex-mode-${Date.now()}`);
  await fs.promises.mkdir(staging, { recursive: true });
  try {
    let zipUrl = null;
    let zipName = null;
    let wantedZipDigest = null;
    let payload = null; // { file, sha256 } from BST's TOML

    if (def.manifestUrl) {
      const res = await fetch(BST_MANIFEST_URL, { headers: { 'User-Agent': 'apex-launcher' } });
      if (!res.ok) return { ok: false, error: `The update server answered HTTP ${res.status}` };
      const toml = parseLatestToml(await res.text());
      payload = { file: toml.file, sha256: toml.sha256 };
      zipName = (def.zip || '').replace('{v}', toml.version);
      zipUrl = `https://github.com/${def.repo}/releases/download/${toml.version}/${zipName}`;
    } else {
      const rel = await ghJson(`https://api.github.com/repos/${def.repo}/releases/latest`);
      const asset = (rel.assets || []).find((a) => /release\.zip$/i.test(a.name)) || (rel.assets || []).find((a) => /\.zip$/i.test(a.name));
      if (!asset) return { ok: false, error: 'That release has no zip to fetch' };
      zipName = asset.name;
      zipUrl = asset.browser_download_url || asset.download_url;
      wantedZipDigest = asset.digest ? String(asset.digest).replace(/^sha256:/, '') : null;
    }

    send({ type: 'mode-progress', mode: id, phase: 'download', pct: 0 });
    const zipPath = path.join(staging, zipName);
    await ghDownload(zipUrl, zipPath, (got, total) => {
      if (total) send({ type: 'mode-progress', mode: id, phase: 'download', pct: got / total, got, total });
    });
    if (wantedZipDigest) {
      const got = sha256File(zipPath);
      if (got && got !== wantedZipDigest) return { ok: false, error: 'That zip does not match the digest GitHub published' };
    }

    send({ type: 'mode-progress', mode: id, phase: 'extract', pct: 0.5 });
    const stageDir = path.join(staging, 'files');
    await fs.promises.mkdir(stageDir, { recursive: true });
    await extractZip(zipPath, { dir: stageDir });

    // Copy exactly the place files (some zips are nested one folder deep).
    const staged = {};
    for (const name of def.place) {
      const found = (function walk(dir) {
        let rows = [];
        try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { rows = []; }
        for (const r of rows) {
          const full = path.join(dir, r.name);
          if (r.isDirectory()) {
            const hit = walk(full);
            if (hit) return hit;
          } else if (String(r.name).toLowerCase() === String(name).toLowerCase()) {
            return full;
          }
        }
        return null;
      })(stageDir);
      if (!found) return { ok: false, error: `${name} was not inside that release` };
      staged[name] = found;
    }

    if (payload && staged[payload.file]) {
      const hash = sha256File(staged[payload.file]);
      if (hash && hash !== payload.sha256) {
        return { ok: false, error: `${payload.file} does not match the hash the update server published` };
      }
    }

    const failed = [];
    for (const name of def.place) {
      try {
        await fs.promises.copyFile(staged[name], path.join(root, name));
      } catch {
        // Steam locks its dlls while open; report per-file instead of failing all.
        failed.push(name);
      }
    }
    try { await ensureLuaPathRegistered(root); } catch { /* best effort */ }

    await writeModeState({ mode: id, at: new Date().toISOString() });
    send({ type: 'mode-progress', mode: id, phase: 'done', pct: 1 });
    send({ type: 'mode-done', mode: id, ok: failed.length === 0, failed });
    return { ok: failed.length === 0, mode: id, failed, root };
  } catch (e) {
    send({ type: 'mode-done', mode: id, ok: false, error: e.message });
    return { ok: false, error: e.message };
  } finally {
    try { await fs.promises.rm(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Downloads and opens the CloudRedirect GUI manager (the Mode page's Manage). */
async function manageCloudRedirect(emit) {
  const send = (evt) => { try { emit && emit(evt); } catch { /* ignore */ } };
  const dir = path.join(require('electron').app.getPath('userData'), 'cloudredirect');
  const exe = path.join(dir, 'CloudRedirect.exe');
  if (!fs.existsSync(exe)) {
    try {
      const rel = await ghJson(`https://api.github.com/repos/${CLOUD_REDIRECT_REPO}/releases/latest`);
      const asset = (rel.assets || []).find((a) => /^CloudRedirect\.exe$/i.test(a.name));
      if (!asset) return { ok: false, error: 'No CloudRedirect.exe asset in that release' };
      await fs.promises.mkdir(dir, { recursive: true });
      send({ type: 'mode-progress', phase: 'download', pct: 0 });
      await ghDownload(asset.browser_download_url || asset.download_url, exe);
      send({ type: 'mode-progress', phase: 'done', pct: 1 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  try {
    const { execFile } = require('child_process');
    execFile(exe, [], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, exe: exe };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Pins whose manifest Steam does not have in its depotcache are dead: Steam
 * prunes what it does not recognise, and the download keys alone are not
 * enough. Fetch every missing pin from the public manifest backend, into the
 * ROOT depotcache (Steam's own), the way the LuaTools client does.
 */
async function repairManifests() {
  const scan = await luatools.scan().catch(() => ({ steam: [] }));
  const rows = (scan.steam || []).filter((u) => u.primary);
  const repaired = [];
  for (const u of rows) {
    for (const f of (u.files || [])) {
      for (const pin of (f.pins || [])) {
        if (pin.cached) continue;
        try {
          const file = await fetchDepotManifest(pin.depot, pin.manifest, u.depotcache);
          repaired.push({ ok: true, depot: pin.depot, manifest: pin.manifest, file });
        } catch (e) {
          repaired.push({ ok: false, depot: pin.depot, manifest: pin.manifest, error: e.message });
        }
      }
    }
  }
  return { ok: true, repaired };
}

// ===========================================================================
// Uninstall one applied game: the delete button behind "uninstall the game."
//   - comment every addappid / setManifestid line of its lua out (the format's
//     "off"), so the unlocker stops presenting the app to Steam
//   - delete the seeded appmanifest_*_.acf Apex wrote, but never a manifest
//     Steam itself wrote (a real, played install keeps its LastUpdated)
//   - prune the depotcache manifests this app's depots own, when no other
//     applied file still refers to the same depot
// ===========================================================================

/**
 * Reads one ACF and says whether Apex seeded it (Steam-written manifests of
 * real installs carry a real LastUpdated and real installdir; Apex stamps 0
 * and the "App <id>" placeholder).
 */
function apexSeeded(file, appid) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const stamp = /"LastUpdated"\s+"(\d+)"/.exec(text);
    const dir = /"installdir"\s+"([^"]*)"/.exec(text);
    if (stamp && stamp[1] !== '0') return false;
    if (dir && dir[1] && !new RegExp(`^App\\s*${appid}\\b`, 'i').test(dir[1])) return false;
    return true;
  } catch { return false; }
}

/**
 * Removes an applied app id everywhere Apex put it.
 * @param {string|number} appId
 */
async function uninstallApp(appId) {
  const id = String(appId || '').replace(/[^0-9]/g, '');
  if (!id) return { ok: false, error: 'No app id given' };

  const scan = await luatools.scan().catch(() => ({ steam: [] }));
  const rows = (scan.steam || []).filter((u) => u.primary);
  let targetUser = null;
  let targetFile = null;
  let depots = [];
  for (const u of rows) {
    for (const f of (u.files || [])) {
      if ((f.appids || []).includes(id)) {
        targetUser = u;
        targetFile = path.join(u.plugins, f.name);
        depots = (f.depots || []).map(String);
        break;
      }
    }
    if (targetFile) break;
  }

  const result = {
    ok: true,
    appid: id,
    file: targetFile || null,
    lua: null,
    manifests: [],
    depotcache: []
  };

  // 1. Comment the lua lines out (a comment is how the lua format says "off").
  if (targetFile) {
    const ids = Array.from(new Set([id, ...depots]));
    for (const d of ids) {
      const r = await editLua({ file: targetFile, op: 'removeDepot', depot: d });
      if (!result.lua && r) result.lua = r;
    }
    const pins = (rows.flatMap((u) => (u.files || [])).find((f) => path.join(targetUser.plugins, f.name) === path.resolve(targetFile)) || {}).pins || [];
    for (const p of pins) {
      try { await editLua({ file: targetFile, op: 'lock', depot: p.depot }); } catch { /* commented already */ }
    }
  }

  // 2. The library entry: only the ACF Apex seeded dies, never a real install.
  const drives = require('./drives');
  const libs = await drives.steamLibraries().catch(() => []);
  for (const lib of libs) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${id}.acf`);
    if (!fs.existsSync(manifest)) continue;
    if (!apexSeeded(manifest, id)) continue;
    try {
      const r = drives.removeManifest(manifest);
      result.manifests.push({ file: manifest, ok: !!(r && r.ok) });
    } catch (e) {
      result.manifests.push({ file: manifest, ok: false, error: e.message });
    }
  }

  // 3. Cached depots this app stops needing - but only when no other applied
  //    file still names the depot.
  const otherDepots = new Set();
  for (const u of rows) {
    for (const f of (u.files || [])) {
      if (targetFile && path.resolve(path.join(u.plugins, f.name)) === path.resolve(targetFile)) continue;
      for (const d of (f.depots || [])) otherDepots.add(String(d));
      for (const a of (f.appids || [])) otherDepots.add(String(a));
    }
  }
  for (const u of rows) {
    const cache = u.depotcache;
    if (!fs.existsSync(cache)) continue;
    for (const d of [id, ...depots]) {
      if (otherDepots.has(String(d))) continue;
      let rows2 = [];
      try { rows2 = fs.readdirSync(cache); } catch { continue; }
      for (const n of rows2) {
        if (!n.startsWith(`${d}_`) || !/\.manifest$/i.test(n)) continue;
        try {
          fs.unlinkSync(path.join(cache, n));
          result.depotcache.push(n);
        } catch { /* locked or gone */ }
      }
    }
  }

  // Steam rewrites appmanifests and prunes depotcache while it runs, so the
  // result only settles after a restart. Reported, not enforced.
  result.steamRunning = await drives.steamRunning().catch(() => false);
  return result;
}

module.exports = {
  parseLuaDetails, readLua, editLua,
  ensureDownloader, downloaderStatus, downloadDepots, cancelDepots,
  modes, setMode, manageCloudRedirect,
  fetchDepotManifest, repairManifests, uninstallApp,
  // internals kept for tests
  _toggleLines: toggleLines, _parse: parseLuaDetails
};
