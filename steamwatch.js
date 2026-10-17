'use strict';

/**
 * Live Steam download state (main process, strictly read-only).
 *
 * Steam keeps a real, machine-readable record of every install: the
 * `appmanifest_<appid>.acf` file inside whichever library is receiving it.
 * While a transfer is running Steam rewrites `BytesDownloaded`,
 * `BytesToDownload` and `BytesStaged` in that file - the same numbers its own
 * download page draws from.
 *
 * So Apex can show a genuine percentage for a Steam install it handed off,
 * instead of guessing. Nothing in this file writes to Steam.
 */

const fs = require('fs');
const path = require('path');

const detect = require('./detect');

const isWin = process.platform === 'win32';

/** `"Key"  "123"` -> 123 (null when absent). */
function numField(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*"(-?\\d+)"`));
  return m ? Number(m[1]) : null;
}

/** `"Key"  "text"` -> text. */
function strField(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

/** Is Steam actively writing files into `steamapps/downloading/<appid>/`? */
function downloadingActive(appsDir, appid) {
  try {
    return fs.readdirSync(path.join(appsDir, 'downloading', String(appid))).length > 0;
  } catch {
    return false;
  }
}

/**
 * Turns one appmanifest into the compact record the renderer paints from.
 *
 * Progress is only reported when Steam actually has both byte counters, so an
 * install whose size Steam has not worked out yet stays indeterminate rather
 * than showing a made-up percentage.
 */
function parseManifest(text, appid, library) {
  const flags = numField(text, 'StateFlags') || 0;
  const toDownload = numField(text, 'BytesToDownload') || 0;
  const downloaded = numField(text, 'BytesDownloaded') || 0;
  const toStage = numField(text, 'BytesToStage') || 0;
  const staged = numField(text, 'BytesStaged') || 0;
  const onDisk = numField(text, 'SizeOnDisk') || 0;
  const staging = numField(text, 'StagingSize') || 0;

  const installed = (flags & 4) === 4;
  const updating = (flags & 2) === 2;

  // A download has two phases and Steam tracks both. Watching only the download
  // counter made a staged-heavy install look stuck near 0%, so blend the pair
  // the way Steam's own "overall" figure does, and fall back to whichever pair
  // the app actually publishes.
  let pct = null;
  if (toDownload > 0 && toStage > 0) pct = ((downloaded + staged) / (toDownload + toStage)) * 100;
  else if (toDownload > 0) pct = (downloaded / toDownload) * 100;
  else if (toStage > 0) pct = (staged / toStage) * 100;
  if (pct != null) pct = Math.min(100, Math.max(0, pct));

  const running = (toDownload > 0 && downloaded < toDownload) || (toStage > 0 && staged < toStage);
  const hasCounters = toDownload > 0 || toStage > 0;

  return {
    appid: String(appid),
    name: strField(text, 'name'),
    library,
    flags,
    installed,
    updating,
    toDownload,
    downloaded,
    toStage,
    staged,
    onDisk,
    staging,
    pct,
    active: running,
    hasCounters,
    updatedAt: numField(text, 'LastUpdated') || 0
  };
}

/**
 * Every app Steam currently knows about, keyed by appid.
 *
 * @returns {Promise<{ok:boolean, at:number, apps:Record<string, object>}>}
 */
async function steamProgress() {
  const empty = { ok: false, at: Date.now(), apps: {} };
  if (!isWin) return empty;

  let roots = [];
  try {
    roots = await detect.findSteamRoots();
  } catch {
    return empty;
  }
  if (!roots.length) return empty;

  // Every library across every root, de-duplicated by normalised path.
  const libs = new Map();
  for (const root of roots) {
    let found = [];
    try { found = detect.steamLibraries(root); } catch { /* skip */ }
    for (const lib of found) libs.set(path.normalize(lib).toLowerCase(), lib);
  }

  const apps = {};
  for (const lib of libs.values()) {
    const appsDir = path.join(lib, 'steamapps');

    let names = [];
    try { names = fs.readdirSync(appsDir).filter((n) => /^appmanifest_\d+\.acf$/i.test(n)); } catch { /* not a library */ }

    for (const name of names) {
      const appid = name.match(/(\d+)/)[1];
      let text;
      try { text = fs.readFileSync(path.join(appsDir, name), 'utf8'); } catch { continue; }
      const rec = parseManifest(text, appid, lib);
      if (rec.installed && !rec.updating) {
        rec.state = 'installed';
        rec.active = false;
      } else if (downloadingActive(appsDir, appid)) {
        rec.active = true;
        rec.state = 'downloading';
      } else if (rec.active) {
        rec.state = 'downloading';
      } else if (rec.hasCounters) {
        rec.state = 'queued';
      } else {
        // Pre-registered but Steam has not published any sizes yet.
        rec.state = 'preparing';
      }
      apps[appid] = rec;
    }

    // A queued install can appear in `downloading/` before its manifest does.
    let dl = [];
    try { dl = fs.readdirSync(path.join(appsDir, 'downloading'), { withFileTypes: true }); } catch { /* none */ }
    for (const ent of dl) {
      if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
      if (apps[ent.name]) continue;
      apps[ent.name] = {
        appid: ent.name,
        name: null,
        library: lib,
        flags: 0,
        installed: false,
        updating: true,
        toDownload: 0,
        downloaded: 0,
        toStage: 0,
        staged: 0,
        onDisk: 0,
        staging: 0,
        pct: null,
        active: true,
        hasCounters: false,
        state: 'downloading',
        updatedAt: 0
      };
    }
  }

  return { ok: true, at: Date.now(), apps };
}

module.exports = { steamProgress };
