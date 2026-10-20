'use strict';

/**
 * Download & install manager.
 *
 * Downloads are simulated locally but share the UX shape of a real client:
 * a persistent queue, live progress/speed/ETA, pause/resume/cancel, a bottom
 * drawer, a full Downloads page and a Download Manager modal that opens when
 * the user installs something from the store.
 *
 * When a download finishes the game becomes `installed`, which is what moves it
 * out of the Store and into the Library.
 */

const DL = {};        // id -> active record
const HISTORY = [];   // most recent completed records
const DL_RESULT = {}; // id -> 'done' | 'cancelled' | 'error' (for the modal)
const DL_ERROR = {};  // id -> failure message, shown when DL_RESULT[id] === 'error'

let drawerSig = '__init__';
let drawerSuppressed = false; // user dismissed the drawer; don't auto-reopen
let dlModalId = null;         // game currently shown in the Download Manager

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function remainingSec(d) {
  if (d.paused || d.speed <= 0) return Infinity;
  const g = byId(d.id);
  const remainMB = g.size * 1024 * (1 - d.pct / 100);
  return remainMB / d.speed;
}

function aggregate(ids) {
  const total = ids.reduce((a, id) => a + byId(id).size, 0);
  const done = ids.reduce((a, id) => a + byId(id).size * (DL[id].pct / 100), 0);
  const speed = ids.reduce((a, id) => a + (DL[id].paused ? 0 : DL[id].speed), 0);
  return {
    pct: total ? (done / total) * 100 : 0,
    speed,
    total,
    done,
    sec: speed > 0 ? ((total - done) * 1024) / speed : Infinity
  };
}

/** "C:\Program Files\Apex\Games" -> "…\Apex\Games" */
function shortPath(p) {
  if (!p) return '\u2014';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `\u2026\\${parts.slice(-2).join('\\')}` : p;
}

/** Re-renders whichever view cares about the installed/available split. */
function afterLibraryChange() {
  // Anything that just joined the library should show real art straight away.
  // A detected Steam title carries its own AppID, so this is normally instant;
  // ensureArt de-duplicates and guards itself, so calling it often is cheap.
  if (typeof ensureArt === 'function' && typeof allGames === 'function') ensureArt(allGames());

  if (typeof current === 'undefined') return;
  if (current === 'detail') {
    // Don't blow away the scroll position: just refresh the action bar.
    if (typeof refreshDetailBar === 'function') refreshDetailBar();
    return;
  }
  if (current === 'store' || current === 'library' || current === 'downloads') render(false);
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

// Where a Nexus title is being fetched from. The engine reports the
// resolved provider on each job event so the drawer can say which mirror won.
const MIRROR_LABELS = {
  gofile: 'GoFile',
  buzzheavier: 'Buzzheavier',
  fileditch: 'FileDitch',
  pixeldrain: 'Pixeldrain',
  mediafire: 'MediaFire',
  mega: 'MEGA',
  '1fichier': '1Fichier',
  datanodes: 'Datanodes',
  workupload: 'WorkUpload',
  sabercathost: 'SaberCatHost',
  rootz: 'Rootz',
  megadb: 'MegaDB',
  webtorrent: 'WebTorrent',
  direct: 'direct link'
};

function mirrorLabel(key) {
  const k = String(key || '').toLowerCase();
  return MIRROR_LABELS[k] || String(key || '');
}
/**
 * @param {string} id
 * @param {'install'|'update'} kind
 * @param {object|null} extra  provider-specific fields forwarded to the engine
 *   (itch.io sends `{ provider, gameId, uploadId, filename, size, extract }`).
 */
async function startDownload(id, kind = 'install', extra = null) {
  if (DL[id]) return;
  const g = byId(id);
  if (!g) return;

  // Ownership gate: never download something this account does not own.
  if (!isOwned(id)) {
    toast(`${g.title} is not owned on this account \u2014 it cannot be downloaded here`, 'warn');
    return;
  }

  delete DL_RESULT[id];
  delete DL_ERROR[id];
  DL[id] = { id, kind, pct: 0, paused: false, speed: 0, phase: 'Preparing', started: Date.now() };

  toast(`${kind === 'update' ? 'Updating' : 'Installing'} ${g.title}\u2026`, 'download');
  openDrawer();
  drawerSig = '__init__';
  renderDrawer();
  refreshActions();

  // Installing from the store opens the download manager straight away.
  openDownloadModal(id);

  // The main process owns the real transfer (installs.js). It reports progress
  // on the `dl:event` stream; a refusal here is a plain, displayable error
  // (host policy, missing checksum, or no configured source for this title).
  try {
    const res = await window.api.dlStart({ id, title: g.title, kind, ...(extra || {}) });
    if (!res || res.ok === false) throw new Error((res && res.error) || 'Download could not be started');
    if (res.job) applyDownloadEvent(res.job);
  } catch (err) {
    failDownload(id, err && err.message ? err.message : String(err));
  }
}

/**
 * Applies one engine event to the local queue record.
 * Events carry the full job view, so a renderer reload can reattach cleanly.
 */
function applyDownloadEvent(evt) {
  if (!evt || !evt.id) return;
  const id = evt.id;
  const g = byId(id);
  if (!g) return;

  // A transfer can be won before the renderer ever sees a progress tick (fast
  // local copy, reload mid-install), so make sure a record exists first.
  const ensureRecord = () => {
    let rec = DL[id];
    if (!rec) {
      rec = DL[id] = { id, kind: evt.kind || 'install', pct: 0, paused: false, speed: 0, phase: evt.phase, started: Date.now() };
      drawerSig = '__init__';
    }
    return rec;
  };

  if (evt.state === 'done') { ensureRecord(); finishDownload(id, evt.dest); return; }
  if (evt.state === 'cancelled') { if (DL[id]) cancelLocal(id); return; }
  if (evt.state === 'error') { ensureRecord(); failDownload(id, evt.error || 'Download failed'); return; }

  const d = ensureRecord();
  d.pct = Number(evt.pct) || 0;
  d.paused = !!evt.paused;
  d.state = evt.state;
  d.phase = evt.phase || d.phase;
  d.mirror = evt.mirror || d.mirror;
  // The engine reports bytes per second; every painter wants MB/s.
  d.speed = d.paused ? 0 : (Number(evt.speedBps) || 0) / (1024 * 1024);

  renderDrawer();
  renderDownloadModal();
}

function finishDownload(id, dest) {
  const d = DL[id];
  if (!d) return;
  const g = byId(id);
  delete DL[id];

  // This is what promotes the game from the Store into the Library.
  State.installed[id] = true;
  State.owned[id] = true;
  delete State.updates[id];
  if (State.dismissed) delete State.dismissed[id];
  // Remember where the engine actually put it, so "open folder" and a later
  // re-verify point at the real install rather than the default games folder.
  if (dest && State.installDirs) State.installDirs[id] = dest;

  HISTORY.unshift({ id, kind: d.kind, at: Date.now() });
  if (HISTORY.length > 12) HISTORY.pop();
  DL_RESULT[id] = 'done';
  delete DL_ERROR[id];
  persist();

  toast(`${g.title} ${d.kind === 'update' ? 'updated' : 'installed'}`, 'check');
  drawerSig = '__init__';
  renderDrawer();
  refreshActions();
  afterLibraryChange();
  renderDownloadModal();
}

/** Removes a local record after the engine reports a terminal failure. */
function failDownload(id, message) {
  delete DL[id];
  DL_RESULT[id] = 'error';
  DL_ERROR[id] = message || 'Download failed';
  toast(message || 'Download failed', 'warn');
  drawerSig = '__init__';
  renderDrawer();
  refreshActions();
  renderDownloadModal();
  if (typeof current !== 'undefined' && current === 'downloads') render(false);
}

/**
 * Pausing only means anything while the engine is still moving bytes.
 *
 * Past the transfer the bar is running through verification, extraction or the
 * install itself, and there is no socket to suspend - so offering Pause there
 * would freeze the label while the work carried on behind it.
 */
function dlPausable(d) {
  return !d.state || d.state === 'downloading' || d.state === 'paused';
}

function pauseDownload(id) {
  const d = DL[id];
  if (!d || d.paused) return;
  if (!dlPausable(d)) {
    toast('Pause only applies while the download is still running.', 'warn');
    return;
  }
  d.paused = true;
  d.speed = 0;
  d.phase = 'Paused';
  d.state = 'paused';
  if (window.api && window.api.dlPause) window.api.dlPause(id).catch(() => {});
  drawerSig = '__init__';
  renderDrawer();
  refreshActions();
  renderDownloadModal();
}

function resumeDownload(id) {
  const d = DL[id];
  if (!d || !d.paused) return;
  d.paused = false;
  d.phase = 'Downloading';
  d.state = 'downloading';
  if (window.api && window.api.dlResume) window.api.dlResume(id).catch(() => {});
  drawerSig = '__init__';
  renderDrawer();
  refreshActions();
  renderDownloadModal();
}

function cancelDownload(id) {
  const d = DL[id];
  if (!d) return;
  if (window.api && window.api.dlCancel) window.api.dlCancel(id).catch(() => {});
  cancelLocal(id);
}

/** Local teardown shared by a user cancel and an engine 'cancelled' event. */
function cancelLocal(id) {
  delete DL[id];
  DL_RESULT[id] = 'cancelled';
  delete DL_ERROR[id];
  toast('Download cancelled', 'warn');
  drawerSig = '__init__';
  renderDrawer();
  refreshActions();
  renderDownloadModal();
  if (typeof current !== 'undefined' && current === 'downloads') render(false);
}

// ---------------------------------------------------------------------------
// DOM painting
// ---------------------------------------------------------------------------
/**
 * The stage label plus the transfer numbers that belong beside it.
 *
 * Speed and ETA only mean anything while bytes are moving: during verification
 * and extraction the bar tracks the stage instead, so those numbers are dropped
 * rather than left sitting at a stale zero.
 */
function stageText(d) {
  const phase = d.paused ? 'Paused' : (d.phase || 'Downloading');
  const moving = !d.paused && /download|prepar|copy/i.test(phase);
  const mbps = `${(Number(d.speed) || 0).toFixed(0)} MB/s`;
  // The engine names its stages in English and the DOM pass cannot help here:
  // these labels are rewritten on every progress tick, which would paint the
  // English straight back over a translation. So they are translated at the
  // source instead.
  const label = (typeof t === 'function') ? t(phase) : phase;
  return {
    phase: label,
    speed: d.paused ? label : moving ? mbps : '\u2014',
    eta: d.paused ? '--' : moving ? fmtEta(remainingSec(d)) : '\u2014',
    detail: moving ? `${mbps} \u00b7 ${fmtEta(remainingSec(d))} left` : ''
  };
}

function paint(id) {
  const d = DL[id];
  if (!d) return;
  const st = stageText(d);

  document.querySelectorAll(`[data-bar="${id}"]`).forEach((b) => { b.style.width = d.pct + '%'; });
  document.querySelectorAll(`[data-pct="${id}"]`).forEach((b) => { b.textContent = `${Math.floor(d.pct)}%`; });
  document.querySelectorAll(`[data-phase="${id}"]`).forEach((b) => { b.textContent = st.phase; });
  document.querySelectorAll(`[data-detail="${id}"]`).forEach((b) => { b.textContent = st.detail ? ` \u00b7 ${st.detail}` : ''; });
  document.querySelectorAll(`[data-speed="${id}"]`).forEach((b) => { b.textContent = st.speed; });
  document.querySelectorAll(`[data-eta="${id}"]`).forEach((b) => { b.textContent = st.eta; });
  document.querySelectorAll(`[data-downloaded="${id}"]`).forEach((b) => {
    b.textContent = fmtSize(byId(id).size * (d.pct / 100));
  });

  // The toggle is state, not just a label. A row is repainted on every progress
  // tick, and without this a paused row kept offering "Pause" - a button that
  // politely did nothing, which turned a pause into a stop you could not undo.
  document.querySelectorAll(`[data-dl-toggle="${id}"]`).forEach((b) => {
    const act = d.paused ? 'resume' : 'pause';
    if (b.dataset.act === act) return;
    b.dataset.act = act;
    b.title = d.paused ? 'Resume' : 'Pause';
    b.innerHTML = icon(d.paused ? 'play' : 'pause', Number(b.dataset.ico) || 14);
  });
}

function dlRow(id) {
  const g = byId(id);
  const d = DL[id];
  if (!g || !d) return '';
  const label = d.kind === 'update' ? 'Updating' : 'Installing';
  const st = stageText(d);
  return `<div class="dl-row" data-dl-row="${id}">
    <div class="dl-thumb">${art(g, 'wide')}</div>
    <div class="dl-body">
      <div class="dl-row-top">
        <strong>${esc(g.title)}</strong>
        <span class="dl-kind">${icon(d.kind === 'update' ? 'refresh' : 'download', 13)} ${label}</span>
        <span class="dl-row-actions">
          <button class="icon-btn sm" data-act="${d.paused ? 'resume' : 'pause'}" data-id="${id}" data-dl-toggle="${id}" data-ico="14" title="${d.paused ? 'Resume' : 'Pause'}">${icon(d.paused ? 'play' : 'pause', 14)}</button>
          <button class="icon-btn sm" data-act="cancel" data-id="${id}" title="Cancel">${icon('close', 14)}</button>
        </span>
      </div>
      <div class="bar"><div data-bar="${id}" style="width:${d.pct}%"></div></div>
      <div class="dl-row-meta">
        <small><span data-downloaded="${id}">${fmtSize(g.size * (d.pct / 100))}</span> / ${fmtSize(g.size)}</small>
        <small><span data-phase="${id}">${esc(st.phase)}</span> &middot; <span data-pct="${id}">${Math.floor(d.pct)}%</span><span data-detail="${id}">${st.detail ? ` &middot; ${esc(st.detail)}` : ''}</span></small>
      </div>
    </div>
  </div>`;
}

function renderDrawer(force) {
  const drawer = document.getElementById('drawer');
  if (!drawer) return;
  const ids = Object.keys(DL);
  // Store-handled installs (Steam/Epic are doing the transfer, not us).
  const extras = (typeof HANDOFFS !== 'undefined') ? HANDOFFS : [];
  const total = ids.length + extras.length;

  // badges
  const badge = document.getElementById('dl-badge');
  if (badge) { badge.textContent = total; badge.style.display = total ? 'flex' : 'none'; }
  const navBadge = document.getElementById('nav-dl-badge');
  if (navBadge) { navBadge.textContent = total; navBadge.style.display = total ? 'inline-flex' : 'none'; }

  drawer.classList.toggle('hidden', total === 0 || drawerSuppressed);
  document.body.classList.toggle('has-drawer', total > 0 && !drawerSuppressed);

  const sig = `${ids.join('|')}::${extras.map((h) => h.id).join('|')}`;
  if (force || sig !== drawerSig) {
    drawerSig = sig;
    const list = document.getElementById('drawer-list');
    if (list) {
      list.innerHTML = ids.map(dlRow).join('') + extras.map(handoffDrawerRow).join('');
      // The rows carry the stage names and the row buttons; the rest of the
      // drawer is static markup and was translated once at start-up.
      if (typeof applyI18n === 'function') applyI18n(list);
    }
  }
  ids.forEach(paint);
  if (extras.length) paintHandoffs();
  paintSummaryActions(ids);

  const agg = aggregate(ids);
  const bar = document.getElementById('d-agg-bar');
  if (bar) bar.style.width = `${agg.pct}%`;

  const title = document.getElementById('d-title');
  const sub = document.getElementById('d-sub');
  const count = document.getElementById('d-count');
  if (ids.length) {
    if (title) title.textContent = `${ids.length} download${ids.length > 1 ? 's' : ''} active`;
    if (sub) sub.textContent = `${agg.speed.toFixed(0)} MB/s \u00b7 ${fmtSize(agg.done)} / ${fmtSize(agg.total)} \u00b7 ${fmtEta(agg.sec)} left`;
    if (count) count.textContent = `${Math.floor(agg.pct)}%`;
  } else if (extras.length) {
    // Store downloads carry the store's own real percentage when it publishes one.
    const measured = extras.filter((h) => h.progress && h.progress.pct != null);
    if (title) title.textContent = `${extras.length} store download${extras.length > 1 ? 's' : ''}`;
    if (sub) {
      sub.textContent = measured.length
        ? measured.map((h) => `${h.title} ${h.progress.pct.toFixed(0)}%`).join(' \u00b7 ')
        : `Downloading in ${[...new Set(extras.map((h) => h.storeName))].join(', ')}`;
    }
    if (count) count.textContent = measured.length ? `${Math.floor(measured[0].progress.pct)}%` : '';
  } else {
    if (title) title.textContent = 'Downloads';
    if (sub) sub.textContent = 'Idle \u00b7 nothing in the queue';
    if (count) count.textContent = '';
  }
}

/**
 * The page's bulk button follows the queue rather than the moment it was drawn.
 *
 * Once every download is held the useful button is "Resume all": a "Pause all"
 * that cannot pause anything is a button that does nothing, which is how a
 * paused queue ended up looking un-resumable.
 */
function paintSummaryActions(ids) {
  const host = document.querySelector('.dl-summary-actions');
  if (!host) return;
  const btn = host.querySelector('[data-act="pause-all"], [data-act="resume-all"]');
  if (!btn) return;
  const held = ids.length > 0 && ids.every((id) => DL[id].paused);
  const want = held ? 'resume-all' : 'pause-all';
  if (btn.dataset.act === want) return;
  btn.dataset.act = want;
  btn.innerHTML = held ? `${icon('play', 14)} Resume all` : `${icon('pause', 14)} Pause all`;
}

/**
 * A store-handled install inside the bottom drawer.
 *
 * When the store publishes real progress on disk (Steam does, via its
 * appmanifest) the bar fills with the store's own percentage and live speed.
 * When it does not, the bar keeps sweeping and the row offers a manual
 * re-check instead of a made-up number.
 */
function handoffDrawerRow(h) {
  const pct = h.progress && h.progress.pct != null ? h.progress.pct : null;
  // These only show while Steam has not started: once bytes move, the
  // appmanifest is Steam's own file and deleting it would break the install.
  const stuck = !h.progress;
  const restart = h.seedRestart && stuck
    ? `<button class="icon-btn sm" data-restart-steam="1" title="Restart Steam so it picks this up">${icon('power', 14)}</button>`
    : '';
  const undo = h.seedFile && stuck
    ? `<button class="icon-btn sm" data-undo="${esc(h.id)}" title="Remove Apex's pre-registration">${icon('trash', 14)}</button>`
    : '';
  return `<div class="dl-row handoff-row-sm">
    <div class="dl-thumb handoff-thumb">${icon('external', 22)}</div>
    <div class="dl-body">
      <div class="dl-row-top">
        <strong>${esc(h.title)}</strong>
        <span class="dl-kind">${icon('download', 13)} ${esc(h.storeName)}</span>
        <span class="dl-row-actions">${restart}${undo}
          <button class="icon-btn sm" data-recheck="${esc(h.id)}" title="Check now">${icon('refresh', 14)}</button>
        </span>
      </div>
      <div class="bar${pct == null ? ' indeterminate' : ''}"><div data-hbar="${esc(h.id)}"${pct == null ? '' : ` style="width:${pct.toFixed(1)}%"`}></div></div>
      <div class="dl-row-meta">
        <small data-hline="${esc(h.id)}">${esc(handoffLine(h))}</small>
        <small class="handoff-path">${esc(h.dir || '')}</small>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Download Manager modal
// ---------------------------------------------------------------------------
function openDownloadModal(id) {
  dlModalId = id || Object.keys(DL)[0] || (HISTORY[0] && HISTORY[0].id) || null;
  const modal = document.getElementById('dl-modal');
  const body = document.getElementById('dlm-body');
  if (body) body.dataset.sig = '';
  if (modal) { modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); }
  renderDownloadModal();
}

function closeDownloadModal() {
  const modal = document.getElementById('dl-modal');
  if (modal) { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }
}

function dlModalSig() {
  if (!dlModalId) return `none|${Object.keys(DL).length}`;
  const d = DL[dlModalId];
  // The stage is part of the signature so the note above the queue keeps up
  // with "Verifying" -> "Extracting" -> "Installing" instead of going stale.
  const phase = d ? (d.paused ? 'paused' : (d.phase || 'active')) : (DL_RESULT[dlModalId] || 'idle');
  return `${dlModalId}|${phase}|${DL_ERROR[dlModalId] || ''}|${Object.keys(DL).length}`;
}

function dlModalBody() {
  const id = dlModalId;
  if (!id) {
    return `<div class="dlm-empty">${icon('checkCircle', 34)}
      <h2>Nothing in the queue</h2>
      <p>Install a game from the Store and it will show up here.</p></div>`;
  }

  const g = byId(id);
  if (!g) return '';
  const d = DL[id];
  const price = isFree(g) ? 'Free to Play' : g.price;

  // --- downloading / paused ------------------------------------------------
  if (d) {
    const label = d.kind === 'update' ? 'Updating' : 'Installing';
    const st = stageText(d);
    const others = Object.keys(DL).filter((x) => x !== id);
    return `
      <div class="dlm-hero">
        ${art(g, 'wide')}
        <div class="dlm-hero-shade"></div>
        <div class="dlm-hero-text">
          <span class="dlm-kind">${icon(d.kind === 'update' ? 'refresh' : 'download', 13)} ${label}</span>
          <h2>${esc(g.title)}</h2>
          <small>${esc(g.developer)} &middot; ${fmtSize(g.size)} &middot; ${esc(price)}</small>
        </div>
      </div>

      <div class="dlm-progress">
        <div class="bar big"><div data-bar="${id}" style="width:${d.pct}%"></div></div>
        <div class="dlm-progress-row">
          <span class="dlm-pct" data-pct="${id}">${Math.floor(d.pct)}%</span>
          <span class="dlm-nums"><span data-phase="${id}">${esc(st.phase)}</span> &middot; <span data-downloaded="${id}">${fmtSize(g.size * (d.pct / 100))}</span> / ${fmtSize(g.size)}</span>
        </div>
        <div class="dlm-stats">
          <div><small>Speed</small><strong data-speed="${id}">${esc(st.speed)}</strong></div>
          <div><small>Time left</small><strong data-eta="${id}">${esc(st.eta)}</strong></div>
          <div><small>Install to</small><strong title="${esc(State.settings.installPath || '')}">${esc(shortPath(State.settings.installPath))}</strong></div>
        </div>
      </div>

      <div class="dlm-actions">
        <button class="btn secondary" data-act="${d.paused ? 'resume' : 'pause'}" data-id="${id}">
          ${icon(d.paused ? 'play' : 'pause', 15)} ${d.paused ? 'Resume' : 'Pause'}
        </button>
        <button class="btn danger" data-act="cancel" data-id="${id}">${icon('close', 15)} Cancel</button>
      </div>

      <p class="dlm-note">${icon('info', 14)} ${d.phase && d.phase !== 'Downloading' ? `${esc(d.phase)} \u00b7 ` : ''}${d.mirror ? `via ${esc(mirrorLabel(d.mirror))} \u00b7 ` : ''}Fetched by the Apex download engine from your configured source, then verified and installed. When it completes, the game moves into your Library automatically.</p>

      ${others.length ? `<h4 class="dlm-sub-title">${icon('list', 15)} Also in the queue</h4>
        <div class="dlm-queue">${others.map(dlRow).join('')}</div>` : ''}`;
  }

  // --- failed ----------------------------------------------------------------
  if (DL_RESULT[id] === 'error') {
    return `<div class="dlm-done">
      <span class="dlm-done-ico warn">${icon('warning', 32)}</span>
      <h2>Download failed</h2>
      <p>${esc(DL_ERROR[id] || 'The download could not be completed.')}</p>
      <div class="dlm-actions">
        <button class="btn primary glow" data-act="install" data-id="${id}">${icon('refresh', 15)} Try again</button>
      </div>
    </div>`;
  }

  // --- finished ------------------------------------------------------------
  if (DL_RESULT[id] === 'cancelled') {
    return `<div class="dlm-done">
      <span class="dlm-done-ico warn">${icon('close', 32)}</span>
      <h2>Download cancelled</h2>
      <p>${esc(g.title)} was not installed.</p>
      <div class="dlm-actions">
        <button class="btn primary glow" data-act="install" data-id="${id}">${icon('refresh', 15)} Try again</button>
      </div>
    </div>`;
  }

  if (isInstalled(id)) {
    const linked = !!localLink(id);
    return `<div class="dlm-done">
      <span class="dlm-done-ico">${icon('checkCircle', 36)}</span>
      <h2>${esc(g.title)} is ready</h2>
      <p>Added to your Library${linked ? ' and linked to a local install' : ''}.</p>
      <div class="dlm-done-art">${art(g, 'wide')}</div>
      <div class="dlm-actions">
        <button class="btn primary glow" data-act="play" data-id="${id}">${icon('play', 15)} Launch</button>
        <button class="btn secondary" id="dlm-goto-lib">${icon('library', 15)} Go to Library</button>
      </div>
    </div>`;
  }

  return '';
}

function renderDownloadModal() {
  const modal = document.getElementById('dl-modal');
  const body = document.getElementById('dlm-body');
  if (!modal || !body) return;
  if (dlModalId === null && !modal.classList.contains('show')) return;

  const sig = dlModalSig();
  if (body.dataset.sig !== sig) {
    body.dataset.sig = sig;
    body.innerHTML = dlModalBody();
    hydrateIcons(body);
  }

  if (dlModalId && DL[dlModalId]) paint(dlModalId);

  const sub = document.getElementById('dlm-sub');
  const ids = Object.keys(DL);
  if (sub) {
    sub.textContent = ids.length
      ? `${ids.length} active \u00b7 ${aggregate(ids).speed.toFixed(0)} MB/s`
      : 'Idle \u00b7 nothing in the queue';
  }
}

function handleDlModalAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'pause') pauseDownload(id);
  else if (act === 'resume') resumeDownload(id);
  else if (act === 'cancel') cancelDownload(id);
  else if (act === 'install') startDownload(id, 'install');
  else if (act === 'play') { closeDownloadModal(); launchGame(id); }
}

// ---------------------------------------------------------------------------
// Drawer controls
// ---------------------------------------------------------------------------
function openDrawer() {
  const d = document.getElementById('drawer');
  if (!d) return;
  drawerSuppressed = false;
  d.classList.remove('hidden', 'collapsed');
  document.body.classList.add('drawer-open');
}
function toggleDrawer() {
  const d = document.getElementById('drawer');
  if (!d) return;
  if (d.classList.contains('hidden')) {
    drawerSuppressed = false;
    d.classList.remove('hidden', 'collapsed');
    document.body.classList.add('drawer-open');
    return;
  }
  const collapsed = d.classList.toggle('collapsed');
  document.body.classList.toggle('drawer-open', !collapsed);
}
function hideDrawer() {
  const d = document.getElementById('drawer');
  if (!d) return;
  drawerSuppressed = true;
  d.classList.add('hidden', 'collapsed');
  document.body.classList.remove('drawer-open');
}

function handleDlAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'pause') pauseDownload(id);
  else if (act === 'resume') resumeDownload(id);
  else if (act === 'cancel') cancelDownload(id);
}

function initDrawer() {
  const head = document.getElementById('drawer-head');
  const list = document.getElementById('drawer-list');
  if (head) head.addEventListener('click', (e) => {
    if (e.target.closest('#drawer-close') || e.target.closest('#drawer-toggle') || e.target.closest('#drawer-manage')) return;
    toggleDrawer();
  });
  const toggle = document.getElementById('drawer-toggle');
  if (toggle) toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
  const close = document.getElementById('drawer-close');
  if (close) close.addEventListener('click', (e) => { e.stopPropagation(); hideDrawer(); });
  const manage = document.getElementById('drawer-manage');
  if (manage) manage.addEventListener('click', (e) => { e.stopPropagation(); openDownloadModal(null); });
  if (list) list.addEventListener('click', (e) => {
    if (e.target.closest('[data-restart-steam]')) { restartSteam(); return; }
    const undo = e.target.closest('[data-undo]');
    if (undo) { undoSeed(HANDOFFS.find((h) => h.id === undo.dataset.undo)); return; }
    const recheck = e.target.closest('[data-recheck]');
    if (recheck) { recheckHandoff(recheck); return; }
    handleDlAction(e);
  });

  // Download Manager modal
  const modal = document.getElementById('dl-modal');
  if (modal) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeDownloadModal(); });
    modal.addEventListener('click', (e) => {
      if (e.target.closest('#dlm-goto-lib')) {
        closeDownloadModal();
        document.querySelector('.tab[data-view="library"]').click();
        return;
      }
      handleDlModalAction(e);
    });
  }
  const dlmClose = document.getElementById('dlm-close');
  if (dlmClose) dlmClose.innerHTML = icon('close', 16);
  if (dlmClose) dlmClose.addEventListener('click', closeDownloadModal);
}

// ---------------------------------------------------------------------------
// Full Downloads page
// ---------------------------------------------------------------------------
/**
 * Keeps a delegated click handler singular across re-renders.
 *
 * A view re-renders by rewriting #content's innerHTML, and the #content element
 * itself survives - so a plain addEventListener here stacked another copy of the
 * same handler on every repaint, and the Downloads page repaints on every
 * download event. One click then ran the handler several times over, and because
 * these handlers read the button's own `data-act` - which an earlier copy had
 * just rewritten - a click on Pause paused the download and a later copy
 * resumed it again. The download could not be paused at all.
 */
function rebindClick(el, handler) {
  if (el.__apexDlClick) el.removeEventListener('click', el.__apexDlClick);
  el.__apexDlClick = handler;
  el.addEventListener('click', handler);
}

function renderDownloads(el) {
  clearInterval(slideTimer);
  const ids = Object.keys(DL);
  const agg = aggregate(ids);

  el.innerHTML = `
    <h1 class="page-title">Downloads</h1>
    <div class="dl-summary panel">
      <div class="dl-summary-stats">
        <div><small>Active</small><strong>${ids.length}</strong></div>
        <div><small>Speed</small><strong>${agg.speed.toFixed(0)} MB/s</strong></div>
        <div><small>Remaining</small><strong>${fmtEta(agg.sec)}</strong></div>
        <div><small>Queued size</small><strong>${fmtSize(agg.total - agg.done)}</strong></div>
      </div>
      <div class="bar big"><div style="width:${agg.pct}%"></div></div>
      ${ids.length ? `<div class="dl-summary-actions">
        ${ids.every((id) => DL[id].paused)
          ? `<button class="btn secondary" data-act="resume-all">${icon('play', 14)} Resume all</button>`
          : `<button class="btn secondary" data-act="pause-all">${icon('pause', 14)} Pause all</button>`}
        <button class="btn danger" data-act="cancel-all">${icon('trash', 15)} Cancel all</button>
      </div>` : ''}
    </div>

    <h2 class="section-title">${icon('download', 20)} Queue</h2>
    <div class="dl-page-list">
      ${ids.length ? ids.map(dlRow).join('') : `<div class="empty show">${icon('checkCircle', 34)}<p>Nothing downloading right now.</p></div>`}
    </div>

    ${HANDOFFS.length ? `
    <h2 class="section-title">${icon('external', 20)} Downloading in your stores</h2>
    <div class="handoff-list">
      ${HANDOFFS.map((h) => {
        const pct = h.progress && h.progress.pct != null ? h.progress.pct : null;
        return `<div class="handoff-row">
        <span class="handoff-ico">${icon('download', 17)}</span>
        <div class="handoff-info">
          <strong>${esc(h.title)}</strong>
          <div class="bar sm${pct == null ? ' indeterminate' : ''}"><div data-hbar="${esc(h.id)}"${pct == null ? '' : ` style="width:${pct.toFixed(1)}%"`}></div></div>
          <small data-hline="${esc(h.id)}">${esc(handoffLine(h))}</small>
          ${h.dir ? `<small class="handoff-dir">${esc(h.dir)}</small>` : ''}
        </div>
        ${h.seedRestart && !h.progress
          ? `<button class="btn primary glow sm" data-restart-steam="1">${icon('power', 14)} Restart Steam</button>`
          : ''}
        ${h.seedFile && !h.progress
          ? `<button class="btn secondary sm" data-undo="${esc(h.id)}">${icon('trash', 14)} Undo</button>`
          : ''}
        <button class="btn secondary sm" data-recheck="${esc(h.id)}">${icon('refresh', 14)} Check now</button>
      </div>`;
      }).join('')}
      <p class="handoff-note">${icon('info', 13)}
        Steam publishes its own byte counters, so those bars are Steam's real progress.
        Steam's Download settings can still suspend a download on its side. Press <b>Check now</b>
        (or just relaunch Apex) once a store finishes and the game moves into your Library by itself.</p>
    </div>` : ''}

    <h2 class="section-title">${icon('clock', 20)} Recent activity</h2>
    <div class="history-list">
      ${HISTORY.length ? HISTORY.map((h) => {
        const g = byId(h.id);
        if (!g) return '';
        return `<div class="hist-row">
          <span class="hist-ico">${icon('checkCircle', 18)}</span>
          <div class="hist-info"><strong>${esc(g.title)}</strong><small>${h.kind === 'update' ? 'Updated' : 'Installed'} \u00b7 ${fmtSize(g.size)}</small></div>
          <span class="pill play">${h.kind === 'update' ? 'Updated' : 'Installed'}</span>
        </div>`;
      }).join('') : `<div class="empty show">${icon('list', 34)}<p>No recent activity yet.</p></div>`}
    </div>`;

  hydrateIcons(el);

  rebindClick(el, (e) => {
    if (e.target.closest('[data-restart-steam]')) { restartSteam(); return; }
    const undo = e.target.closest('[data-undo]');
    if (undo) { undoSeed(HANDOFFS.find((h) => h.id === undo.dataset.undo)); return; }
    const recheck = e.target.closest('[data-recheck]');
    if (recheck) { recheckHandoff(recheck); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act } = btn.dataset;
    if (act === 'pause-all') {
      // Only the ones still moving: pausing a job in extraction would just
      // toast at the user for every row.
      Object.keys(DL).filter((id) => !DL[id].paused && dlPausable(DL[id])).forEach(pauseDownload);
    } else if (act === 'resume-all') { Object.keys(DL).forEach(resumeDownload); }
    else if (act === 'cancel-all') { Object.keys(DL).forEach(cancelDownload); }
    // A row's own pause/resume/cancel is deliberately *not* handled here. The
    // shared delegate in app.js already owns every `data-act` button inside
    // #content, and it fires first; re-handling the same click here made the
    // second pass read the `data-act` the first pass had just rewritten, so
    // pressing Pause paused the download and then resumed it again.
  });
}

// ---------------------------------------------------------------------------
// Engine binding
// ---------------------------------------------------------------------------
// The transfer itself lives in the main process (installs.js -> net/). Every
// byte the UI shows comes from this one event stream, so the drawer, the modal
// and the Downloads page all stay in sync with the real transfer.
(function bindDownloadEngine() {
  if (!window.api || !window.api.onDownloadEvent) return;

  window.api.onDownloadEvent(applyDownloadEvent);

  // Reattach to anything that was already running (renderer reload).
  if (window.api.dlList) {
    window.api.dlList()
      .then((jobs) => { if (Array.isArray(jobs)) jobs.forEach(applyDownloadEvent); })
      .catch(() => { /* engine unavailable in this build */ });
  }
})();
