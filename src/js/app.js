'use strict';

/**
 * Apex Launcher renderer bootstrap: routing, title-bar wiring, global event
 * delegation, local-game detection and real game launching.
 */

const content = document.getElementById('content');
let current = 'home';

const VIEWS = {
  home: () => renderHome(content),
  store: () => renderStore(content),
  library: () => renderLibrary(content),
  itch: () => renderItch(content),
  lightning: () => renderLightning(content),
  tools: () => renderFixes(content),

  search: () => renderSearch(content),
  detail: () => renderDetail(content),
  downloads: () => renderDownloads(content),
  profile: () => renderProfile(content),
  gallery: () => renderGallery(content),
  contact: () => renderContact(content),
  emulators: () => renderEmulators(content),
  settings: () => renderSettings(content)
};

function render(animate) {
  (VIEWS[current] || VIEWS.store)();
  // Every view writes English, so the translation is applied to whatever the
  // view just produced. One pass per render keeps translations out of the view
  // code entirely - see src/js/i18n.js.
  if (typeof applyI18n === 'function') applyI18n(content);
  if (animate) {
    content.classList.remove('fade', 'view-swap');
    void content.offsetWidth;
    content.classList.add('view-swap');
    content.scrollTop = 0;
  }
  // Discord shows where in the launcher the user is; a running game wins.
  if (typeof presenceBrowsing === 'function') presenceBrowsing();
}

// ---------------------------------------------------------------------------
// Local game detection
// ---------------------------------------------------------------------------
/** Switches the visible tab (and renders it). */
function switchView(name) {
  const tab = document.querySelector(`.tab[data-view="${name}"]`);
  if (tab) tab.click();
}

async function scanLibraries(showModal) {
  const hints = allGames().map(gameHint);
  let res;
  try {
    res = await window.api.detectGames(hints);
  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'warn');
    return { merged: 0 };
  }
  if (!res || res.error) {
    toast(`Scan failed: ${(res && res.error) || 'unknown error'}`, 'warn');
    return { merged: 0 };
  }

  State.local = State.local || { installs: {}, roots: {}, stores: {} };
  State.local.roots = { ...State.local.roots, ...(res.roots || {}) };
  State.local.stores = { ...State.local.stores, ...(res.stores || {}) };

  let merged = 0;
  let unverified = 0;

  State.verify = State.verify || {};

  /**
   * Adopts a detection result, gated on real file verification.
   *
   * This is the point where "a manifest exists" stops being enough. If the
   * files are not actually on disk, the game loses its installed status so the
   * UI offers Install rather than a PLAY button that would fail.
   */
  const adopt = (id, target, keepExistingLink = false) => {
    const report = (res.reports && res.reports[id]) || (target && target.verify) || null;
    if (report) State.verify[id] = { ...report, checkedAt: Date.now() };

    if (report && !report.ok) {
      delete State.installed[id];            // not playable, whatever the manifest says
      State.owned[id] = true;                // but the licence is still real, so Install is offered
      unverified++;
      return false;
    }

    // Respect games the user deliberately removed from the library.
    if (State.dismissed && State.dismissed[id]) return false;

    // A link the user set by hand wins over one we inferred.
    if (!keepExistingLink || !State.local.installs[id]) State.local.installs[id] = target;
    State.installed[id] = true;
    State.owned[id] = true;
    merged++;
    return true;
  };

  for (const [id, target] of Object.entries(res.matched || {})) adopt(id, target);

  // Non-Steam titles we recognised on disk (VALORANT, GOG, Ubisoft, ...).
  for (const [id, target] of Object.entries(res.local || {})) {
    State.owned[id] = true;
    adopt(id, target, true);
  }

  // Verified ownership even when the game is not installed on this PC: this is
  // what unlocks the Install button in the Store. Anything else stays locked.
  let owned = 0;
  for (const id of Object.keys(res.owned || {})) {
    if (!State.owned[id]) owned++;
    State.owned[id] = true;
  }

  // --- titles the detector verified but the catalogue does not know ---------
  // These used to stop at the scan modal, so a game that was plainly installed
  // never reached the library and read as "not detected". Anything already on
  // disk is taken in here, once; the modal keeps only what it could not verify.
  State.local.detected = State.local.detected || {};
  const detectKey = (d) => `${d.source || d.type || 'local'}:${
    d.appId || d.uri || d.exe || String(d.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  }`;
  const linkFor = (d) => (d.type === 'steam'
    ? { type: 'steam', appId: d.appId, name: d.name, path: d.path || null, source: 'steam' }
    : { ...d });

  const leftovers = [];
  const picked = [];

  for (const d of (res.unknown || [])) {
    if (!d || !d.installed) { leftovers.push(d); continue; }

    const key = detectKey(d);
    // The same game can already be in the library because the user added it by
    // hand before this map existed; a title match is enough to call it ours.
    const titled = (State.custom || [])
      .find((g) => String(g.title).toLowerCase() === String(d.name).toLowerCase());
    const known = State.local.detected[key] || (titled && titled.id);

    if (known) {
      if (!(State.dismissed && State.dismissed[known])) {
        State.local.detected[key] = known;
        State.local.installs[known] = linkFor(d);   // an install that moved is re-pointed
        State.installed[known] = true;
        State.owned[known] = true;
      }
      continue;
    }

    const g = await addDetectedGame(d, { batch: true });
    State.local.detected[key] = g.id;
    picked.push(g);
  }

  await persist();
  refreshActions();
  afterLibraryChange();
  // A store-handled install that has now appeared on disk is finished.
  reconcileHandoffs();
  if (picked.length) {
    toast(`${picked.length} game${picked.length === 1 ? '' : 's'} found on this PC ${picked.length === 1 ? 'was' : 'were'} added to your library`, 'check');
    if (typeof ensureArt === 'function') ensureArt(picked);
  }
  if (showModal) openDetectedModal({ ...res, unknown: leftovers }, addDetectedGame);

  if (unverified) {
    const names = Object.keys(State.verify)
      .filter((id) => State.verify[id] && !State.verify[id].ok && !isInstalled(id))
      .map((id) => (byId(id) || {}).title)
      .filter(Boolean);
    if (names.length) {
      toast(`${names.length} game${names.length === 1 ? '' : 's'} failed verification \u2014 files are missing or incomplete`, 'warn');
    }
  }

  return { merged, owned, unverified, res };
}

/**
 * Runs real file verification for one game and records the result.
 *
 * @param {string} id
 * @param {{deep?:boolean, silent?:boolean}} [opts]
 * @returns {Promise<object|null>} the report, or null if it could not run.
 */
async function verifyGame(id, opts = {}) {
  const g = byId(id);
  const link = localLink(id) || {};
  // A download records its install folder before (or even without) an exe.
  // Verify that folder instead of reporting "nothing is linked" for a game
  // whose files are plainly on disk.
  const knownDir = State.installDirs && State.installDirs[id];
  const target = { ...link };
  if (!target.exe && !target.path && !target.uri && knownDir) {
    target.type = target.type || 'exe';
    target.path = knownDir;
  }
  const record = { ...target, name: (g && g.title) || target.name || id };

  let reports = null;
  try { reports = await window.api.verifyGames({ [id]: record }, { deep: !!opts.deep }); }
  catch { reports = null; }

  const report = reports && reports[id];
  if (!report) {
    if (!opts.silent) toast('Verification could not run', 'warn');
    return null;
  }

  State.verify = State.verify || {};
  State.verify[id] = { ...report, checkedAt: Date.now() };

  // Verification may confirm that a game is installed, but it must never take
  // one out of the Library. A missing link or a half-finished install is a
  // launch problem to repair (Locate / pick the exe), not an uninstall.
  if (report.ok) State.installed[id] = true;

  await persist();
  refreshActions();
  return report;
}

/** The folder part of an executable path, without Node's `path` module. */
function folderOf(p) {
  const s = String(p || '');
  const cut = s.replace(/[\\/][^\\/]*$/, '');
  return cut && cut !== s ? cut : s;
}

/** Builds the persistent descriptor used by State.local.installs. */
function launchLinkFor(id, found, source = 'manual') {
  const g = byId(id) || {};
  const exe = (found && found.exe) ? String(found.exe) : null;
  const dir = (found && found.cwd) || (exe ? folderOf(exe) : null) || (found && found.path) || null;
  return {
    type: 'exe',
    exe,
    cwd: dir,
    path: (found && found.path) || dir,
    name: g.title || null,
    source
  };
}

/**
 * Restores installs that were completed before the launcher saved a launch
 * link. The folder was recorded, the files are still there, but the Library
 * entry was dropped by the old verification path. Nothing is deleted here: a
 * folder is only re-adopted when it still exists.
 */
async function repairInstallLinks() {
  const dirs = State.installDirs || {};
  let changed = false;
  for (const id of Object.keys(dirs)) {
    if (!dirs[id] || isInstalled(id)) {
      // An entry repaired on an earlier run can still carry the old
      // "Nothing is linked" report. It is stale once a launch link exists.
      const link = State.local && State.local.installs && State.local.installs[id];
      const stale = State.verify && State.verify[id];
      if (link && (link.exe || link.path) && stale && /Nothing is linked/i.test(stale.reason || '')) {
        delete State.verify[id];
        changed = true;
      }
      continue;
    }
    try {
      if (window.api.pathExists && !(await window.api.pathExists(dirs[id]))) continue;
      const g = byId(id) || {};
      const found = window.api.findLaunch ? await window.api.findLaunch(dirs[id], g.title) : null;
      State.local = State.local || { installs: {}, roots: {} };
      State.local.installs[id] = launchLinkFor(id, found || { path: dirs[id] }, 'repair');
      State.installed[id] = true;
      State.owned[id] = true;
      if (State.verify) delete State.verify[id];
      changed = true;
    } catch { /* leave that entry alone */ }
  }
  if (changed) await persist();
  return changed;
}

async function createCustomGame(payload) {
  const g = makeCustomGame(payload);
  State.custom = State.custom || [];
  State.custom.push(g);
  State.installed[g.id] = true;
  State.owned[g.id] = true;

  if (payload.exe) {
    State.local = State.local || { installs: {}, roots: {} };
    State.local.installs[g.id] = { type: 'exe', exe: payload.exe, cwd: null, name: g.title, source: 'manual' };
  }

  await persist();
  afterLibraryChange();
  toast(`${g.title} added to your library`, 'check');
  return g;
}

/**
 * Adds a title the detector found but the catalogue does not know about.
 *
 * `opts.batch` defers the repaint, the toast and the artwork lookup to the
 * caller, so a first scan that adopts eight titles in one go paints once.
 */
async function addDetectedGame(d, opts = {}) {
  const store = d.source && storeById(d.source);
  const g = makeCustomGame({
    title: d.name,
    developer: store ? store.name : 'Local',
    genre: 'Imported'
  });
  // A Steam detection knows the real AppID. Keeping it means this card pulls
  // that game's own artwork straight from the Steam CDN the moment it renders,
  // and its store-page link works — no lookup needed.
  if (d.type === 'steam' && d.appId) g.steamAppId = String(d.appId);
  // Remember which storefront published it, so the card keeps a GOG/EA/
  // Ubisoft/Battle.net badge instead of falling back to a generic "Local".
  if (store) g.platform = store.id;

  State.custom = State.custom || [];
  State.custom.push(g);
  State.installed[g.id] = true;
  State.owned[g.id] = true;

  State.local = State.local || { installs: {}, roots: {}, stores: {} };
  State.local.installs[g.id] = d.type === 'steam'
    ? { type: 'steam', appId: d.appId, name: d.name, path: d.path || null, source: 'steam' }
    : { ...d };

  await persist();

  // In a batch the caller paints once and dresses everything together, so a
  // first scan that adopts eight games does not redraw the library eight times.
  if (!opts.batch) {
    afterLibraryChange();
    toast(`${d.name} added to your library`, 'check');

    // Dress it immediately rather than waiting for the next launch: anything the
    // AppID/CDN chain cannot supply is looked up online (see coverart.js).
    if (typeof ensureArt === 'function') ensureArt([g]);
  }

  return g;
}

// ---------------------------------------------------------------------------
// Launching & play sessions
// ---------------------------------------------------------------------------
/**
 * Stops a running game: asks the main process to terminate the real process
 * tree (taskkill on Windows) and then ends the play-time session. The button
 * reverts to PLAY straight away; if the process lingers, the `game:exited`
 * event finishes the job.
 */
async function stopGame(id) {
  const g = byId(id);
  const link = localLink(id);
  const image = (link && link.exe) ? String(link.exe).split(/[\\/]/).pop() : null;

  let res = null;
  try { res = await window.api.stopGame({ id, image }); }
  catch (err) { res = { ok: false, error: err.message }; }

  endSession(id);
  refreshActions();

  if (res && res.ok) toast(`${g ? g.title : 'Game'} stopped`, 'check');
  else if (res && res.error === 'not-running') toast(`${g ? g.title : 'Game'} is not running from Apex`, 'info');
  else toast(`${g ? g.title : 'Game'} session ended \u00b7 play time saved`, 'info');
}

async function launchGame(id) {
  const g = byId(id);
  if (!g) return;

  // Ownership gate: the launcher only ever starts games the account owns.
  if (!isOwned(id)) {
    toast(`${g.title} is not owned on this account \u2014 buy or claim it in Steam/Epic first`, 'warn');
    return;
  }

  let target = launchTarget(id);

  // A finished download records its install folder. Turn that folder into a
  // real executable before concluding there is nothing to launch. This also
  // repairs installs made by older builds, which saved no link at all.
  if (!target) {
    const link = localLink(id) || {};
    const dir = (State.installDirs && State.installDirs[id]) || link.path || (link.exe ? folderOf(link.exe) : null);
    if (dir && window.api.findLaunch) {
      try {
        const found = await window.api.findLaunch(dir, g.title);
        if (found && found.exe) {
          State.local = State.local || { installs: {}, roots: {} };
          State.local.installs[id] = launchLinkFor(id, found, 'download');
          State.installed[id] = true;
          State.owned[id] = true;
          if (State.verify) delete State.verify[id];
          await persist();
          target = launchTarget(id);
        }
      } catch { /* fall through to detection / the picker */ }
    }
  }

  // No link yet: try a quick targeted detection before giving up.
  if (!target) {
    try {
      const res = await window.api.detectGames([gameHint(g)]);
      if (res && res.matched && res.matched[id]) {
        State.local = State.local || { installs: {}, roots: {} };
        State.local.installs[id] = res.matched[id];
        if (res.roots) State.local.roots = { ...State.local.roots, ...res.roots };
        State.installed[id] = true;
        State.owned[id] = true;
        target = { ...res.matched[id], id, name: g.title };
        await persist();
      }
    } catch { /* fall through to the guidance toast */ }
  }

  if (!target) {
    // Nothing linked yet: ask for the executable right away so Launch works.
    // The game stays in the Library even if the user cancels the picker.
    toast(`${g.title} has no linked executable \u2014 choose one to launch it`, 'warn');
    const startDir = (State.installDirs && State.installDirs[id]) || undefined;
    const picked = await window.api.pickExecutable(startDir);
    if (!picked) return;
    State.local = State.local || { installs: {}, roots: {} };
    State.local.installs[id] = launchLinkFor(id, { exe: picked, cwd: folderOf(picked), path: folderOf(picked) }, 'manual');
    State.installed[id] = true;
    State.owned[id] = true;
    if (State.verify) delete State.verify[id];
    await persist();
    refreshActions();
    afterLibraryChange();
    return launchGame(id);
  }

  // Start the play-time session *before* the launch so the timer is accurate.
  beginSession(id);
  refreshActions();

  const res = await window.api.launchGame(target);
  if (!res || !res.ok) {
    endSession(id);
    refreshActions();
    const err = (res && res.error) || 'unknown error';
    toast(`Could not launch ${g.title}: ${err}`, 'warn');

    // A stale path is repairable; never punish the Library entry for it.
    if (target.type === 'exe' && /executable not found|invalid executable|target is not a file|blocked file type/i.test(err)) {
      const picked = await window.api.pickExecutable(target.exe || target.path || undefined);
      if (!picked) return;
      State.local = State.local || { installs: {}, roots: {} };
      State.local.installs[id] = launchLinkFor(id, { exe: picked, cwd: folderOf(picked), path: folderOf(picked) }, 'manual');
      State.installed[id] = true;
      State.owned[id] = true;
      if (State.verify) delete State.verify[id];
      await persist();
      afterLibraryChange();
      return launchGame(id);
    }
    return;
  }

  State.stats = State.stats || {};
  State.stats.launches = (State.stats.launches || 0) + 1;
  persist();

  toast(`Launching ${g.title}\u2026 press Stop when you are done`, 'check');
  refreshActions();

  // Steam achievements are only polled while the game is actually up.
  if (typeof startSteamWatch === 'function') startSteamWatch(id);
  checkAchievements('launch');
}

// ---------------------------------------------------------------------------
// Leaving the library
// ---------------------------------------------------------------------------
/**
 * Takes a game out of the Library without touching the disk.
 *
 * This is the *only* thing that used to be called "uninstall", and it is still
 * useful on its own: a title detected in a Steam or Epic library should be
 * dropped from Apex's lists without deleting anyone else's files. Deleting the
 * install itself is a separate, deliberate action (see uninstall.js), and it
 * calls through here afterwards so both paths leave the same state behind.
 *
 * @param {string} id
 * @param {{silent?: boolean}} [opts] - `silent` skips the toast when the caller
 *   has already told the user something more specific (e.g. "uninstalled · 8.1 GB freed").
 */
async function removeFromLibrary(id, opts = {}) {
  const g = byId(id);
  delete State.installed[id];
  delete State.updates[id];
  delete State.owned[id];
  delete State.installDirs[id];
  if (State.local && State.local.installs) delete State.local.installs[id];
  // Remember the choice so the next scan doesn't silently re-add it.
  State.dismissed = State.dismissed || {};
  State.dismissed[id] = true;
  await persist();

  if (!opts.silent) toast(`${g ? g.title : 'Game'} removed from your library`, 'warn');
  if (current === 'detail') { backToLibrary(); return; }
  refreshActions();
  afterLibraryChange();
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
/**
 * The one place a finished capture is acknowledged.
 *
 * Both routes end here - the in-app button and the F2 global hotkey, which the
 * main process pushes in as `shot:taken` - so the count, the sound, the toast and
 * the gallery refresh can never disagree about what just happened.
 *
 * @param {object} shot - the main process' capture result
 * @returns {Promise<boolean>} whether anything was saved
 */
async function noteScreenshot(shot) {
  if (!shot || !shot.ok) {
    if (shot && shot.reason === 'disabled') return false;
    if (shot && shot.error === 'busy') return false;
    toast((shot && shot.error) || 'Could not take the screenshot', 'warn');
    return false;
  }

  State.stats = State.stats || {};
  State.stats.screenshots = (State.stats.screenshots || 0) + 1;
  await persist();

  const s = State.settings.screenshot || {};
  if (s.sound !== false) { try { SFX.play('select'); } catch { /* silent is fine */ } }
  toast(`Screenshot saved \u00b7 ${shot.name}`, 'check');

  if (current === 'gallery') { galleryShots = null; render(false); }
  checkAchievements('screenshot');
  return true;
}

/**
 * Absolute path of a screenshot the gallery already listed.
 *
 * The path is never built in the renderer: it is asked for, so a hand-edited
 * data attribute can only ever name a file that is really in the folder.
 */
async function shotFullPath(name) {
  if (!name) return null;
  const from = (list) => ((list && list.shots) || []).find((s) => s.name === name) || null;

  let hit = from(galleryShots);
  if (hit) return hit.path;

  galleryShots = await window.api.shotsList().catch(() => null);
  hit = from(galleryShots);
  return hit ? hit.path : null;
}

/** Keeps the title-bar overlay button lit while the panel is on screen. */
function syncOverlayButton(on) {
  const b = document.getElementById('btn-overlay');
  if (b) b.classList.toggle('on', !!on);
}

// ---------------------------------------------------------------------------
// Content-click delegation
// ---------------------------------------------------------------------------
// Shared navigation verbs (controller, keyboard and pointer all funnel here)
// ---------------------------------------------------------------------------
/**
 * The single "go back" verb. It unwinds whatever is on top first — a dialog, the
 * download manager, a dropdown, Big Picture, the details page — so one press
 * always means exactly one step back.
 *
 * @returns {boolean} true when something was actually dismissed.
 */
function uiBack() {
  if (document.querySelector('#modal-root .modal-backdrop.show')) { closeModal(); return true; }

  if (typeof BP !== 'undefined' && BP.settingsOpen && BP.settingsOpen()) { BP.closeSettings(); return true; }

  if (typeof BP !== 'undefined' && BP.overlayOpen && BP.overlayOpen()) { BP.closeOverlay(); return true; }

  const dlm = document.getElementById('dl-modal');
  if (dlm && dlm.classList.contains('show')) { closeDownloadModal(); return true; }

  if (document.querySelector('.menu.open')) { closeMenus(); return true; }

  if (typeof BP !== 'undefined' && BP.isOpen()) { BP.exit(); return true; }

  if (current === 'detail') { backToLibrary(); return true; }
  return false;
}

/** Moves the active section one step along — LB/RB on a pad, Tab in Big Picture. */
function uiCycleTab(delta) {
  if (typeof BP !== 'undefined' && BP.isOpen()) { BP.cycleTab(delta); return; }
  const tabs = [...document.querySelectorAll('#sidebar .tab[data-view]')];
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.classList.contains('active'));
  const next = tabs[(i + delta + tabs.length) % tabs.length];
  if (next) next.click();
}

// ---------------------------------------------------------------------------
/**
 * One delegated click handler for the whole app. It is attached to #content, to
 * #modal-root, to #sidebar and to the Big Picture layer, because dialogs and the
 * sidebar are rendered outside #content and their own `data-act` buttons would
 * otherwise never fire.
 */
async function onContentClick(e) {
  // Hero carousel
  const car = e.target.closest('[data-car]');
  if (car) { goSlide(slide + +car.dataset.car); startCarousel(); return; }
  const dot = e.target.closest('[data-dot]');
  if (dot) { goSlide(+dot.dataset.dot); startCarousel(); return; }

  // Clicking a game card (but not one of its buttons) opens the details page.
  const card = e.target.closest('[data-card]');
  if (card && !e.target.closest('[data-act]') && !e.target.closest('.dropdown')) {
    SFX.play('open');
    openDetail(card.dataset.card);
    return;
  }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;

  // One audible confirmation per press. The controller and the Big Picture
  // keyboard shortcuts deliberately do not play one of their own: they end up
  // here too (or at their own top-level handler), so this is the single place a
  // press gets a voice and nothing ever double-beeps.
  SFX.play(/^(back|close|cancel|unlink|remove|dismiss|uninstall|shot-delete)$/.test(act) ? 'back'
    : act === 'menu' ? 'toggle' : 'select');

  if (act === 'menu') {
    const m = el.nextElementSibling;
    const open = !!(m && m.classList.contains('open'));
    closeMenus();
    if (m && !open) m.classList.add('open');
    return;
  }
  if (act === 'toast') { closeMenus(); toast(el.dataset.msg || 'Demo feature'); return; }

  closeMenus();

  switch (act) {
    // --- store: install / update -------------------------------------------
    // Both open the installer, which picks the drive and then hands the job to
    // whichever store actually owns the game.
    case 'install': return openInstallDialog(id, 'install');
    case 'update': return openInstallDialog(id, 'update');
    case 'pause': return pauseDownload(id);
    case 'resume': return resumeDownload(id);
    case 'cancel': return cancelDownload(id);
    case 'play': return launchGame(id);
    case 'stop': return stopGame(id);
    case 'back': return backToLibrary();

    // --- imports & store links ---------------------------------------------
    case 'import-folder': return importFolder();
    case 'steam-page': {
      const url = steamStoreUrl(id);
      if (!url) { toast('No store page is listed for this title', 'info'); return; }
      const ok = await window.api.openExternal(url);
      toast(ok ? `Opening ${byId(id).title} on the Steam store` : 'Could not open the link', ok ? 'check' : 'warn');
      return;
    }
    // --- pre-orders ---------------------------------------------------------
    // Adding a pre-order puts the title in the Library so it is tracked with a
    // release countdown. Apex never takes payment: the publisher's own page is
    // a separate, explicit action ("Pre-order page").
    case 'preorder': {
      const g = byId(id);
      State.preorders = State.preorders || {};
      State.preorders[id] = {
        at: Date.now(),
        url: preorderUrl(id),
        releaseDate: (g && g.releaseDate) || null
      };
      await persist();
      refreshActions();
      if (current === 'library') render(false);
      const iso = g && g.releaseDate;
      toast(iso
        ? `${g.title} added to your library \u2014 releases in ${countdownText(iso)}`
        : `${g ? g.title : 'Title'} added to your library \u2014 no release date announced yet`, 'check');
      return;
    }
    case 'preorder-open': {
      const g = byId(id);
      const url = preorderUrl(id);
      if (!url) { toast(`No pre-order page is listed for ${g ? g.title : 'this title'}`, 'info'); return; }
      const ok = await window.api.openExternal(url);
      toast(ok ? `Opening the official page for ${g.title}` : 'Could not open the page', ok ? 'check' : 'warn');
      return;
    }
    case 'preorder-info': {
      const g = byId(id);
      const rec = (State.preorders || {})[id];
      const iso = typeof releaseDateOf === 'function' ? releaseDateOf(id) : null;
      const when = rec && rec.at ? new Date(rec.at).toLocaleDateString() : '';
      const consoles = (g && g.consoles) || [];
      openModal({
        title: g ? g.title : 'Pre-order',
        ico: 'bookmark',
        body: `<div class="preorder-info">
          ${iso ? `<p class="po-line big">${icon('hourglass', 16)} ${esc(countdownText(iso))} <small>until release</small></p>` : ''}
          <p><strong>This title is in your library.</strong> Apex does not take payment and
          does not hold a pre-order &mdash; it tracks the release here and can open the
          publisher's own page so the pre-order is placed with them.</p>
          ${g && g.releaseLabel ? `<p class="po-line">${icon('calendar', 15)} ${esc(g.releaseLabel)}</p>` : ''}
          ${consoles.length ? `<p class="po-line">${icon('gamepad', 15)} Available on ${esc(consoles.map((c) => (CONSOLE_META[c] || {}).full || c).join(' \u00b7 '))}</p>` : ''}
          ${when ? `<p class="po-line">${icon('clock', 15)} Added ${esc(when)}</p>` : ''}
          ${rec && rec.url ? `<p class="po-line">${icon('link', 15)} <span class="po-url">${esc(rec.url)}</span></p>` : ''}
        </div>`,
        footer: `${rec && rec.url ? `<button class="btn secondary" data-act="preorder-open" data-id="${id}">${icon('external', 15)} Open pre-order page</button>` : ''}
          <button class="btn primary" data-act="preorder-clear" data-id="${id}">${icon('close', 15)} Remove from library</button>`
      });
      return;
    }
    case 'preorder-clear': {
      if (State.preorders) delete State.preorders[id];
      await persist();
      closeModal();
      refreshActions();
      if (current === 'library' || current === 'store') render(false);
      toast('Removed from your library', 'info');
      return;
    }

    case 'verify': {
      const g = byId(id);
      toast(`Verifying ${g.title}\u2026 this reads the files on disk`, 'info');
      const report = await verifyGame(id, { deep: true });
      if (!report) return;
      if (report.ok) toast(`${g.title}: ${report.reason}`, 'check');
      else toast(`${g.title}: ${report.label} \u2014 ${report.reason}`, 'warn');
      afterLibraryChange();
      return;
    }

    // --- profile ------------------------------------------------------------
    case 'open-profile': {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      current = 'profile';
      render(true);
      return;
    }
    case 'edit-profile': return openProfileEditor();
    case 'account': {
      // Settings owns the account panel; the menu just has to land on it.
      focusSettingsSection('account');
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      const t = document.querySelector('.tab[data-view="settings"]');
      if (t) t.classList.add('active');
      current = 'settings';
      render(true);
      return;
    }
    case 'open-settings': {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      const t = document.querySelector('.tab[data-view="settings"]');
      if (t) t.classList.add('active');
      current = 'settings';
      render(true);
      return;
    }

    // --- navigation --------------------------------------------------------
    case 'goto-library': return switchView('library');
    case 'goto-store': return switchView('store');

    // --- Big Picture mode --------------------------------------------------
    // BP.enter plays its own entry cue, so nothing is added here.
    case 'bigpicture': return BP.enter();

    // --- local installs ----------------------------------------------------
    case 'locate': {
      const existing = localLink(id);
      const picked = await window.api.pickExecutable((existing && existing.exe) || undefined);
      if (!picked) return;
      State.local = State.local || { installs: {}, roots: {} };
      State.local.installs[id] = { type: 'exe', exe: picked, cwd: null, name: byId(id).title, source: 'manual' };
      State.installed[id] = true;
      State.owned[id] = true;
      await persist();
      refreshActions();
      toast(`${byId(id).title} linked`, 'check');
      return;
    }
    case 'scan-one': {
      const g = byId(id);
      const res = await window.api.detectGames([gameHint(g)]);
      const target = res && res.matched && res.matched[id];
      if (target) {
        State.local = State.local || { installs: {}, roots: {} };
        State.local.installs[id] = target;
        if (res.roots) State.local.roots = { ...State.local.roots, ...res.roots };
        State.installed[id] = true;
        State.owned[id] = true;
        if (State.dismissed) delete State.dismissed[id];
        await persist();
        refreshActions();
        afterLibraryChange();
        toast(`${g.title} found on this PC`, 'check');
      } else {
        toast(`No local install found for ${g.title}`, 'info');
      }
      return;
    }
    case 'unlink': {
      if (State.local && State.local.installs) delete State.local.installs[id];
      await persist();
      refreshActions();
      toast(`${byId(id).title} unlinked`, 'warn');
      return;
    }
    case 'folder': {
      const t = localLink(id);
      const dir = (t && (t.path || (t.exe ? t.exe.replace(/[\\/][^\\/]*$/, '') : null))) || State.settings.installPath;
      return openLocalPath(dir);
    }
    case 'scan-all': {
      const r = await scanLibraries(true);
      if (r.merged) toast(`Linked ${r.merged} installed game(s)`, 'check');
      return;
    }
    case 'add-custom':
      openAddGameModal(createCustomGame);
      return;

    // --- metadata ----------------------------------------------------------
    case 'props': return openPropertiesModal(byId(id));

    // The single entry point users see: it explains both flavours of "remove"
    // (delete the files, or just hide it) and does whichever they pick.
    case 'uninstall-open': return openUninstallModal(id);

    // Kept as its own action so the picker's "Remove from library" button - and
    // anything else that knows it only wants the library entry gone - can call it
    // directly without going through the dialog.
    case 'uninstall': return removeFromLibrary(id);

    // --- gallery: screenshots ---------------------------------------------
    case 'gallery-tab': {
      galleryTab = el.dataset.tab === 'achievements' ? 'achievements' : 'screenshots';
      refreshActions();
      render(true);
      return;
    }
    case 'shot-capture': {
      const shot = await window.api.shotsCapture().catch(() => null);
      return noteScreenshot(shot);
    }
    case 'shot-folder':
      await window.api.shotsOpen();
      return;
    case 'shot-open': {
      // Opening the full-size PNG in the OS viewer is the honest "look at it"
      // path: the renderer's CSP blocks file: images anyway.
      const full = await shotFullPath(el.dataset.shot);
      if (!full) { toast('That screenshot is no longer on disk', 'warn'); return; }
      await window.api.openPath(full);
      return;
    }
    case 'shot-delete': {
      const name = el.dataset.shot;
      const res = await window.api.shotsRemove(name).catch(() => null);
      if (res && res.ok) {
        galleryShots = null;
        toast('Screenshot deleted', 'warn');
        if (current === 'gallery') render(false);
      } else {
        toast((res && res.error) || 'Could not delete that screenshot', 'warn');
      }
      return;
    }

    // --- gallery: achievements --------------------------------------------
    case 'steam-refresh': {
      const host = document.getElementById('gl-steam');
      if (host) host.innerHTML = `${icon('refresh', 15)}<span>Refreshing\u2026</span>`;
      await hydrateSteamShelf();
      toast('Steam achievements refreshed', 'check');
      return;
    }
    case 'steam-connect': {
      const res = await window.api.steamApiDetectId().catch(() => null);
      if (!res || !res.ok) { toast('Could not find a Steam account on this PC', 'warn'); return; }
      State.settings.achievements.steam.steamId = res.steamId;
      await persist();
      await window.api.steamApiApply();
      toast(`Linked Steam account ${res.persona ? `(${res.persona})` : res.steamId}`, 'check');
      refreshActions();
      render(false);
      return;
    }

    // --- performance overlay ----------------------------------------------
    case 'overlay-toggle': {
      const st = await window.api.perfToggle().catch(() => null);
      if (st && st.open) {
        State.stats.overlayOpens = (State.stats.overlayOpens || 0) + 1;
        await persist();
        checkAchievements('overlay');
      }
      syncOverlayButton(!!(st && st.open));
      return;
    }

    // --- changelog ---------------------------------------------------------
    case 'changelog-open': return openChangelog();

    // --- on-screen keyboard ------------------------------------------------
    case 'vkeyboard': {
      // Opened by hand, so it deliberately ignores whether a pad is connected.
      const target = document.activeElement && document.activeElement.matches('input, textarea')
        ? document.activeElement
        : document.getElementById('global-search') || document.getElementById('search');
      if (target) { target.focus(); if (window.vkOpenFor) window.vkOpenFor(target, true); }
      return;
    }

    // --- collections -------------------------------------------------------
    case 'collect': {
      if (typeof openCollectModal !== 'function') return;
      // The same title can appear on a card and in the quick-launch dock, so
      // every matching button is repainted once the picker closes.
      openCollectModal(id, () => {
        const on = isInAnyCollection(id);
        document.querySelectorAll(`.col-btn[data-id="${id}"]`).forEach((b) => b.classList.toggle('on', on));
      });
      return;
    }
    case 'new-collection': {
      if (typeof openNewCollectionModal !== 'function') return;
      // The chip row is part of the page markup, so the view is rebuilt to show
      // the new collection alongside the built-in filters.
      openNewCollectionModal(() => { if (current === 'library') render(false); });
      return;
    }

    case 'fav': {
      if (State.favorites[id]) delete State.favorites[id];
      else State.favorites[id] = true;
      const on = !!State.favorites[id];
      document.querySelectorAll(`.fav[data-id="${id}"]`).forEach((b) => b.classList.toggle('on', on));
      await persist();
      if (typeof refreshFavDock === 'function') refreshFavDock();
      if (current === 'library') applyLibraryFilter();
      if (current === 'detail') refreshDetailBar();
      toast(on ? 'Added to favorites' : 'Removed from favorites', on ? 'check' : 'info');
      return;
    }
    default: return;
  }
}

content.addEventListener('click', onContentClick);
// The modal root is a sibling of #content, so it needs the same delegation —
// otherwise a dialog's own buttons (Install, Remove from library, …) are dead.
const modalRootEl = document.getElementById('modal-root');
if (modalRootEl) modalRootEl.addEventListener('click', onContentClick);
// The sidebar lives outside #content too (its "Big Picture" entry point), and so
// does the Big Picture layer itself (whose hero reuses the shared action cluster).
const sidebarEl = document.getElementById('sidebar');
if (sidebarEl) sidebarEl.addEventListener('click', onContentClick);
const bigPicEl = document.getElementById('bigpic');
if (bigPicEl) bigPicEl.addEventListener('click', onContentClick);

// ---------------------------------------------------------------------------
// Live store results (work from both the Store body and the preview modal, so
// this is delegated at document level rather than on #content).
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const buy = e.target.closest('[data-live-buy]');
  if (buy) {
    const ok = await window.api.openExternal(buy.dataset.liveBuy);
    toast(ok ? 'Opening the Steam store page' : 'Could not open the link', ok ? 'check' : 'warn');
    return;
  }

  const info = e.target.closest('[data-live-info]');
  if (info) { openStorePreview(info.dataset.liveInfo); return; }

  const add = e.target.closest('[data-live-add]');
  if (add) { await addLiveGame(add.dataset.liveAdd, add.dataset.liveName); return; }
});

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  // The Big Picture entry point shares the nav-pill look but opens a layer
  // rather than swapping a view, so it is not a view tab and is skipped here.
  if (!t.dataset.view) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  current = t.dataset.view;
  render(true);
}));

// ---------------------------------------------------------------------------
// Running games (STOP / natural exit)
// ---------------------------------------------------------------------------
// The main process reports every tracked game that closes, so the action
// button always falls back to PLAY on its own \u2014 even if the user quits the
// game from inside the game rather than from Apex.
window.api.onGameExited((rec) => {
  if (!rec || !rec.id) return;
  if (!SESSIONS[rec.id]) return;      // already ended by a manual STOP
  endSession(rec.id);
  refreshActions();
  if (rec.reason === 'exited') {
    const g = byId(rec.id);
    toast(`${g ? g.title : 'Game'} closed \u00b7 play time saved`, 'info');
  }
  // A finished session is exactly when a playtime achievement is most likely to
  // have just been earned.
  if (typeof stopSteamWatch === 'function') stopSteamWatch();
  checkAchievements('session-end');
});

// Screenshots taken with the F2 hotkey arrive from the main process, because the
// renderer is usually not focused - or even visible - when F2 is pressed.
window.api.onShotTaken((shot) => { noteScreenshot(shot); });

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------
document.getElementById('btn-min').onclick = () => window.api.minimize();
document.getElementById('btn-max').onclick = () => window.api.maximize();
document.getElementById('btn-close').onclick = () => window.api.close();
window.api.onMaximized((m) => { document.getElementById('max-ico').innerHTML = icon(m ? 'restore' : 'max', 14); });

// The performance overlay is a window of its own, so this button only ever asks
// the main process to flip it and then reflects what actually happened.
const overlayBtn = document.getElementById('btn-overlay');
if (overlayBtn) {
  overlayBtn.onclick = async () => {
    const st = await window.api.perfToggle().catch(() => null);
    const open = !!(st && st.open);
    syncOverlayButton(open);
    if (open) {
      State.stats.overlayOpens = (State.stats.overlayOpens || 0) + 1;
      await persist();
      checkAchievements('overlay');
    }
  };
}

// The on-screen keyboard, reachable without a controller - it is also the
// fastest way to type with a mouse for anyone who wants it.
const vkbdBtn = document.getElementById('btn-vkbd');
if (vkbdBtn) vkbdBtn.onclick = () => {
  const active = document.activeElement;
  const target = (active && active.matches && active.matches('input, textarea'))
    ? active
    : (document.getElementById('global-search') || document.getElementById('search'));
  if (!target) return;
  target.focus();
  if (window.vkOpenFor) window.vkOpenFor(target, true);
};

// The version chip in the title bar is the permanent door to the changelog; the
// automatic after-update show is only the first time.
const versionChip = document.getElementById('btn-version');
if (versionChip) versionChip.onclick = () => openChangelog();

// ---------------------------------------------------------------------------
// Live clock (top right)
// ---------------------------------------------------------------------------
// There are no seconds on the face, so it repaints on the minute boundary
// instead of every second: 60x less work, and aligning to :00 stops it drifting
// a second or two behind the system clock. A machine that sleeps comes back
// with a stale face, so it also repaints whenever the window is shown again.
(() => {
  const box = document.getElementById('clock');
  const timeEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('clock-date');
  if (!box || !timeEl) return;

  const pad = (n) => String(n).padStart(2, '0');

  function paint() {
    const now = new Date();
    timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }
    const title = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (box.title !== title) box.title = title;
  }

  paint();
  setTimeout(() => {
    paint();
    setInterval(paint, 60000);
  }, 60000 - (Date.now() % 60000) + 20);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); });
})();

document.getElementById('btn-dl').onclick = (e) => { e.stopPropagation(); toggleDrawer(); };

// --- Big Picture entry point ------------------------------------------------
const bpButton = document.getElementById('btn-bp');
if (bpButton) bpButton.onclick = () => { SFX.unlock(); SFX.play('select'); BP.enter(); };

// ---------------------------------------------------------------------------
// Full screen (F11)
// ---------------------------------------------------------------------------
// The key itself is handled in the main process (a frameless window has no menu
// for an accelerator), which then tells us the real state. This side only has to
// keep the chrome honest and leave a way back: in full screen the title bar is
// gone, so a small pill fades in with the exit button and comes back whenever
// the pointer reaches the top of the screen.
const fsHint = document.getElementById('fs-hint');
let fsHintTimer = null;

function showFsHint(autoHide) {
  if (!fsHint) return;
  fsHint.classList.add('show');
  clearTimeout(fsHintTimer);
  if (autoHide) fsHintTimer = setTimeout(() => fsHint.classList.remove('show'), 3400);
}

function applyFullscreen(on) {
  document.body.classList.toggle('is-fullscreen', !!on);
  if (typeof BP !== 'undefined') BP.setFullscreen(!!on);
  // Big Picture takes the screen too, but it draws its own top bar — the pill
  // would only sit on top of the section tabs.
  const inBigPicture = typeof BP !== 'undefined' && BP.isOpen();
  if (on && !inBigPicture) showFsHint(true);
  else if (!on && fsHint) { clearTimeout(fsHintTimer); fsHint.classList.remove('show'); }
}

window.api.onFullscreen(applyFullscreen);

if (fsHint) {
  const exit = document.getElementById('fs-close');
  if (exit) exit.onclick = () => { SFX.play('back'); window.api.toggleFullscreen(false); };

  document.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('is-fullscreen')) return;
    // Big Picture draws its own top bar, so it needs no pill.
    if (typeof BP !== 'undefined' && BP.isOpen()) return;
    clearTimeout(fsHintTimer);
    if (e.clientY <= 64) fsHint.classList.add('show');
    else fsHintTimer = setTimeout(() => fsHint.classList.remove('show'), 800);
  });
}

const profileBtn = document.getElementById('btn-profile');
const profileMenu = profileBtn.nextElementSibling;
profileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = profileMenu.classList.contains('open');
  closeMenus();
  if (!open) profileMenu.classList.add('open');
});

// The profile dropdown lives in the title bar, outside #content, so its items
// are wired here rather than through the content click delegation.
function gotoView(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  const t = document.querySelector(`.tab[data-view="${name}"]`);
  if (t) t.classList.add('active');
  current = name;
  render(true);
}

document.querySelectorAll('#profile-wrap .menu a').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  closeMenus();
  const act = a.dataset.act;
  if (act === 'open-profile') gotoView('profile');
  else if (act === 'edit-profile') openProfileEditor();
  else if (act === 'open-settings') gotoView('settings');
}));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const s = await window.api.loadState();
    State.settings = { ...s.settings };
    State.installed = { ...s.installed };
    State.owned = { ...s.owned };
    State.updates = { ...s.updates };
    State.favorites = { ...s.favorites };
    State.stats = { ...s.stats };
    State.custom = Array.isArray(s.custom) ? s.custom : [];
    State.dismissed = { ...(s.dismissed || {}) };
    State.art = { ...(s.art || {}) };
    State.artAuto = { ...(s.artAuto || {}) };
    State.logoAuto = { ...(s.logoAuto || {}) };
    State.installDirs = { ...(s.installDirs || {}) };
    State.local = {
      installs: (s.local && s.local.installs) || {},
      roots: (s.local && s.local.roots) || {},
      stores: (s.local && s.local.stores) || {},
      // Which storefront titles have already been adopted into the library, so
      // a re-scan refreshes them instead of adding a second copy.
      detected: (s.local && s.local.detected) || {}
    };
    State.profile = s.profile || { name: '', avatar: null, avatarUrl: null, bio: '' };
    State.news = (s.news && Array.isArray(s.news.items)) ? s.news : { items: [], fetchedAt: null, lang: 'fr' };
    State.verify = { ...(s.verify || {}) };
    State.preorders = { ...(s.preorders || {}) };
    // Achievements, what has already been announced about Steam's, and which
    // changelog the user has read.
    State.achievements = { ...(s.achievements || {}) };
    State.steamSeen = { ...(s.steamSeen || {}) };
    State.collections = { ...(s.collections || {}) };
    State.seenChangelog = s.seenChangelog || null;
    // Nested settings blocks: a shallow copy would drop the defaults the moment
    // a state file carries any one of their keys.
    State.settings.overlay = { ...(s.settings.overlay || {}) };
    State.settings.screenshot = { ...(s.settings.screenshot || {}) };
    State.settings.achievements = {
      ...(s.settings.achievements || {}),
      steam: { ...((s.settings.achievements || {}).steam || {}) }
    };
  } catch {
    /* fall back to empty state; the UI still renders */
  }

  // Bring an existing install onto the Project Lightning shell exactly once.
  // After that the theme in Settings is whatever the user chose, including a
  // deliberate return to one of the older themes.
  if (typeof migrateLook === 'function' && migrateLook()) {
    try { await persist(); } catch { /* the next save writes it anyway */ }
  }

  // The animated wallpaper: seeded once, then owned by the user.
  if (typeof seedVideoLook === 'function' && seedVideoLook()) {
    try { await persist(); } catch { /* the next save writes it anyway */ }
  }

  // The bundled wallpaper clip is unpacked out of app.asar in installed builds;
  // the renderer needs its absolute file path for the media element.
  if (window.api && window.api.wallpaperPath) {
    try { State.bgLocalUrl = await window.api.wallpaperPath(); }
    catch { State.bgLocalUrl = null; }
  }

  // The chosen language arrives with the rest of the state. Translating the
  // shell here - before the first render - means the sidebar, the title bar and
  // the sign-in gate are already in the right language on the first paint.
  if (typeof i18nBoot === 'function') i18nBoot(State.settings && State.settings.lang);

  // A custom profile picture is stored as a path; the renderer needs the bytes
  // back as a data URL because the CSP blocks `file:` images.
  if (State.profile && State.profile.avatar && !State.profile.avatarUrl) {
    try { State.profile.avatarUrl = await window.api.readImage(State.profile.avatar); }
    catch { State.profile.avatarUrl = null; }
  }

  // A custom background is stored as a path; the renderer needs the bytes back
  // as a data URL because the CSP blocks `file:` images.
  if (State.settings.background) {
    try { State.bgUrl = await window.api.readImage(State.settings.background); }
    catch { State.bgUrl = null; }
  }

  // Re-adopt downloads that recorded a folder but lost their Library entry
  // when an old build's launch check found no link. This never deletes files.
  try { await repairInstallLinks(); } catch { /* the normal render still runs */ }

  hydrateIcons();
  applySettings();
  initDrawer();

  // The sign-in gate takes over the window before the first paint of the shell.
  // Not awaited: `start()` locks synchronously and only then asks the main
  // process, so a slow or unreachable server delays the answer, never the lock.
  if (typeof AuthGate !== 'undefined') AuthGate.start();

  renderDrawer(true);
  paintProfileChrome();
  render(false);

  // Last news opens once per launch, over the home screen, instead of living in
  // its own tab. It waits for the sign-in gate to open so it never covers it.
  (function bootNews(waited = 0) {
    if (typeof openNewsBoot !== 'function') return;
    if (State.settings && State.settings.newsBoot === false) return;
    if (document.body.classList.contains('auth-locked')) {
      if (waited < 30000) setTimeout(() => bootNews(waited + 1500), 1500);
      return;
    }
    setTimeout(() => { openNewsBoot().catch(() => {}); }, 350);
  })();

  // Controller support: detection, connection notices and d-pad navigation.
  if (typeof startControllers === 'function') startControllers();

  // The window may already be full screen (F11 pressed before this script ran,
  // or a state the OS restored), so ask rather than assume.
  try { applyFullscreen(await window.api.isFullscreen()); } catch { /* ignore */ }

  // One shared ticker keeps every release countdown in the app live.
  if (typeof startCountdowns === 'function') startCountdowns();

  // Recover sessions for anything Apex started that is still running (for
  // example if the window was reloaded while a game was open).
  try {
    const live = await window.api.runningGames();
    (live || []).forEach((r) => {
      beginSession(r.id);
      // A reloaded window should also resume watching a Steam game's
      // achievements, exactly as a fresh launch would.
      if (typeof startSteamWatch === 'function') startSteamWatch(r.id);
    });
    if (live && live.length) refreshActions();
  } catch { /* the STOP button simply falls back to image-name matching */ }

  try {
    const max = await window.api.isMaximized();
    document.getElementById('max-ico').innerHTML = icon(max ? 'restore' : 'max', 14);
  } catch { /* ignore */ }

  // Keep the Library honest: reconcile with what is actually installed on the
  // PC every launch. Read-only, runs silently and only reports if it changes.
  scanLibraries(false).then((r) => {
    if (r && r.merged) toast(`Detected ${r.merged} installed game(s)`, 'check');
    // Titles that ship no art of their own (the user's custom entries, games
    // that only exist on Epic/Riot's stores) get a real banner from online.
    ensureArt(allGames());
  });

  // Bind the global hotkeys to whatever Settings currently says, and light the
  // overlay button if the panel is somehow already up.
  try {
    await window.api.applyHotkeys();
    syncOverlayButton(!!(await window.api.perfStatus()).open);
  } catch { /* the buttons still work; only the hotkeys are missing */ }

  // The version chip doubles as the "What's new" door, and the corner build
  // stamp spells the same version out in full. Both read one appInfo() call, so
  // the two can never disagree about which build is running.
  const chip = document.getElementById('btn-version');
  const stamp = document.getElementById('build-stamp');
  try {
    const info = await window.api.appInfo();
    if (info && info.version) {
      if (chip) chip.textContent = `v${info.version}`;
      if (stamp) stamp.innerHTML = `Created by <span class="stamp-heart">&hearts;</span> sexykudasai - v${info.version}`;
    }
  } catch { /* the chip simply stays empty; the stamp keeps its bundled text */ }

  // Updates are forced, so the chip carries the whole "notice": a pulsing dot
  // while a build is coming down. Nothing is asked of the user, ever.
  try {
    const chipEl = document.getElementById('btn-version');
    const markChip = (snap) => {
      if (!chipEl) return;
      const st = String((snap && snap.state) || '');
      const live = st === 'available' || st === 'downloading' || st === 'downloaded' || st === 'installing';
      chipEl.classList.toggle('upd-live', live);
      if (live) chipEl.title = `Updating to ${(snap && snap.version) || 'a new version'}\u2026`;
    };
    window.api.onUpdateStatus(markChip);
    window.api.updateStatus().then(markChip).catch(() => {});
  } catch { /* the chip is cosmetic; updating carries on regardless */ }

  // Anything already earned is recorded now (and announced once, if this is the
  // first run since achievements shipped).
  checkAchievements('boot');

  // Playtime achievements are earned by the clock, not by a click, so they need
  // a heartbeat. A minute is often enough and costs nothing.
  setInterval(() => { checkAchievements('tick'); }, 60000);

  // The main process holds the splash screen until the first paint is done.
  try { window.api.appReady(); } catch { /* splash just times out instead */ }

  // "What's new" waits for the splash to clear so it is not shown behind it.
  setTimeout(() => { maybeShowChangelog().catch(() => {}); }, 1800);

  // Emulator builds move faster than the launcher does - KytyPS5 alone can
  // publish several in a day - so the release pages are asked once in a while
  // and a newer build is offered where the user is, not buried on a page they
  // may never open. The check is throttled and costs nothing at all for someone
  // who has never downloaded an emulator through Apex.
  setTimeout(() => {
    if (typeof emuBootUpdates === 'function') { try { emuBootUpdates(); } catch { /* the shelf can check later */ } }
  }, 2600);
})();

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // The sign-in gate owns the keyboard while it is up. Escape must not dismiss
  // it and no shortcut may fire behind it, or the door would be a formality.
  if (typeof AuthGate !== 'undefined' && AuthGate.isLocked()) return;

  // Escape unwinds one layer at a time. While Big Picture is open it handles
  // its own Escape and stops the event before it reaches here.
  if (e.key === 'Escape') {
    if (uiBack()) SFX.play('back');
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (current !== 'library') document.querySelector('.tab[data-view="library"]').click();
    setTimeout(() => { const s = document.getElementById('search'); if (s) s.focus(); }, 60);
  }
});
