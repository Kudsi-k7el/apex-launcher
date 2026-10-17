'use strict';

/**
 * Drives & install locations (main process).
 *
 * Everything here is read-only or explicitly opt-in:
 *   - `listDrives()` enumerates the fixed/removable volumes on this PC with
 *     their real free space, so the installer can offer the same "which drive?"
 *     choice a store client does.
 *   - `steamLibraries()` reports the library folders Steam already knows about.
 *   - `addSteamLibrary()` is the only write in this file. It appends one folder
 *     to Steam's own `steamapps/libraryfolders.vdf` - the exact thing Steam does
 *     itself under Settings > Storage - and it backs the file up first, refuses
 *     to write anything that would not still parse, and refuses outright while
 *     Steam is running (Steam keeps that file in memory and would overwrite us).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const detect = require('./detect');

const isWin = process.platform === 'win32';

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** Free/total bytes for a mount point, or null when the OS will not say. */
function space(p) {
  try {
    const s = fs.statfsSync(p);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!isFinite(total) || total <= 0) return null;
    return { total, free };
  } catch {
    return null;
  }
}

// Win32_LogicalDisk.DriveType
const DRIVE_TYPE = { 0: 'unknown', 1: 'none', 2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ram' };

/**
 * Volume labels + types in a single PowerShell call. Best-effort: if it is slow
 * or unavailable we still return the drives, just without a friendly name.
 *
 * The command is passed base64-encoded (-EncodedCommand) because PowerShell
 * mangles the quotes in a plain -Command argument when it is spawned from Node.
 */
function volumeInfo() {
  return new Promise((resolve) => {
    if (!isWin) return resolve({});
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const script = "Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + '|' + $_.VolumeName + '|' + $_.DriveType }";
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded
    ], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return done({});
      const out = {};
      for (const line of String(stdout).split(/\r?\n/)) {
        const [dev, label, type] = line.trim().split('|');
        if (dev && /^[A-Z]:$/i.test(dev)) {
          out[dev.toUpperCase()] = { label: (label || '').trim(), type: Number(type) || 0 };
        }
      }
      done(out);
    });

    // Never let a slow shell hold the drive picker hostage.
    setTimeout(() => done({}), 3000);
  });
}

/** Every drive the user can sensibly install a game onto. */
async function listDrives() {
  const info = await volumeInfo();
  const drives = [];

  if (isWin) {
    for (let c = 65; c <= 90; c++) {          // A: .. Z:
      const letter = String.fromCharCode(c);
      const root = `${letter}:\\`;
      if (!exists(root)) continue;
      const meta = info[`${letter}:`] || {};
      const kind = DRIVE_TYPE[meta.type] || 'fixed';
      if (kind === 'optical') continue;
      const sp = space(root);
      drives.push({
        id: `${letter}:`,
        root,
        name: meta.label || (letter === 'C' ? 'System drive' : 'Local Disk'),
        kind,
        total: sp ? sp.total : 0,
        free: sp ? sp.free : 0
      });
    }
  } else {
    const roots = ['/'];
    try { if (process.env.HOME) roots.push(process.env.HOME); } catch { /* ignore */ }
    for (const root of roots) {
      const sp = space(root);
      drives.push({ id: root, root, name: root === '/' ? 'System' : 'Home', kind: 'fixed', total: sp ? sp.total : 0, free: sp ? sp.free : 0 });
    }
  }

  // Fixed disks first, then by free space.
  return drives.sort((a, b) => (a.kind === 'fixed' ? 0 : 1) - (b.kind === 'fixed' ? 0 : 1) || b.free - a.free);
}

/** The library folders Steam already knows about (de-duplicated). */
async function steamLibraries() {
  if (!isWin) return [];
  try {
    const roots = await detect.findSteamRoots();
    const seen = new Map();
    for (const lib of roots.flatMap((r) => detect.steamLibraries(r))) {
      const key = path.normalize(lib).toLowerCase();
      if (!seen.has(key)) seen.set(key, lib);
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

/**
 * Best-effort "is the process running?" check: runs `image`, and reports
 * whether its output mentions `needle`. Resolves false rather than throwing,
 * because every caller treats unknown as not-running.
 */
function processRunning(image, args, needle) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      execFile(image, args, { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        done(!err && String(stdout || '').toLowerCase().includes(needle.toLowerCase()));
      });
    } catch {
      done(false);
    }
    setTimeout(() => done(false), 3000);
  });
}

/**
 * Is Steam running?
 *
 * This guard is load-bearing: Steam rewrites libraryfolders.vdf when it exits,
 * so a library registered while it is open would be silently thrown away. The
 * old check read `steam.pid`, which current clients no longer write, so it
 * reported "not running" even with Steam wide open. Ask the OS instead and
 * keep the pid file only as a legacy fallback.
 */
async function steamRunning() {
  if (isWin) {
    if (await processRunning('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], 'steam.exe')) return true;
  } else if (await processRunning('pgrep', ['-x', 'steam'], 'steam')) {
    return true;
  }

  try {
    const roots = await detect.findSteamRoots();
    const pidFile = roots.length ? path.join(roots[0], 'steam.pid') : null;
    if (pidFile && exists(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid) {
        process.kill(pid, 0);   // throws when the process is gone
        return true;
      }
    }
  } catch { /* nothing running */ }
  return false;
}

/**
 * Registers `dir` as a Steam library folder, exactly like Steam's own
 * Settings > Storage > "Add Drive" does. Opt-in, backed up, and validated.
 */
async function addSteamLibrary(dir) {
  if (!isWin) return { ok: false, error: 'Steam library folders are Windows-only here.' };
  if (!dir || !exists(dir)) return { ok: false, error: 'That folder does not exist.' };

  const roots = await detect.findSteamRoots();
  if (!roots.length) return { ok: false, error: 'Steam was not found on this PC.' };

  if (await steamRunning()) {
    return { ok: false, error: 'Close Steam first - it rewrites its library list on exit and would undo this.' };
  }

  const file = path.join(roots[0], 'steamapps', 'libraryfolders.vdf');
  if (!exists(file)) return { ok: false, error: 'Steam has no libraryfolders.vdf to update.' };

  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: e.message }; }

  const target = path.normalize(dir).replace(/[\\/]+$/, '');
  const norm = (p) => path.normalize(p.replace(/\\\\/g, '\\')).replace(/[\\/]+$/, '').toLowerCase();
  // Modern format ("path" "D:\\SteamLibrary") plus the legacy numeric form.
  const known = [
    ...[...text.matchAll(/"path"\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/"(?:\d+)"\s*"([A-Za-z]:[^"]*)"/g)].map((m) => m[1])
  ].map(norm);
  if (known.includes(norm(target))) return { ok: true, already: true, file };

  const at = text.lastIndexOf('}');
  if (at < 0) return { ok: false, error: "Steam's library file looks malformed - nothing was changed." };

  const keys = [...text.matchAll(/^\s*"(\d+)"\s*\{/gm)].map((m) => Number(m[1]));
  const next = (keys.length ? Math.max(...keys) : -1) + 1;
  const entry = `\t"${next}"\n\t{\n\t\t"path"\t\t"${target.replace(/\\/g, '\\\\')}"\n\t}\n`;
  const out = text.slice(0, at) + entry + text.slice(at);

  // Refuse to write anything that would not still parse.
  let depth = 0;
  let balanced = true;
  for (const ch of out) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) { balanced = false; break; } }
  }
  if (!balanced || depth !== 0) return { ok: false, error: 'Refusing to write: the result would be malformed.' };

  try {
    if (!exists(`${file}.apex-backup`)) fs.copyFileSync(file, `${file}.apex-backup`);
    fs.writeFileSync(file, out);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, added: true, file, backup: exists(`${file}.apex-backup`) };
}

/**
 * Tells Steam which library to install an app into, so it never has to ask.
 *
 * Steam keys an install off `appmanifest_<appid>.acf`. If that file already
 * exists in a library, Steam reads the app as a queued install *there* and
 * resumes it instead of opening the "choose a drive" dialog. The stub only
 * needs the appid, the universe and `StateFlags 1026` ("update required, and the
 * update was started before") to be believed - the same trick the widely used
 * steam-appmanifest tool relies on.
 *
 * Safety first: the file is only ever created when no library already has it,
 * so nothing Steam owns can be overwritten, and the path is handed back so Apex
 * can delete exactly the one file it created.
 */
async function seedManifest({ appid, installdir, library }) {
  if (!isWin) return { ok: false, error: 'Pre-registering an install is Windows-only here.' };

  const id = String(appid == null ? '' : appid).trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: 'This game has no Steam appid to register.' };
  if (!library) return { ok: false, error: 'No Steam library was chosen.' };

  const libs = await steamLibraries();
  const wanted = path.normalize(library).replace(/[\\/]+$/, '').toLowerCase();
  const home = libs.find((l) => path.normalize(l).replace(/[\\/]+$/, '').toLowerCase() === wanted);
  if (!home) return { ok: false, error: 'That drive is not a Steam library yet.' };

  // Never touch an app Steam already knows about, in any library.
  for (const lib of libs) {
    if (exists(path.join(lib, 'steamapps', `appmanifest_${id}.acf`))) {
      return { ok: false, registered: true, error: 'Steam already has this app on its books.' };
    }
  }

  // Steam names the install folder from the manifest, so keep it filesystem-safe.
  const name = String(installdir || 'Game')
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/[. ]+$/, '')
    .trim() || 'Game';

  const file = path.join(home, 'steamapps', `appmanifest_${id}.acf`);
  if (exists(file)) return { ok: false, registered: true, error: 'Steam already has this app on its books.' };

  const body = `"AppState"
{
\t"AppID"\t\t"${id}"
\t"Universe"\t\t"1"
\t"installdir"\t\t"${name}"
\t"StateFlags"\t\t"1026"
}
`;

  try {
    fs.writeFileSync(file, body);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, file, library: home, installdir: name };
}

/** Undoes seedManifest by deleting only the exact file Apex created. */
function removeManifest(file) {
  try {
    if (!file || !/appmanifest_\d+\.acf$/i.test(String(file))) {
      return { ok: false, error: 'That is not an appmanifest path.' };
    }
    if (!exists(file)) return { ok: true, missing: true };
    fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listDrives, steamLibraries, steamRunning, addSteamLibrary, seedManifest, removeManifest, space };
