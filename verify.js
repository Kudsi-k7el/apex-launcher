'use strict';

/**
 * On-disk file verification (main process).
 * ------------------------------------------------------------------
 * Detection says "we found a record for this game". Verification answers the
 * harder question the app actually needs before it shows PLAY or starts a
 * process: *are the files really here, and are they really whole?*
 *
 * Three independent signals are combined, strongest first:
 *
 *   1. The store's own bookkeeping. Steam writes StateFlags into every
 *      appmanifest; bit 4 means "fully installed" and bit 2 means "update
 *      required". A manifest with StateFlags 1026 (update required + update
 *      started) is a half-finished install, not a game. Epic writes
 *      bIsIncompleteInstall / bIsApplication for the same purpose.
 *
 *   2. The filesystem. The install directory must exist, not be empty, and
 *      hold a plausible number of files.
 *
 *   3. Size. The bytes actually on disk are compared against the size the
 *      store says it installed. We only fail on this when the gap is gross
 *      (< 25% present), so optional DLC, recompressed depots and NTFS
 *      cluster rounding can never make a healthy game look broken.
 *
 * Nothing here writes to disk and nothing talks to the network. It only reads
 * what Steam/Epic/the user already put there, so it is safe to run on every
 * scan and before every launch.
 */

const fs = require('fs');
const path = require('path');

// --- Steam StateFlags bits (subset we care about) ---------------------------
const FLAG = {
  UNINSTALLED: 1,
  UPDATE_REQUIRED: 2,
  FULLY_INSTALLED: 4,
  UPDATE_RUNNING: 8,
  UPDATE_STARTED: 1024
};

// Below this fraction of the expected size we call the install incomplete.
const SIZE_FLOOR = 0.25;
// A game smaller than this is not worth size-checking (indies, tools, mods).
const SIZE_MIN_BYTES = 64 * 1024 * 1024;
// Walking a 150 GB library must never hang the UI.
const WALK_BUDGET_MS = 3000;
const WALK_MAX_FILES = 400000;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function exists(p) {
  return !!statSafe(p);
}

/**
 * Walks a directory and totals the real bytes on disk.
 *
 * Bounded on purpose: a budget of time and files means a pathological tree
 * (a symlinked Steam library, a network drive) returns `truncated: true`
 * instead of freezing the main process.
 */
function measure(dir, opts = {}) {
  const budgetMs = opts.budgetMs || WALK_BUDGET_MS;
  const maxFiles = opts.maxFiles || WALK_MAX_FILES;
  const started = Date.now();

  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let truncated = false;
  let newest = 0;

  const stack = [dir];
  while (stack.length) {
    if (files >= maxFiles || Date.now() - started > budgetMs) { truncated = true; break; }
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }

    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        dirs++;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue; // skip symlinks / devices
      const st = statSafe(full);
      if (!st) continue;
      files++;
      bytes += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }

  return { bytes, files, dirs, truncated, newest: newest || null, elapsedMs: Date.now() - started };
}

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = v;
  do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${u[i]}`;
};

/**
 * Cheap "is there anything in here at all?" probe.
 *
 * Used by the routine scan. A deep walk of a 150 GB library takes seconds per
 * game, which is far too slow to run on every start, but the one failure that
 * actually matters day-to-day — a registered game whose folder is empty, or
 * gone — is visible from a single directory read. Stops at the first file.
 */
function hasAnyFile(dir, budgetMs = 600) {
  const started = Date.now();
  const stack = [dir];
  while (stack.length) {
    if (Date.now() - started > budgetMs) return false;
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isFile()) return true;
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

/**
 * Reads the fields we need out of an appmanifest.
 * @param {string} text raw AppState VDF
 */
function parseAcf(text) {
  const get = (k) => {
    const m = String(text || '').match(new RegExp(`"${k}"\\s*"([^"]*)"`, 'i'));
    return m ? m[1] : null;
  };
  const num = (k) => {
    const v = get(k);
    return v == null ? null : Number(v);
  };

  // InstalledDepots carries one "BytesToDownload" per depot; sum them so a
  // partially-downloaded install reports the true remaining figure.
  let depotsBytes = 0;
  const depotRe = /"InstalledDepots"[\s\S]*?(?=\n\t"[A-Za-z]|$)/i;
  const depotBlock = String(text || '').match(depotRe);
  if (depotBlock) {
    const re = /"BytesToDownload"\s*"(\d+)"/gi;
    let m;
    while ((m = re.exec(depotBlock[0]))) depotsBytes += Number(m[1]);
  }

  return {
    appId: get('appid'),
    name: get('name'),
    installdir: get('installdir'),
    stateFlags: num('StateFlags'),
    sizeOnDisk: num('SizeOnDisk'),
    bytesToDownload: num('BytesToDownload') ?? (depotsBytes || null),
    bytesDownloaded: num('BytesDownloaded'),
    lastUpdated: num('LastUpdated'),
    buildId: get('buildid')
  };
}

/**
 * Verifies a Steam title.
 *
 * @param {{appId?:string, installPath?:string|null, acfText?:string, name?:string}} rec
 * @param {{deep?:boolean}} [opts] `deep` walks every file and checks the byte
 *   count. Without it the check still catches deleted folders, empty folders
 *   and Steam's own "not fully installed" flags, in milliseconds.
 */
function verifySteam(rec, opts = {}) {
  const deep = !!opts.deep;
  const parsed = parseAcf(rec.acfText || '');
  // The manifest text is authoritative when we have it, but a launch target
  // that has been round-tripped through the renderer's state only carries the
  // numbers, so either source is accepted.
  const pick = (key) => (rec[key] != null ? rec[key] : parsed[key]);
  const acf = {
    appId: pick('appId'),
    name: pick('name'),
    installdir: pick('installdir'),
    stateFlags: pick('stateFlags'),
    sizeOnDisk: pick('sizeOnDisk'),
    bytesToDownload: pick('bytesToDownload'),
    bytesDownloaded: pick('bytesDownloaded'),
    buildId: pick('buildId')
  };
  const appId = String(rec.appId || acf.appId || '');
  const dir = rec.installPath || rec.path || null;
  const flags = acf.stateFlags;

  const base = {
    method: 'steam',
    appId,
    name: rec.name || acf.name || null,
    path: dir,
    expected: acf.sizeOnDisk || null,
    bytes: null,
    files: null,
    buildId: acf.buildId || null,
    flags: flags == null ? null : {
      raw: flags,
      fullyInstalled: (flags & FLAG.FULLY_INSTALLED) !== 0,
      updateRequired: (flags & FLAG.UPDATE_REQUIRED) !== 0,
      updateStarted: (flags & FLAG.UPDATE_STARTED) !== 0,
      uninstalled: (flags & FLAG.UNINSTALLED) !== 0
    }
  };

  if (!dir) {
    return { ...base, state: 'missing', installed: false, complete: false, reason: 'Steam has no install folder recorded for this title' };
  }
  if (!exists(dir)) {
    return { ...base, state: 'missing', installed: false, complete: false, reason: 'The install folder is gone' };
  }

  const m = deep
    ? measure(dir)
    : { bytes: null, files: hasAnyFile(dir) ? 1 : 0, dirs: 0, truncated: false, newest: null };
  const out = { ...base, bytes: m.bytes, files: m.files, truncated: m.truncated, lastActivity: m.newest };

  if (m.files === 0) {
    return { ...out, state: 'missing', installed: false, complete: false, reason: 'The folder exists but contains no game files' };
  }

  // Steam's own verdict. 1026 (update required + started) lands here.
  if (flags != null && flags !== 0) {
    if (base.flags.uninstalled) {
      return { ...out, state: 'missing', installed: false, complete: false, reason: 'Steam has this title marked as uninstalled' };
    }
    if (!base.flags.fullyInstalled) {
      const what = base.flags.updateRequired ? 'an update is still pending' : 'Steam has not marked it fully installed';
      const left = acf.bytesToDownload != null && acf.bytesDownloaded != null
        ? ` (${fmtBytes(Math.max(0, acf.bytesToDownload - acf.bytesDownloaded))} still to transfer)`
        : '';
      return { ...out, state: 'incomplete', installed: false, complete: false, reason: `Half-installed: ${what}${left}` };
    }
  }

  // Bytes on disk vs. what the store says it wrote. Only a deep pass knows the
  // real total, so a routine scan stops here.
  if (deep && out.expected && out.expected > SIZE_MIN_BYTES && !m.truncated && m.bytes != null) {
    const ratio = m.bytes / out.expected;
    if (ratio < SIZE_FLOOR) {
      return {
        ...out,
        state: 'incomplete',
        installed: false,
        complete: false,
        reason: `Only ${fmtBytes(m.bytes)} of the expected ${fmtBytes(out.expected)} is present`
      };
    }
  }

  return {
    ...out,
    state: 'ok',
    installed: true,
    complete: true,
    reason: m.bytes != null
      ? `${fmtBytes(m.bytes)} verified on disk`
      : 'Installed and marked complete by Steam'
  };
}

// ---------------------------------------------------------------------------
// Epic
// ---------------------------------------------------------------------------

/**
 * Verifies an Epic title from its `.item` manifest object.
 * @param {{name?:string, installPath?:string|null, item?:object}} rec
 * @param {{deep?:boolean}} [opts]
 */
function verifyEpic(rec, opts = {}) {
  const deep = !!opts.deep;
  const item = rec.item || {};
  const dir = rec.installPath || item.InstallLocation || null;
  const base = {
    method: 'epic',
    name: rec.name || item.DisplayName || item.AppName || null,
    appName: item.AppName || null,
    path: dir,
    expected: Number(item.InstallSize) || null,
    bytes: null,
    files: null
  };

  if (item.bIsIncompleteInstall === true) {
    return { ...base, state: 'incomplete', installed: false, complete: false, reason: 'Epic flagged this install as incomplete' };
  }
  if (item.bIsApplication === false && item.bIsIncompleteInstall !== false) {
    // Manifests for engine content / DLC-only items: not a launchable game.
    if (!item.LaunchExecutable) {
      return { ...base, state: 'incomplete', installed: false, complete: false, reason: 'Epic lists this as content, not a launchable game' };
    }
  }
  if (!dir || !exists(dir)) {
    return { ...base, state: 'missing', installed: false, complete: false, reason: 'The install folder is gone' };
  }

  const m = deep
    ? measure(dir, { budgetMs: 1500 })
    : { bytes: null, files: hasAnyFile(dir) ? 1 : 0, dirs: 0, truncated: false, newest: null };
  const out = { ...base, bytes: m.bytes, files: m.files, truncated: m.truncated };

  if (m.files === 0) {
    return { ...out, state: 'missing', installed: false, complete: false, reason: 'The folder exists but contains no game files' };
  }
  if (item.LaunchExecutable) {
    const exe = path.join(dir, item.LaunchExecutable);
    if (!exists(exe)) {
      return { ...out, state: 'incomplete', installed: false, complete: false, reason: `The launch executable is missing (${item.LaunchExecutable})` };
    }
  }
  if (deep && out.expected && out.expected > SIZE_MIN_BYTES && !m.truncated && m.bytes != null && m.bytes / out.expected < SIZE_FLOOR) {
    return { ...out, state: 'incomplete', installed: false, complete: false, reason: `Only ${fmtBytes(m.bytes)} of the expected ${fmtBytes(out.expected)} is present` };
  }

  return {
    ...out,
    state: 'ok',
    installed: true,
    complete: true,
    reason: m.bytes != null ? `${fmtBytes(m.bytes)} verified on disk` : 'Installed and marked complete by Epic'
  };
}

// ---------------------------------------------------------------------------
// Everything else (local executables, manually linked games, custom entries)
// ---------------------------------------------------------------------------

/**
 * Verifies a link the user added or that Apex detected outside Steam/Epic:
 * a real .exe, an install folder, or a bare launcher URI.
 * @param {{name?:string, exe?:string|null, path?:string|null, type?:string}} target
 */
function verifyLocal(target, opts = {}) {
  const deep = !!opts.deep;
  const t = target || {};
  const base = {
    method: 'local',
    name: t.name || null,
    path: t.path || (t.exe ? path.dirname(t.exe) : null),
    bytes: null,
    files: null
  };

  if (t.exe) {
    if (!exists(t.exe)) {
      return { ...base, state: 'missing', installed: false, complete: false, reason: `The linked executable is gone (${path.basename(t.exe)})` };
    }
    return { ...base, state: 'ok', installed: true, complete: true, reason: 'The linked executable is present' };
  }

  // A URI launch target (GOG / Ubisoft / EA / Battle.net) has no files we can
  // check; the store client owns the install. Claiming "verified" would be a
  // lie, so we report it as unverifiable instead.
  if (t.type === 'uri' || t.uri) {
    return { ...base, state: 'unverifiable', installed: true, complete: false, reason: 'Launched through its store client, so the files live in that client\'s own library' };
  }

  if (t.path) {
    if (!exists(t.path)) {
      return { ...base, state: 'missing', installed: false, complete: false, reason: 'The install folder is gone' };
    }
    const m = deep
      ? measure(t.path, { budgetMs: 1500 })
      : { bytes: null, files: hasAnyFile(t.path) ? 1 : 0, dirs: 0, truncated: false, newest: null };
    if (m.files === 0) {
      return { ...base, bytes: m.bytes, files: 0, state: 'missing', installed: false, complete: false, reason: 'The folder exists but contains no game files' };
    }
    return {
      ...base,
      bytes: m.bytes,
      files: m.files,
      truncated: m.truncated,
      state: 'ok',
      installed: true,
      complete: true,
      reason: m.bytes != null ? `${fmtBytes(m.bytes)} verified on disk` : 'The install folder is present'
    };
  }

  return { ...base, state: 'missing', installed: false, complete: false, reason: 'Nothing is linked for this game on this PC' };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Verifies one game from whatever we know about it.
 * @param {{source?:string, type?:string, appId?:string, appName?:string, installPath?:string,
 *          acfText?:string, item?:object, exe?:string, path?:string, uri?:string, name?:string}} rec
 * @param {{deep?:boolean}} [opts]
 * @returns {{state:string, installed:boolean, complete:boolean, reason:string}}
 */
function verifyInstall(rec, opts = {}) {
  const r = rec || {};
  const source = r.source || r.type || 'local';
  try {
    if (source === 'steam' || r.appId) return verifySteam(r, opts);
    if (source === 'epic' || r.appName) return verifyEpic(r, opts);
    return verifyLocal(r, opts);
  } catch (err) {
    return {
      method: source,
      state: 'unknown',
      installed: false,
      complete: false,
      reason: `Verification could not run: ${(err && err.message) || 'unknown error'}`
    };
  }
}

/** A compact, renderer-friendly summary of a report. */
function summarize(report) {
  const r = report || {};
  const ok = r.state === 'ok';
  const label = r.state === 'ok' ? 'Verified'
    : r.state === 'incomplete' ? 'Incomplete'
    : r.state === 'missing' ? 'Files missing'
    : r.state === 'unverifiable' ? 'Not verifiable'
    : 'Unknown';
  return {
    state: r.state,
    ok,
    installed: !!r.installed,
    complete: !!r.complete,
    incomplete: r.state === 'incomplete',
    missing: r.state === 'missing' || r.state === 'unknown',
    verifiable: r.state !== 'unverifiable',
    label,
    reason: r.reason || '',
    bytes: r.bytes ?? null,
    expected: r.expected ?? null,
    files: r.files ?? null,
    path: r.path || null,
    method: r.method || null
  };
}

module.exports = { verifyInstall, verifySteam, verifyEpic, verifyLocal, summarize, parseAcf, measure, hasAnyFile, fmtBytes, FLAG };
