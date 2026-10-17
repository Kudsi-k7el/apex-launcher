'use strict';

/**
 * The real installer.
 *
 * Pressing Install opens this: it asks which drive the game should go on (with
 * real free space, the way a store client does) and then starts the actual
 * download. Who performs that download depends on where the game lives:
 *
 *   Steam   -> steam://install/<appid>            Steam downloads it, for real
 *   Epic    -> ...?action=install                 Epic downloads it, for real
 *   GOG / Ubisoft / EA / Battle.net / Xbox        opened in their own client
 *   Apex    -> Apex's managed installer, written to the folder you choose
 *
 * Apex never fetches game files itself. The store that holds the licence does
 * the transfer, which is exactly why the drive choice matters there too.
 */

/** Cached result of window.api.listDrives(). */
let INSTALL_DRIVE_DATA = null;
/** The drive chosen in the dialog currently open. */
let installPick = null;
/** Installs handed to a store, so the Downloads page can show them. */
const HANDOFFS = [];

/** "1.8 TB" / "412 GB" / "700 MB" from a byte count. */
function fmtCapacity(n) {
  if (!n || n < 0) return 'unknown';
  const gb = n / (1024 ** 3);
  if (gb >= 1000) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / (1024 ** 2)))} MB`;
}

const BYTES_GB = 1024 ** 3;
const BYTES_MB = 1024 ** 2;
/**
 * Byte counts for a live transfer. Unlike fmtSize, zero reads as "0 MB" rather
 * than a dash, because "0 MB of 105 GB" is the honest start of a download.
 */
const fmtTransferBytes = (n) => (n > 0 ? fmtSize(n / BYTES_GB) : '0 MB');

async function installDriveData(force) {
  if (INSTALL_DRIVE_DATA && !force) return INSTALL_DRIVE_DATA;
  try {
    INSTALL_DRIVE_DATA = await window.api.listDrives();
  } catch {
    INSTALL_DRIVE_DATA = { ok: false, drives: [], steamLibraries: [] };
  }
  return INSTALL_DRIVE_DATA;
}

const driveRoot = (d) => `${String(d.root || d.id).replace(/[\\/]+$/, '')}\\`;
const safeName = (t) => String(t || 'Game').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Game';
const isSteamLib = (libs, d) => (libs || []).some((l) => {
  const a = String(l).replace(/[\\/]+$/, '').toLowerCase();
  const b = String(d.root).replace(/[\\/]+$/, '').toLowerCase();
  return a === b || a.startsWith(`${b}\\`);
});

/** The Steam library folder that lives on this drive, if Steam has one. */
const steamLibOnDrive = (libs, d) => (libs || []).find((l) => {
  const a = String(l).replace(/[\\/]+$/, '').toLowerCase();
  const b = String(d.root).replace(/[\\/]+$/, '').toLowerCase();
  return a === b || a.startsWith(`${b}\\`);
});

/** Where a game ends up on the chosen drive, given who is installing it. */
function predictedDir(plan, d, ctx) {
  if (!d) return null;
  const root = driveRoot(d);
  const name = safeName(plan.title);
  if (plan.managed) return `${root}ApexGames\\${name}`;
  if (plan.platform === 'steam') {
    // Use the real library folder when there is one (it is often well below the
    // drive root), otherwise the folder Steam would create for a new drive.
    const lib = steamLibOnDrive(ctx.libs, d);
    const base = (lib || `${root.replace(/[\\/]+$/, '')}\\SteamLibrary`).replace(/[\\/]+$/, '');
    return `${base}\\steamapps\\common\\${name}`;
  }
  if (plan.platform === 'epic') return `${root}Epic Games\\${name}`;
  return null;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
async function openInstallDialog(id, kind = 'install') {
  const g = byId(id);
  if (!g) return;
  if (DL[id]) { openDownloadModal(id); return; }   // already transferring

  const plan = installPlan(id);
  plan.kind = kind;

  const data = await installDriveData();
  const drives = data.drives || [];
  const libs = data.steamLibraries || [];

  const needBytes = (g.size || 0) * (1024 ** 3);
  const fits = (d) => needBytes <= 0 || d.free <= 0 || d.free >= needBytes;

  // Keep the previous choice while it still fits this game. Otherwise prefer the
  // drive the game was last pointed at, and fall back to the roomiest one.
  const current = drives.find((d) => d.id === installPick);
  if (!current || !fits(current)) {
    const want = String(installDirFor(id)).toLowerCase();
    const remembered = drives.find((d) => want.startsWith(driveRoot(d).toLowerCase()));
    const roomiest = drives.find(fits) || drives[0] || null;
    installPick = remembered && fits(remembered) ? remembered.id : (roomiest ? roomiest.id : null);
  }

  openModal({
    title: `${kind === 'update' ? 'Update' : 'Install'} \u00b7 ${g.title}`,
    ico: plan.ico,
    body: `<div class="ip-art">${art(g, 'wide')}</div>
      <div class="ip-meta">
        <span class="ip-badge">${icon(plan.ico, 13)} ${esc(plan.storeName)}</span>
        <span class="ip-chip">${icon('hardDrive', 13)} ${fmtSize(g.size)}</span>
        ${isFree(g) ? `<span class="ip-chip">${icon('cart', 13)} Free to Play</span>` : ''}
      </div>

      <h4 class="modal-sub">${icon('hardDrive', 15)} Install location</h4>
      <div class="drive-list" id="ip-drives"></div>
      <div class="ip-dest">
        <small id="ip-dest-label">Destination folder</small>
        <code id="ip-dest"></code>
      </div>
      <div id="ip-space"></div>
      <div id="ip-steam"></div>

      <h4 class="modal-sub">${icon('download', 15)} Who downloads this</h4>
      <div id="ip-who"></div>

      <p class="ip-legal">${icon('shield', 13)}
        Apex never fetches game files itself. Downloads always come from the store
        that holds the licence.</p>`,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>
      <button class="btn primary glow" id="ip-go"></button>`,
    onMount(el) {
      const ctx = { drives, libs, needBytes, pick: installPick };
      const paint = () => paintInstall(el, plan, ctx);
      paint();

      el.querySelector('#ip-drives').addEventListener('click', (e) => {
        const row = e.target.closest('[data-drive]');
        if (!row) return;
        installPick = row.dataset.drive;
        ctx.pick = installPick;
        paint();
      });

      el.addEventListener('click', async (e) => {
        const addLib = e.target.closest('#ip-addlib');
        if (addLib) {
          addLib.disabled = true;
          addLib.innerHTML = `${icon('refresh', 14)} Adding\u2026`;
          const res = await window.api.addSteamLibrary(addLib.dataset.dir);
          if (res && res.ok) {
            toast(res.already ? 'Steam already had that library' : 'Added to Steam\u2019s library folders', 'check');
            const fresh = await installDriveData(true);
            ctx.libs = fresh.steamLibraries || [];
            paint();
          } else {
            toast((res && res.error) || 'Could not update Steam\u2019s libraries', 'warn');
            addLib.disabled = false;
            addLib.innerHTML = `${icon('folder', 15)} Try again`;
          }
          return;
        }
        if (e.target.closest('#ip-go') && !e.target.closest('#ip-go').disabled) runInstall(plan, ctx);
      });
    }
  });
}

/** (Re)paints the live parts of the dialog for the currently picked drive. */
function paintInstall(el, plan, ctx) {
  const g = byId(plan.id);
  const need = ctx.needBytes;
  const picked = ctx.drives.find((d) => d.id === ctx.pick) || null;

  // --- drive list ----------------------------------------------------------
  const list = el.querySelector('#ip-drives');
  if (list) {
    list.innerHTML = ctx.drives.length
      ? ctx.drives.map((d) => driveRowHtml(d, { chosen: ctx.pick, libs: ctx.libs, need })).join('')
      : `<div class="ip-note warn">${icon('warning', 15)} <span>No drives could be read on this PC.</span></div>`;
  }

  // --- destination ---------------------------------------------------------
  const dir = predictedDir(plan, picked, ctx);
  const destLabel = el.querySelector('#ip-dest-label');
  const dest = el.querySelector('#ip-dest');
  if (destLabel) destLabel.textContent = plan.managed ? 'Destination folder' : 'Expected folder';
  if (dest) {
    dest.textContent = dir
      || (picked ? `${picked.id} \u2014 chosen inside ${plan.storeName}` : '\u2014');
  }

  // --- space verdict -------------------------------------------------------
  const sp = el.querySelector('#ip-space');
  if (sp) {
    if (!picked) sp.innerHTML = '';
    else if (need <= 0 || picked.free <= 0) {
      sp.innerHTML = `<div class="ip-note small">${icon('info', 14)}
        <span>Free space on ${esc(picked.id)} could not be read.</span></div>`;
    } else if (picked.free < need) {
      sp.innerHTML = `<div class="ip-note warn small">${icon('warning', 14)}
        <span>${esc(picked.id)} has ${fmtCapacity(picked.free)} free but this needs about
        ${fmtSize(g.size)}. Pick a bigger drive.</span></div>`;
    } else {
      sp.innerHTML = `<div class="ip-note ok small">${icon('checkCircle', 14)}
        <span>Plenty of room \u2014 about ${fmtCapacity(picked.free - need)} left after this install.</span></div>`;
    }
  }

  // --- who does the work ---------------------------------------------------
  const who = el.querySelector('#ip-who');
  if (who) {
    if (plan.managed) {
      who.innerHTML = `<div class="ip-note ok">${icon('hardDrive', 15)}
        <span><b>Apex installs this one.</b> There is no store behind this title, so Apex
        writes it straight to the folder above.</span></div>`;
    } else if (plan.canAutoInstall) {
      who.innerHTML = `<div class="ip-note ok">${icon('download', 15)}
        <span><b>${esc(plan.storeName)} performs this download.</b> Apex uses your real
        licence and hands ${esc(plan.storeName)} this game's own identity, then ${esc(plan.storeName)}
        does the transfer.${plan.platform === 'steam'
          ? ` Apex also pre-registers the install in the drive you picked, so Steam won't ask which
             drive to use \u2014 and Steam's live progress is mirrored right here. If Steam is open,
             Apex restarts it briefly so the change actually sticks.`
          : ''}</span></div>`;
    } else {
      who.innerHTML = `<div class="ip-note">${icon('external', 15)}
        <span><b>Opens ${esc(plan.storeName)}.</b> This store has no direct installer link, so Apex
        opens it and you start the download there.</span></div>`;
    }
  }

  // --- Steam library registration helper -----------------------------------
  const steam = el.querySelector('#ip-steam');
  if (steam) {
    if (plan.platform !== 'steam' || !picked) {
      steam.innerHTML = '';
    } else if (isSteamLib(ctx.libs, picked)) {
      steam.innerHTML = `<div class="ip-note ok small">${icon('checkCircle', 14)}
        <span>${esc(picked.id)} is already a Steam library, so Apex pre-registers the install there
        and Steam will not ask which drive to use.</span></div>`;
    } else {
      const libDir = `${driveRoot(picked)}SteamLibrary`;
      steam.innerHTML = `<div class="ip-note warn col">${icon('warning', 15)}
        <span><b>${esc(picked.id)} is not registered as a Steam library yet.</b>
        Apex registers it as part of the install \u2014 the same change Steam's own
        Settings &gt; Storage makes. A backup is kept, and Steam has to be closed for that one
        step, so Apex closes and reopens it for you.</span>
        <button class="btn secondary" id="ip-addlib" data-dir="${esc(libDir)}">${icon('folder', 15)} Register now</button></div>`;
    }
  }

  // --- primary button ------------------------------------------------------
  const go = el.querySelector('#ip-go');
  if (go) {
    const tooTight = picked && need > 0 && picked.free > 0 && picked.free < need;
    go.disabled = !picked || !!tooTight;
    const verb = plan.kind === 'update' ? 'Update' : 'Install';
    if (plan.managed) go.innerHTML = `${icon('download', 15)} Start ${plan.kind === 'update' ? 'update' : 'download'}`;
    else if (plan.canAutoInstall) go.innerHTML = `${icon(plan.ico, 15)} ${verb} via ${esc(plan.storeName)}`;
    else go.innerHTML = `${icon('external', 15)} Open ${esc(plan.storeName)}`;
  }
}

// ---------------------------------------------------------------------------
// Running the install
// ---------------------------------------------------------------------------
async function runInstall(plan, ctx) {
  const g = byId(plan.id);
  const picked = ctx.drives.find((d) => d.id === ctx.pick) || null;
  const dir = predictedDir(plan, picked, ctx) || installDirFor(plan.id);

  // Remember the choice for this game whichever route we take.
  State.installDirs = State.installDirs || {};
  State.installDirs[plan.id] = dir;

  // --- Apex-managed: the built-in transfer, into the chosen folder ---------
  if (plan.managed) {
    await persist();
    closeModal();
    startDownload(plan.id, plan.kind);
    return;
  }

  // --- No direct installer: open the store client --------------------------
  if (!plan.canAutoInstall) {
    await persist();
    closeModal();
    const store = storeById(plan.platform);
    if (store && store.protocol) {
      try { await window.api.launchGame({ type: 'uri', uri: store.protocol }); } catch { /* client may be absent */ }
    }
    toast(`Opened ${plan.storeName} \u2014 install ${g.title} there`, 'info');
    return;
  }

  // --- Real handoff: the store downloads it --------------------------------
  let registeredLib = null;
  let seedFile = null;
  let seedRestart = false;

  if (plan.platform === 'steam' && picked) {
    const data = await installDriveData();
    const want = `${driveRoot(picked)}SteamLibrary`;
    const alreadyLib = isSteamLib(ctx.libs, picked);
    const steamWasOpen = !!data.steamRunning;

    // Closing and reopening Steam takes ~20s, so say so on the button rather
    // than leaving the dialog looking frozen.
    const go = document.querySelector('.modal #ip-go');
    if (go && steamWasOpen) {
      go.disabled = true;
      go.innerHTML = `${icon('refresh', 15)} Working\u2026`;
    }

    // Steam reads its library list at startup and rewrites libraryfolders.vdf as
    // it closes, so with Steam open *both* changes below would be undone: a newly
    // registered library would be dropped, and a pre-registration would never be
    // read. Closing it first is what makes the picked drive actually stick.
    if (steamWasOpen) await quitSteam();

    // 1. Register the drive as a Steam library - the same change Steam's own
    //    Settings > Storage makes. Picking the drive and pressing Install is the
    //    consent for it, and a backup of libraryfolders.vdf is always kept.
    if (!alreadyLib) {
      try {
        const add = await window.api.addSteamLibrary(want);
        if (add && add.ok) {
          if (!add.already) registeredLib = want;
          ctx.libs = [...(ctx.libs || []), want];
        } else {
          toast((add && add.error) || `Could not register ${picked.id} with Steam`, 'warn');
        }
      } catch (err) {
        toast(`Could not register ${picked.id} with Steam: ${err.message}`, 'warn');
      }
    }

    // 2. Pre-register the app *in that library*, which is what stops Steam
    //    opening its "choose a drive" dialog. See drives.seedManifest.
    const lib = steamLibOnDrive(ctx.libs, picked) || want;
    try {
      const seeded = await window.api.seedManifest({
        appid: plan.appId,
        installdir: safeName(plan.title),
        library: lib
      });
      if (seeded && seeded.ok && !seeded.already) seedFile = seeded.file;
      else if (seeded && !seeded.ok && seeded.error) toast(seeded.error, 'warn');
    } catch (err) {
      toast(`Could not pre-register the install: ${err.message}`, 'warn');
    }

    // 3. Bring Steam back so it reads both changes, then hand it the install.
    if (steamWasOpen) {
      const back = await startSteam(data.steamExe);
      // If Steam would not come back the stub is still on disk, so flag the
      // handoff to offer a retry rather than sitting silent.
      seedRestart = !back;
    }
  }

  const res = await window.api.installStart({
    platform: plan.platform,
    appId: plan.appId,
    namespace: plan.namespace,
    catalogId: plan.catalogId,
    appName: plan.appName,
    id: plan.id,
    name: g.title
  });

  if (!res || !res.ok) {
    // Nothing was handed over, so take the pre-registration back out rather than
    // leaving Steam thinking an install is queued.
    if (seedFile) { try { await window.api.removeManifest(seedFile); } catch { /* best effort */ } }
    toast(`Could not start the install: ${(res && res.error) || 'unknown error'}`, 'warn');
    const open = document.querySelector('.modal');
    if (open) paintInstall(open, plan, ctx);          // put the button back
    return;
  }

  closeModal();
  await persist();
  beginHandoff(plan, dir, { registeredLib, seedFile, seedRestart });
}

/** Records a store-handled install and surfaces it on the Downloads page. */
function beginHandoff(plan, dir, opts = {}) {
  HANDOFFS.unshift({
    id: plan.id,
    title: plan.title,
    platform: plan.platform,
    storeName: plan.storeName,
    appId: plan.appId || null,
    dir,
    registeredLib: opts.registeredLib || null,
    seedFile: opts.seedFile || null,
    seedRestart: !!opts.seedRestart,
    at: Date.now(),
    landed: false,
    progress: null
  });
  if (HANDOFFS.length > 8) HANDOFFS.pop();

  if (opts.registeredLib) toast(`${opts.registeredLib} registered with Steam`, 'check');
  toast(`${plan.storeName} is downloading ${plan.title}\u2026`, 'download');
  openDrawer();
  drawerSig = '__init__';
  renderDrawer();
  startHandoffWatch();
  refreshActions();
  if (typeof current !== 'undefined' && current === 'downloads') render(false);
}

/**
 * Deletes the pre-registration stub Apex wrote for this handoff, so a download
 * Steam never picked up does not leave the app stuck as "queued" forever.
 */
async function undoSeed(h) {
  if (!h || !h.seedFile) return;
  const res = await window.api.removeManifest(h.seedFile);
  if (res && res.ok) {
    h.seedFile = null;
    toast(`Removed the pre-registration for ${h.title}`, 'check');
  } else {
    toast((res && res.error) || 'Could not remove the pre-registration', 'warn');
  }
  drawerSig = '__init__';                 // the row's own content changed
  renderDrawer();
  if (typeof current !== 'undefined' && current === 'downloads') render(false);
}

/**
 * Closes Steam and waits for it to actually go away. Steam writes its library
 * list as it exits, so libraryfolders.vdf must not be touched until it is gone.
 * Returns true once the process is confirmed dead.
 */
async function quitSteam() {
  toast('Closing Steam to apply the change\u2026', 'info');
  try { await window.api.launchGame({ type: 'uri', uri: 'steam://exit' }); } catch { /* may already be gone */ }

  for (let i = 0; i < 30; i++) {                    // up to ~15s
    await new Promise((r) => setTimeout(r, 500));
    const res = await window.api.steamRunning();
    if (res && res.ok && !res.running) return true;
  }
  toast('Steam is taking a while to close', 'warn');
  return false;
}

/** Starts Steam again, so it re-reads the libraries and picks up the change. */
async function startSteam(exe) {
  if (!exe) return false;
  toast('Starting Steam again\u2026', 'info');
  try { await window.api.openPath(exe); } catch { return false; }

  for (let i = 0; i < 40; i++) {                    // up to ~20s
    await new Promise((r) => setTimeout(r, 500));
    const res = await window.api.steamRunning();
    if (res && res.ok && res.running) return true;
  }
  return false;
}

/**
 * Restarts Steam so it re-reads its libraries and notices a pre-registration
 * that was written while it was running. This is the manual version of what an
 * install does for itself.
 */
async function restartSteam() {
  const data = await installDriveData(true);
  await quitSteam();                                 // carry on even if it was slow
  const back = await startSteam(data && data.steamExe);
  if (!back) { toast('Steam did not come back up \u2014 open it yourself when you can', 'warn'); return; }

  for (const h of HANDOFFS) if (h.seedFile) h.seedRestart = false;
  toast('Steam restarted \u2014 it should pick the install up now', 'check');
  drawerSig = '__init__';                 // the row's own content changed
  renderDrawer();
  if (typeof current !== 'undefined' && current === 'downloads') render(false);
}

// ---------------------------------------------------------------------------
// Live progress for store-handled installs
// ---------------------------------------------------------------------------
/**
 * Steam publishes real byte counters in the appmanifest of whatever it is
 * installing, so a handoff can show Steam's own percentage instead of a
 * decorative sweep. Apex only reads that file - it never touches the transfer.
 *
 * Platforms that expose no such file (Epic, GOG, ...) keep the sweeping bar and
 * the manual "Check now" button, because inventing a number would be a lie.
 */
let HANDOFF_TIMER = null;
const HANDOFF_TICK = 1500;

/** Handoffs whose platform publishes machine-readable progress. */
const measurableHandoffs = () => HANDOFFS.filter((h) => h.platform === 'steam' && h.appId);

function startHandoffWatch() {
  if (HANDOFF_TIMER || !measurableHandoffs().length) return;
  HANDOFF_TIMER = setInterval(pollHandoffs, HANDOFF_TICK);
  pollHandoffs();
}

function stopHandoffWatch() {
  if (!HANDOFF_TIMER) return;
  clearInterval(HANDOFF_TIMER);
  HANDOFF_TIMER = null;
}

/** The one-line status for a handoff - shared by the drawer and the page. */
function handoffLine(h) {
  const p = h.progress;
  if (!p) {
    if (h.seedRestart) return 'Restart Steam so it picks this up\u2026';
    return h.platform === 'steam' ? 'Waiting for Steam\u2026' : `Downloading in ${h.storeName}\u2026`;
  }
  if (p.state === 'preparing' && p.pct == null) return 'Steam is preparing the download\u2026';

  const bits = [];
  if (p.pct != null) bits.push(`${p.pct.toFixed(1)}%`);
  if (p.toDownload > 0) bits.push(`${fmtTransferBytes(p.downloaded)} of ${fmtTransferBytes(p.toDownload)}`);
  if (p.speed > 0) bits.push(`${(p.speed / BYTES_MB).toFixed(1)} MB/s`);
  if (!bits.length) {
    return p.active ? `Downloading in ${h.storeName}\u2026` : `Queued in ${h.storeName}\u2026`;
  }
  return bits.join(' \u00b7 ');
}

/** Updates every visible handoff row in place (drawer + Downloads page). */
function paintHandoffs() {
  for (const h of HANDOFFS) {
    const pct = h.progress && h.progress.pct != null ? h.progress.pct : null;

    document.querySelectorAll(`[data-hbar="${h.id}"]`).forEach((bar) => {
      const track = bar.parentElement;
      if (track) track.classList.toggle('indeterminate', pct == null);
      bar.style.width = pct == null ? '' : `${pct.toFixed(1)}%`;
    });
    document.querySelectorAll(`[data-hline="${h.id}"]`).forEach((el) => {
      el.textContent = handoffLine(h);
    });
  }
}

/** Reads the stores' own progress and repaints the queue. */
async function pollHandoffs() {
  const watch = measurableHandoffs();
  if (!watch.length) { stopHandoffWatch(); return; }

  let data = null;
  try { data = await window.api.steamProgress(); } catch { return; }
  const apps = (data && data.apps) || {};

  let landed = false;
  for (const h of watch) {
    const rec = apps[String(h.appId)];
    if (!rec) continue;

    const prev = h.progress;
    const now = Date.now();

    // Speed comes from real byte movement across two reads, never a guess.
    // Staging counts too, because that is where the bytes land once downloaded.
    const bytes = (rec.downloaded || 0) + (rec.staged || 0);
    const prevBytes = prev ? prev.bytes : null;
    let speed = (prev && prev.speed) || 0;
    if (prevBytes != null && bytes > prevBytes && prev.at) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0.25) speed = (bytes - prevBytes) / dt;
    }
    if (!rec.active) speed = 0;

    h.progress = {
      pct: rec.pct,
      downloaded: rec.downloaded,
      toDownload: rec.toDownload,
      staged: rec.staged,
      toStage: rec.toStage,
      bytes,
      onDisk: rec.onDisk,
      active: rec.active,
      installed: rec.installed,
      state: rec.state,
      speed,
      at: now
    };

    if (rec.installed && rec.state === 'installed' && !h.landed) {
      h.landed = true;
      landed = true;
    }
  }

  renderDrawer();
  paintHandoffs();

  // Steam now has the game on disk: one re-scan and it moves out of the queue
  // and into the Library by itself.
  if (landed) {
    try { await scanLibraries(false); } catch { /* a failed scan changes nothing */ }
    renderDrawer();
    if (typeof current !== 'undefined' && current === 'downloads') render(false);
    if (!measurableHandoffs().length) stopHandoffWatch();
  }
}

/** Drops a handoff entry once the game really shows up installed. */
function reconcileHandoffs() {
  let finished = 0;
  for (let i = HANDOFFS.length - 1; i >= 0; i--) {
    if (!isInstalled(HANDOFFS[i].id)) continue;
    const h = HANDOFFS.splice(i, 1)[0];
    finished++;
    toast(`${h.title} finished installing in ${h.storeName}`, 'check');
  }
  if (!measurableHandoffs().length) stopHandoffWatch();
  return finished;
}

/**
 * Re-scans the local stores for a handed-off install that has now landed on
 * disk. Shared by the Downloads page and the bottom drawer.
 */
async function recheckHandoff(btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon('refresh', 14)} \u2026`;
  }
  try {
    if (typeof scanLibraries === 'function') await scanLibraries(false);
  } catch { /* a failed scan just means nothing changed */ }

  const finished = reconcileHandoffs();
  await pollHandoffs();
  renderDrawer();
  if (typeof current !== 'undefined' && (current === 'downloads' || current === 'library' || current === 'store')) {
    render(false);
  }
  if (!finished) {
    toast(HANDOFFS.length
      ? `Still downloading in ${HANDOFFS.map((h) => h.storeName).join(', ')}`
      : 'Nothing to check', 'info');
  }
}

// ---------------------------------------------------------------------------
// Settings > Downloads & Storage
// ---------------------------------------------------------------------------
/** The folder Apex-managed installs land in by default. */
function defaultInstallRoot() {
  const s = State.settings || {};
  if (s.installDrive) return `${String(s.installDrive).replace(/[\\/]+$/, '')}\\ApexGames`;
  return s.installPath || 'Not set';
}

/** A drive row, shared by the installer dialog and the Settings page. */
function driveRowHtml(d, ctx = {}) {
  const on = d.id === ctx.chosen;
  const lib = isSteamLib(ctx.libs, d);
  const tight = ctx.need > 0 && d.free > 0 && d.free < ctx.need;
  return `<button class="drive-row${on ? ' on' : ''}${tight ? ' tight' : ''}" data-drive="${esc(d.id)}"
      title="${esc(d.root)} \u2014 ${fmtCapacity(d.free)} free">
    <span class="drive-radio"></span>
    <span class="drive-main">
      <strong>${esc(d.id)} <span class="drive-name">${esc(d.name)}</span></strong>
      <small>${fmtCapacity(d.free)} free of ${fmtCapacity(d.total)}${lib ? ' \u00b7 Steam library' : ''}${d.kind && d.kind !== 'fixed' ? ` \u00b7 ${esc(d.kind)}` : ''}</small>
    </span>
    <span class="drive-tags">
      ${lib ? `<span class="d-tag lib">${icon('gamepad', 12)} Steam</span>` : ''}
      ${tight ? `<span class="d-tag bad">${icon('warning', 12)} Too small</span>` : ''}
    </span>
  </button>`;
}

/** Paints the live drive list on the Settings page and wires the choice. */
async function fillSettingsDrives(el) {
  const box = el.querySelector('#set-drives');
  if (!box) return;

  const data = await installDriveData();
  const drives = data.drives || [];
  const libs = data.steamLibraries || [];
  const chosen = State.settings.installDrive
    || (State.settings.installPath || '').slice(0, 2)
    || (drives[0] ? drives[0].id : null);

  box.innerHTML = drives.length
    ? drives.map((d) => driveRowHtml(d, { chosen, libs, need: 0 })).join('')
    : `<div class="ip-note warn">${icon('warning', 15)} <span>No drives could be read on this PC.</span></div>`;

  const dest = el.querySelector('#set-dest');
  if (dest) dest.textContent = defaultInstallRoot();

  // Wire once: the container element survives re-paints, so re-adding here
  // would stack duplicate listeners.
  if (box.dataset.wired === '1') return;
  box.dataset.wired = '1';

  box.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-drive]');
    if (!row) return;
    State.settings.installDrive = row.dataset.drive;
    State.settings.installPath = `${row.dataset.drive.replace(/[\\/]+$/, '')}\\ApexGames`;
    await persist();
    await fillSettingsDrives(el);
    toast(`New installs default to ${row.dataset.drive}`, 'check');
  });

  const custom = el.querySelector('#set-custom');
  if (custom) custom.addEventListener('click', async () => {
    const picked = await window.api.pickFolder(State.settings.installPath);
    if (!picked) return;
    State.settings.installPath = picked;
    State.settings.installDrive = null;
    await persist();
    await fillSettingsDrives(el);
    toast('Install folder updated', 'check');
  });
}

