'use strict';

/**
 * Real uninstalls (main process).
 *
 * Two very different things are called "removing a game", and the UI is careful
 * to keep them apart:
 *
 *   - *Remove from library* is a renderer-only change. Nothing on disk moves.
 *   - *Uninstall* deletes the game's files, and that is what this module owns.
 *
 * The renderer never tells this module which folder to delete. It asks about a
 * game id and the candidate paths are re-derived here from Apex's own state file,
 * so a bug in the UI (or a hand-crafted IPC call) can never aim a recursive
 * delete at an arbitrary directory. Every candidate is then put through
 * `safeTarget()`, which refuses drive roots, system folders, user-profile roots
 * and folders that another launcher owns (a Steam library, an Epic install) —
 * those are handed back to their store instead.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

let deps = {
  getState: () => ({}),
  userDataDir: os.tmpdir(),
  appDir: __dirname
};

function init(next) {
  deps = { ...deps, ...(next || {}) };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Folders that must never be deleted, and never be an ancestor of something we
 * delete. Apex's own default games folder lives under Documents, so Documents
 * itself is protected while a child of it is fair game — that is what the depth
 * rule below is for.
 */
function protectedRoots() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const list = [
    deps.appDir,
    deps.userDataDir,
    home,
    path.dirname(deps.userDataDir),
    os.tmpdir(),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Pictures'),
    path.join(home, 'Videos'),
    path.join(home, 'Music'),
    path.join(home, 'OneDrive'),
    'C:\\Users',
    'C:\\'
  ];
  if (win) {
    list.push(
      process.env.WINDIR || 'C:\\Windows',
      process.env.ProgramFiles || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env.ProgramData || 'C:\\ProgramData',
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    );
  }
  return list.filter(Boolean).map((p) => normalize(p));
}

function normalize(p) {
  try {
    return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

/** True when `child` is `parent` or sits underneath it. */
function isInside(child, parent) {
  const c = normalize(child);
  const p = normalize(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + path.sep);
}

/** Path segments below the drive root: `C:\A` is 1, `C:\A\B` is 2. */
function depthOf(p) {
  const rel = path.relative(path.parse(path.resolve(p)).root, path.resolve(p));
  return rel ? rel.split(path.sep).filter(Boolean).length : 0;
}

/** A folder another launcher owns; deleting it behind that launcher's back breaks it. */
function foreignStoreMarker(dir) {
  const markers = [
    { name: 'steamapps', store: 'steam' },
    { name: '.egstore', store: 'epic' },
    { name: '.goggame', store: 'gog' },
    { name: '.ubi', store: 'ubisoft' },
    { name: '.bfa', store: 'battlenet' }
  ];
  for (const m of markers) {
    try {
      if (fs.existsSync(path.join(dir, m.name))) return m.store;
    } catch { /* unreadable: fall through to the other markers */ }
  }
  try {
    if (fs.readdirSync(dir).some((n) => /^appmanifest_\d+\.acf$/i.test(n))) return 'steam';
  } catch { /* not a directory, or no permission */ }
  return null;
}

/**
 * The gate every delete target must pass.
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
function safeTarget(target) {
  if (!target || typeof target !== 'string') return { ok: false, reason: 'No folder to delete' };

  let resolved;
  try {
    resolved = path.resolve(target);
  } catch {
    return { ok: false, reason: 'That path cannot be resolved' };
  }

  if (resolved === path.parse(resolved).root) return { ok: false, reason: 'That is a whole drive' };
  if (depthOf(resolved) < 2) {
    return { ok: false, reason: `${resolved} is too close to the drive root to delete safely` };
  }

  // Never the thing itself, and never a folder that contains it.
  for (const guarded of protectedRoots()) {
    if (!guarded) continue;
    if (normalize(resolved) === guarded) {
      return { ok: false, reason: `Refusing to delete the protected folder ${resolved}` };
    }
    if (isInside(guarded, resolved)) {
      return { ok: false, reason: `Refusing to delete ${resolved}: it contains ${guarded}` };
    }
  }

  if (!fs.existsSync(resolved)) return { ok: false, reason: 'That folder is already gone' };

  const store = foreignStoreMarker(resolved);
  if (store) {
    return { ok: false, reason: `This is a ${store} install folder — uninstall it from ${store} instead` };
  }

  return { ok: true, path: resolved };
}

// ---------------------------------------------------------------------------
// Where a game actually lives
// ---------------------------------------------------------------------------

/**
 * The candidate paths for one game, in priority order.
 *
 * `State.installDirs` is written by the download pipeline and holds exactly the
 * folder Apex created, which is the only thing Apex should ever delete on its
 * own. `State.local.installs[].path` is where the game was *found* — a store
 * library, usually — and is only offered when it is not store-owned.
 */
function candidates(id, state) {
  const out = [];
  const link = (state.local && state.local.installs && state.local.installs[id]) || null;
  const recorded = (state.installDirs && state.installDirs[id]) || null;

  if (recorded) out.push({ path: recorded, origin: 'apex' });

  const store = link && link.source && link.source !== 'apex' && link.source !== 'local' ? link.source : null;
  if (link && link.path && !store) out.push({ path: link.path, origin: link.type === 'exe' ? 'linked' : 'detected' });

  // De-duplicate (a detected install and a recorded one are often the same path).
  const seen = new Set();
  return { store, paths: out.filter((p) => { const k = normalize(p.path); if (!k || seen.has(k)) return false; seen.add(k); return true; }) };
}

/** A bounded recursive size, so a 150 GB install cannot stall the dialog. */
async function dirSize(dir, budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let files = 0;
  let truncated = false;

  const walk = async (d) => {
    if (Date.now() > deadline) { truncated = true; return; }
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (Date.now() > deadline) { truncated = true; return; }
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { await walk(full); continue; }
      try { bytes += (await fsp.stat(full)).size; files++; } catch { /* vanished mid-walk */ }
    }
  };

  let stat;
  try { stat = await fsp.stat(dir); } catch { return { bytes: 0, files: 0, truncated: false, missing: true }; }
  if (stat.isFile()) return { bytes: stat.size, files: 1, truncated: false, missing: false };

  await walk(dir);
  return { bytes, files, truncated, missing: false };
}

/**
 * What an uninstall of this game would do, without doing it.
 *
 * @returns {Promise<object>} `{ ok, store, canDelete, paths:[{path, bytes, blocked, reason}], bytes }`
 */
async function plan(id, state = deps.getState()) {
  const { store, paths } = candidates(id, state);
  const checked = [];

  for (const cand of paths) {
    const safe = safeTarget(cand.path);
    const size = safe.ok ? await dirSize(cand.path) : { bytes: 0, files: 0, truncated: false };
    checked.push({
      path: safe.ok ? safe.path : cand.path,
      origin: cand.origin,
      bytes: size.bytes,
      files: size.files,
      // A size that ran out of budget is reported as a floor, never as exact.
      approximate: !!size.truncated,
      exists: !size.missing,
      blocked: !safe.ok,
      reason: safe.ok ? null : safe.reason
    });
  }

  const deletable = checked.filter((c) => !c.blocked);
  return {
    ok: true,
    store,
    paths: checked,
    bytes: deletable.reduce((sum, c) => sum + c.bytes, 0),
    canDelete: deletable.length > 0,
    // Why nothing is deletable, so the dialog can explain itself.
    reason: deletable.length ? null : (checked[0] ? checked[0].reason : (store
      ? `${store} owns these files`
      : 'Apex does not know where this game was installed'))
  };
}

/**
 * Deletes the game's files. Paths come from state, never from the caller.
 *
 * @returns {Promise<{ok:boolean, freed:number, removed:string[], blocked:object[], errors:object[]}>}
 */
async function remove(id, state = deps.getState()) {
  const { paths } = candidates(id, state);
  const removed = [];
  const blocked = [];
  const errors = [];
  let freed = 0;

  for (const cand of paths) {
    const safe = safeTarget(cand.path);
    if (!safe.ok) { blocked.push({ path: cand.path, reason: safe.reason }); continue; }

    const size = await dirSize(safe.path);
    try {
      await fsp.rm(safe.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      removed.push(safe.path);
      freed += size.bytes;
    } catch (err) {
      errors.push({ path: safe.path, error: (err && err.message) || String(err) });
    }
  }

  return {
    ok: errors.length === 0,
    freed,
    removed,
    blocked,
    errors
  };
}

/**
 * The store's own uninstaller deep link, for content Apex merely detected.
 * Silence from a store we have no trigger for is honest: the caller falls back
 * to telling the user to remove it there.
 */
function storeUri(id, state = deps.getState()) {
  const { store } = candidates(id, state);
  const link = (state.local && state.local.installs && state.local.installs[id]) || null;
  const appId = String((link && link.appId) || '').trim();

  if (store === 'steam' && /^\d{1,12}$/.test(appId)) return { ok: true, uri: `steam://uninstall/${appId}`, store };
  if (store === 'epic') {
    // Detected Epic links carry the three ids inside the launch URI, not as
    // separate fields (see detect.js), so unpack it the same way the renderer does.
    const m = String((link && link.uri) || '').match(/com\.epicgames\.launcher:\/\/apps\/([^?/]+)/);
    const parts = m ? decodeURIComponent(m[1]).split(':').filter(Boolean) : [];
    if (parts.length >= 2) {
      const ids = parts[2] ? `${parts[0]}%3A${parts[1]}%3A${parts[2]}` : `${parts[0]}%3A${parts[1]}`;
      return { ok: true, uri: `com.epicgames.launcher://apps/${ids}?action=uninstall`, store };
    }
  }
  return { ok: false, store };
}

module.exports = { init, plan, remove, storeUri, safeTarget, candidates, dirSize, protectedRoots };
