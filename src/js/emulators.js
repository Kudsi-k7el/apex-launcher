'use strict';

/**
 * Emulators.
 * -------------------------------------------------------------------------
 * One shelf per console, built from the ROMs already sitting in the folders the
 * user points Apex at, and a play button that hands the right file to the right
 * emulator.
 *
 * Apex does not download, host or provide games, and this page does not pretend
 * otherwise. What it can do is find what is already on the disk, say which
 * console each file belongs to, and open it - plus point at the places that
 * genuinely give games away, which is what the panel at the bottom is for.
 */

const EMU_GROUPS = ['Nintendo', 'Sony', 'Sega', 'Handheld', 'Atari', 'Arcade', 'Other'];

/**
 * How long an answer from the release pages is trusted at start-up.
 *
 * A check costs one request per installed emulator, and a project like KytyPS5
 * publishes several builds a day - so a couple of checks a day is what keeps
 * "you have an update" prompt without spending a user's GitHub budget on it (the
 * unauthenticated limit is per hour, and a launcher gets restarted far more often
 * than that). Opening the Emulators shelf always asks; this only gates the
 * start-up check, and the offer itself is remembered on disk, so a build found
 * once keeps being offered until the user answers it.
 */
const EMU_UPDATE_INTERVAL = 3 * 60 * 60 * 1000;

/**
 * Where games can legitimately be had for free. Everything here is public
 * domain, homebrew, freeware, or an open-source engine that runs data the user
 * already owns - never a link to a commercial ROM or ISO, which is the line
 * this whole feature has to stay on the right side of.
 */
const FREE_SOURCES = [
  {
    name: 'Internet Archive',
    what: 'Public-domain and freeware classics',
    note: 'Thousands of MS-DOS, arcade and early-console titles that are genuinely free to download.',
    url: 'https://archive.org/details/softwarelibrary',
    ico: 'globe'
  },
  {
    name: 'PDRoms',
    what: 'Public-domain ROMs',
    note: 'Homebrew and public-domain ROMs for the older Nintendo and Sega consoles.',
    url: 'https://www.pdroms.de/',
    ico: 'cpu'
  },
  {
    name: 'Homebrew Hub',
    what: 'Game Boy homebrew',
    note: 'A curated library of homebrew Game Boy and Game Boy Color games, all free.',
    url: 'https://hh.gbdev.io/',
    ico: 'gamepad'
  },
  {
    name: 'itch.io',
    what: 'Free indie and retro games',
    note: 'Tens of thousands of free games, including a large retro shelf. Many run in Apex directly.',
    url: 'https://itch.io/games/tag-retro',
    ico: 'flame'
  },
  {
    name: 'ScummVM',
    what: 'Classic adventures you own',
    note: 'Runs the point-and-click classics - provided you have the game data already.',
    url: 'https://www.scummvm.org/',
    ico: 'sparkles'
  },
  {
    name: 'OpenTTD',
    what: 'Open-source Transport Tycoon',
    note: 'A complete, free, open-source remake. Nothing to own first.',
    url: 'https://www.openttd.org/',
    ico: 'rocket'
  }
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const emu = {
  folders: [],
  exes: {},           // emulator id -> binary path, pinned by hand
  // Which installed emulators have a newer build waiting (id -> record), the
  // builds the user has already waved away for now (id -> tag), any error the
  // last check hit, and whether one is in flight. See emuCheckUpdates.
  updates: {},
  updatesBusy: false,
  updatesError: '',
  updatesAt: 0,
  skipped: {},        // id -> tag the user has waved away for now
  asked: {},          // id -> tag already put to the user this session
  promptWait: null,   // timer holding the offer while the gate is up
  systems: null,      // the static console table from the main process
  emulators: null,    // what is actually installed
  map: null,          // system -> { emulator, name, exe }
  scan: null,         // the last ROM scan
  catalog: null,      // the emulators Apex can download for you
  installs: {},       // emulator id -> { phase, pct } while one is downloading
  group: 'all',
  query: '',
  busy: false,
  error: '',
  loaded: false,
  token: 0
};

function emuLoadState() {
  if (emu.loaded) return;
  const saved = (State.emulators && typeof State.emulators === 'object') ? State.emulators : {};
  emu.folders = Array.isArray(saved.folders) ? saved.folders.filter((f) => typeof f === 'string') : [];
  emu.exes = (saved.exes && typeof saved.exes === 'object') ? saved.exes : {};
  // "Later" is remembered per build, so waving one away does not mean hearing
  // about it again on every launch - while the shelf keeps offering it.
  emu.skipped = (saved.updatesSkipped && typeof saved.updatesSkipped === 'object') ? { ...saved.updatesSkipped } : {};
  // The last answer the release pages gave, so the shelf can show a build that
  // is waiting before the first check of the session has run.
  emu.updates = (saved.updates && typeof saved.updates === 'object') ? { ...saved.updates } : {};
  emu.updatesAt = Number(saved.updatesAt) || 0;
  emu.loaded = true;
}

function emuSaveState() {
  State.emulators = {
    folders: emu.folders.slice(),
    exes: { ...emu.exes },
    updatesSkipped: { ...emu.skipped },
    updates: { ...emu.updates },
    updatesAt: emu.updatesAt
  };
  persist();
}

const emuSystem = (key) => ((emu.systems || []).find((s) => s.id === key)) || { id: key, label: key, full: key, group: 'Other' };

/** The emulator that will open a console, or null when nothing can. */
function emuFor(systemId) {
  return (emu.map && emu.map[systemId]) || null;
}

/** ROM sizes arrive in bytes; the rest of Apex counts gigabytes. */
function emuSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function emuRomCard(rom) {
  const target = emuFor(rom.system);
  const can = !!target;
  const ext = (rom.name.match(/\.[^.]+$/) || [''])[0].slice(1).toUpperCase();
  return `<article class="erom${can ? '' : ' nogo'}" data-rom="${esc(rom.path)}">
    <div class="erom-top">
      <span class="erom-ext">${esc(ext || 'ROM')}</span>
      <span class="erom-size">${emuSize(rom.size)}</span>
    </div>
    <h4 title="${esc(rom.name)}">${esc(rom.title)}</h4>
    <p class="erom-dir" title="${esc(rom.dir)}">${esc(rom.dir)}</p>
    <div class="erom-actions">
      <button class="btn primary glow" data-launch="${esc(rom.path)}" data-system="${esc(rom.system)}"
        ${can ? '' : 'disabled'} title="${can ? `Play in ${esc(target.name)}` : 'No emulator installed for this console'}">
        ${icon('play', 15)} ${can ? 'Play' : 'No emulator'}
      </button>
      <button class="btn secondary icon-only" data-reveal="${esc(rom.path)}" title="Show in folder">${icon('folder', 15)}</button>
    </div>
    <span class="erom-engine">${can ? `${icon('cpu', 12)} ${esc(target.name)}` : `${icon('warning', 12)} install an emulator`}</span>
  </article>`;
}

function emuShelf(key, list) {
  const sys = emuSystem(key);
  const target = emuFor(key);
  const engine = target
    ? `<span class="eshelf-engine on">${icon('cpu', 13)} ${esc(target.name)}${target.manual ? ' (manual)' : ''}</span>`
    : `<span class="eshelf-engine off">${icon('warning', 13)} no emulator installed</span>`;
  return `<section class="eshelf" data-shelf="${esc(key)}">
    <div class="eshelf-head">
      <h3>${esc(sys.label)} <small>${esc(sys.full)}</small></h3>
      <span class="eshelf-count">${list.length} game${list.length === 1 ? '' : 's'}</span>
      ${engine}
    </div>
    <div class="erom-grid">${list.map(emuRomCard).join('')}</div>
  </section>`;
}

function emuEmulatorChip(e) {
  return `<div class="echip" title="${esc(e.exe)}">
    <span class="echip-dot"></span>
    <div><strong>${esc(e.name)}</strong><small>${e.systems.length} consoles &middot; ${esc(e.via)}</small></div>
  </div>`;
}

/** The "where to get games" panel. Links out; downloads nothing itself. */
function emuSourcesPanel() {
  return `<section class="esources">
    <div class="section-head">
      <h2 class="section-title">${icon('download', 20)} Where to get games</h2>
      <span class="section-note">free, legal and yours to keep</span>
    </div>
    <p class="esources-lede">Apex does not download or host games, and it will never point at a
    commercial ROM or ISO. Everything below is public domain, homebrew or freeware &mdash;
    or an open-source engine that runs data you already own.</p>
    <div class="esources-grid">
      ${FREE_SOURCES.map((s) => `<a class="esource" href="${esc(s.url)}" data-ext="${esc(s.url)}">
        <span class="esource-ico">${icon(s.ico, 18)}</span>
        <div>
          <strong>${esc(s.name)}</strong>
          <em>${esc(s.what)}</em>
          <p>${esc(s.note)}</p>
        </div>
        <span class="esource-go">${icon('external', 15)}</span>
      </a>`).join('')}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Get emulators
// ---------------------------------------------------------------------------
// Emulators are ordinary programs, and every one below is fetched from the
// project that publishes it. Apex bundles none of them and ships no games.

const EMU_SHELF_GROUPS = ['Nintendo', 'Handheld', 'Sony', 'Sega', 'Atari', 'Other'];

/** A download size, shown only when the project's own release told us one. */
function emuMb(n) {
  const mb = Number(n) || 0;
  return mb ? `~${mb} MB` : '';
}

/**
 * A label built by the shelf, translated if the language engine is there.
 *
 * The engine is loaded before this file, but a bare probe harness may not have
 * it - and a missing translation should degrade to the English, never throw.
 */
function emuStage(text, vars) {
  return (typeof t === 'function') ? t(text, vars) : text;
}

/**
 * The folder an installed emulator lives in. `shell:openPath` opens whatever it
 * is given, so handing it the .exe would launch the emulator — the folder is
 * what makes "Show" mean show.
 */
function emuFolder(exe) {
  return String(exe || '').replace(/[\\/][^\\/]*$/, '');
}

/** The shelf, with the installed half folded in from the detection we already have. */
function emuCatalogView() {
  const owned = new Map((emu.emulators || []).map((x) => [x.id, x]));
  return (emu.catalog || []).map((e) => {
    const hit = owned.get(e.id);
    return { ...e, installed: !!hit, exe: hit ? hit.exe : null, via: hit ? hit.via : null };
  });
}

function emuShelfCard(e) {
  const job = emu.installs[e.id];
  const upd = emu.updates[e.id];
  const shown = e.systems.slice(0, 6).map((k) => `<span class="emuget-sys">${esc(emuSystem(k).label)}</span>`);
  if (e.systems.length > 6) shown.push(`<span class="emuget-sys more">+${e.systems.length - 6}</span>`);

  let action;
  if (job) {
    const pct = Math.max(0, Math.min(100, Math.round(job.pct || 0)));
    // Translated at the source: the card is repainted on every progress tick, so
    // a DOM pass would only paint English back over it a moment later.
    const label = job.phase === 'extract'
      ? emuStage('Unpacking {pct}%', { pct })
      : emuStage('Downloading {pct}%', { pct });
    action = `<div class="emuget-bar"><i style="width:${pct}%"></i></div>
      <span class="emuget-pct">${esc(label)}</span>
      <button class="btn secondary" data-emucancel="${esc(e.id)}">${icon('close', 14)} Cancel</button>`;
  } else if (upd) {
    // An update is the same download as the first install, so it is the same
    // button; the card just says why the shelf is offering it again.
    const size = emuMb(upd.size ? Math.round(upd.size / (1024 * 1024)) : e.mb);
    const waved = emuSkipUpdate(e.id);
    const button = `<button class="btn ${waved ? 'secondary' : 'primary glow'}" data-emuget="${esc(e.id)}">${icon('refresh', 15)} ${waved ? 'Update' : 'Update now'}${size ? ` <em>${esc(size)}</em>` : ''}</button>`;
    // Once "Later" has been answered the shelf stops asking, but it must not
    // take the update away either: Launch and Update sit side by side, so the
    // emulator stays usable right up until the user wants the newer build.
    action = waved
      ? `<button class="btn primary glow" data-emurun="${esc(e.id)}">${icon('play', 15)} Launch</button>${button}`
      : `${button}
      <button class="btn secondary" data-emulater="${esc(e.id)}">${icon('hourglass', 15)} Later</button>`;
  } else if (e.installed) {
    action = `<button class="btn primary glow" data-emurun="${esc(e.id)}">${icon('play', 15)} Launch</button>
      <button class="btn secondary icon-only" data-reveal="${esc(emuFolder(e.exe))}" title="Show the install folder">${icon('folder', 15)}</button>`;
  } else if (!e.auto && e.page) {
    action = `<button class="btn secondary" data-emupage="${esc(e.page)}">${icon('external', 15)} Open download page</button>`;
  } else if (!e.auto) {
    // No build to fetch and nowhere safe to send anyone - Ryujinx is the one in
    // that position. The card still lists it, the note says why, and an install
    // the user already has is caught by the branch above and gets Launch.
    action = '';
  } else {
    const size = emuMb(e.mb);
    action = `<button class="btn primary glow" data-emuget="${esc(e.id)}">${icon('download', 15)} Download${size ? ` <em>${esc(size)}</em>` : ''}</button>`;
  }

  const badge = upd
    ? `<span class="emuget-badge up">${icon('refresh', 11)} update</span>`
    : e.installed ? `<span class="emuget-badge">${icon('check', 11)} ready</span>` : '';

  // A project that publishes a build a day should be able to say which one you
  // have, and the update note is the one place that matters. Both halves are
  // looked up with the tags in placeholders, because a sentence with a version
  // baked into it can never be matched by the DOM pass.
  const build = upd
    ? `<p class="emuget-upd">${icon('zap', 12)} ${esc(upd.version
      ? emuStage('A newer build is out: {tag} \u2014 you have {have}.', { tag: upd.latest, have: upd.version })
      : emuStage('A newer build is out: {tag}.', { tag: upd.latest }))}</p>`
    : (e.installed && e.version ? `<p class="emuget-ver">${esc(emuStage('Build {tag}.', { tag: e.version }))}</p>` : '');

  return `<article class="emuget${e.installed ? ' owned' : ''}${upd ? ' has-update' : ''}" data-emucard="${esc(e.id)}">
    <div class="emuget-head">
      <h4>${esc(e.name)}</h4>
      ${badge}
    </div>
    <p class="emuget-blurb">${esc(e.blurb)}</p>
    <div class="emuget-systems">${shown.join('')}</div>
    ${build}
    ${e.note ? `<p class="emuget-note">${icon('info', 12)} ${esc(e.note)}</p>` : ''}
    <div class="emuget-action">${action}</div>
  </article>`;
}

/** The "download an emulator" shelf, grouped the same way the consoles are. */
function emuShelfPanel() {
  const list = emuCatalogView();
  if (!list.length) return '';
  const groups = EMU_SHELF_GROUPS.filter((g) => list.some((e) => e.group === g));
  const ready = list.filter((e) => e.installed).length;
  // The bar counts every build on offer, including the ones waved off with
  // "Later" - that is what keeps the shelf's own "Review" way back to them.
  // The sidebar badge is the one that only counts the answers still owed.
  const updates = Object.keys(emu.updates || {}).length;

  return `<section class="emuget-shelf">
    <div class="section-head">
      <h2 class="section-title">${icon('download', 20)} Get emulators</h2>
      <span class="section-note">${ready} of ${list.length} installed</span>
    </div>
    ${updates ? `<p class="emu-updbar">${icon('zap', 14)}
      <span>${esc(updates === 1
        ? emuStage('An emulator has a newer build than the one installed.')
        : emuStage('{n} emulators have newer builds than the ones installed.', { n: updates }))}</span>
      <button class="btn secondary" data-act="emu-review">${icon('refresh', 14)} Review</button></p>` : ''}
    <p class="emuget-lede">An emulator is an ordinary program, and these come straight from the people who write
    them &mdash; nothing is bundled with Apex. Download one and Apex installs it, finds it and starts using it
    on the next scan. Games are not included, and never will be.</p>
    ${groups.map((g) => `<div class="emuget-group">
      <h3 class="emuget-group-head">${esc(g)}</h3>
      <div class="emuget-grid">${list.filter((e) => e.group === g).map(emuShelfCard).join('')}</div>
    </div>`).join('')}
  </section>`;
}

/**
 * Redraws a single card. Progress arrives several times a second, and rebuilding
 * the whole page for each tick would throw away the user's scroll position.
 */
function emuPaintCard(id) {
  const host = document.querySelector('#content #emu-grid-host');
  if (!host) return;
  const card = host.querySelector(`.emuget[data-emucard="${CSS.escape(id)}"]`);
  const entry = emuCatalogView().find((e) => e.id === id);
  if (!card || !entry) return;
  card.outerHTML = emuShelfCard(entry);
  const fresh = host.querySelector(`.emuget[data-emucard="${CSS.escape(id)}"]`);
  if (fresh) { emuWireCatalog(fresh); emuWireCards(fresh); }
}

function emuWireCatalog(root) {
  root.querySelectorAll('[data-emuget]').forEach((b) => b.addEventListener('click', () => emuGet(b.dataset.emuget)));
  root.querySelectorAll('[data-emurun]').forEach((b) => b.addEventListener('click', () => emuRunEmulator(b)));
  root.querySelectorAll('[data-emulater]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.emulater;
    const upd = emu.updates[id];
    if (upd) emu.skipped[id] = upd.latest;
    emuSaveState();
    emuPaintNav();
    emuPaintCard(id);
    toast('No rush \u2014 the update waits on the shelf', 'info');
  }));
  root.querySelectorAll('[data-emucancel]').forEach((b) => b.addEventListener('click', () => {
    b.disabled = true;
    try { window.api.emuCancel(b.dataset.emucancel); } catch { /* the event path clears it */ }
  }));
  root.querySelectorAll('[data-emupage]').forEach((b) => b.addEventListener('click', () => {
    try { window.api.openExternal(b.dataset.emupage); } catch { /* nothing to do */ }
  }));
}

/**
 * Starts an installed emulator with no game in it, straight to its own menu.
 *
 * Split from the button so that Big Picture can do the same thing: the launch is
 * one call, and only the dressing belongs to the button that asked for it.
 */
async function emuStart(id) {
  let res = null;
  try { res = await window.api.emuRun(id, emu.exes); }
  catch (err) { toast((err && err.message) || 'The emulator would not start.', 'warn'); return false; }
  if (!res || !res.ok) {
    toast((res && res.error) || 'The emulator would not start.', 'warn');
    return false;
  }
  toast(emuStage('{name} started.', { name: res.emulator }), 'check');
  return true;
}

/** The shelf's own Launch button: the same launch, with the button dressed. */
async function emuRunEmulator(btn) {
  btn.disabled = true;
  const was = btn.innerHTML;
  btn.innerHTML = `${icon('hourglass', 15)} Starting\u2026`;
  const ok = await emuStart(btn.dataset.emurun);
  if (!ok) { btn.disabled = false; btn.innerHTML = was; return; }
  setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = was; } }, 2500);
}

async function emuGet(id) {
  if (emu.installs[id]) return;
  emu.installs[id] = { phase: 'download', pct: 0 };
  emuPaintCard(id);
  try { await window.api.emuInstall(id); } catch { /* reported through emu:event */ }
  // The main process always emits a closing event; this only covers the case
  // where it could not be delivered at all.
  if (emu.installs[id]) { delete emu.installs[id]; emuPaintCard(id); }
}

// ---------------------------------------------------------------------------
// "A newer build is out"
// ---------------------------------------------------------------------------
// Emulators are published far more often than Apex is, and a project like
// KytyPS5 can put out several builds in a day - so a version baked in here would
// be wrong by the weekend. What Apex keeps instead is the release tag each
// download came from, and a check compares that with the newest release.
//
// An update is a download, and downloads in Apex are always the user's call: the
// emulator on disk is never replaced behind their back. What this does is notice
// the newer build, put it on the shelf, and ask.

/** Whether the user has already answered "later" for this exact build. */
function emuSkipUpdate(id) {
  const upd = emu.updates[id];
  return !!(upd && emu.skipped[id] === upd.latest);
}

/** How many emulators have a newer build that the user has not waved away. */
function emuUpdateCount() {
  return Object.keys(emu.updates).filter((id) => !emuSkipUpdate(id)).length;
}

/**
 * The count in the sidebar, so a build waiting for an answer is visible from
 * wherever the user is in the launcher rather than only on the shelf.
 */
function emuPaintNav() {
  const badge = document.getElementById('nav-emu-badge');
  if (!badge) return;
  const n = emuUpdateCount();
  badge.textContent = n;
  badge.style.display = n ? 'inline-flex' : 'none';
}

/** Everything on offer that the user has not already dealt with. */
function emuPendingUpdates(all) {
  return Object.keys(emu.updates)
    .map((id) => emu.updates[id])
    .filter((u) => u && (all || (emu.skipped[u.id] !== u.latest && emu.asked[u.id] !== u.latest)));
}

/**
 * Asks about the newer builds a check turned up.
 *
 * Says which build is installed, which one is on offer, and what updating
 * actually does - a re-download from the project's own release page over the
 * copy in Apex's folder, with the user's games, saves and settings untouched.
 * "Later" is remembered per build, so it is asked once and then left alone,
 * while the shelf keeps its own button for it.
 */
function emuPromptUpdates(opts) {
  const list = emuPendingUpdates(!!(opts && opts.all));
  if (!list.length) return;
  // The sign-in gate owns the window while it is up, and a dialog stacked over
  // it would be unreachable - so the offer waits for the door rather than being
  // dropped.
  if (document.body.classList.contains('auth-locked')) { emuPromptWhenFree(opts); return; }

  list.forEach((u) => { emu.asked[u.id] = u.latest; });

  const many = list.length > 1;
  const rows = list.map((u) => `<li class="emu-upd-row">
      <div class="emu-upd-name">${esc(u.name)}</div>
      <div class="emu-upd-tags">
        <b>${esc(u.latest || 'new build')}</b>
        <small>${esc(u.version
          ? emuStage('you have {tag}', { tag: u.version })
          : emuStage('the copy on disk is a build Apex cannot place'))}</small>
      </div>
    </li>`).join('');

  openModal({
    title: many
      ? emuStage('Emulator updates are ready')
      : emuStage('{name} has a new build', { name: list[0].name }),
    ico: 'refresh',
    body: `<p class="emu-upd-lede">${esc(emuStage('A newer build than the one installed is out. Updating downloads it again from the project\u2019s own release page and replaces the copy in Apex\u2019s emulator folder \u2014 your games, saves and settings are not touched.'))}</p>
      <ul class="emu-upd-list">${rows}</ul>`,
    footer: `<button class="btn secondary" data-emu-later>${icon('hourglass', 15)} Later</button>
      <button class="btn primary glow" data-emu-now>${icon('refresh', 15)} ${many ? 'Update all' : 'Update now'}</button>`,
    onMount(el) {
      el.querySelector('[data-emu-now]').addEventListener('click', () => {
        closeModal();
        // Each install reports into its own card and the shelf redraws itself
        // when they land, so they do not need to be awaited one by one here.
        list.forEach((u) => emuGet(u.id));
        toast(emuStage('Updating {name}', { name: list.map((u) => u.name).join(', ') }), 'info');
      });
      el.querySelector('[data-emu-later]').addEventListener('click', () => {
        list.forEach((u) => { emu.skipped[u.id] = u.latest; });
        emuSaveState();
        emuPaintNav();
        closeModal();
        // The cards now owe the user Launch as well as Update (and no longer
        // offer Later), so the shelf is redrawn straight away rather than
        // waiting for the next visit.
        const host = document.getElementById('content');
        if (host && host.querySelector('#emu-grid-host')) emuPaintAll(host);
        // Big Picture draws the same offer on its own hero and shelf.
        if (typeof BP !== 'undefined' && BP.openFlag) {
          if (typeof bpRenderShelf === 'function') bpRenderShelf();
          if (typeof bpRenderHero === 'function') bpRenderHero();
        }
        toast('No rush \u2014 the update waits on the shelf', 'info');
      });
    }
  });
}

/** The updates on offer, in a form two checks can be compared by. */
function emuUpdateSig() {
  return Object.keys(emu.updates).sort().map((id) => `${id}@${emu.updates[id].latest}`).join('|');
}

/**
 * Waits for the sign-in gate to clear, then shows the offer.
 *
 * The boot check can land while the gate still owns the window. Rather than drop
 * what it found, the offer is held and put again the moment the launcher is the
 * user's - for about ten minutes, after which the shelf's own badge is the way
 * back to it.
 */
function emuPromptWhenFree(opts, tries) {
  if (!document.body.classList.contains('auth-locked')) { emuPromptUpdates(opts); return; }
  if (emu.promptWait) return;
  const step = (n) => {
    if (!document.body.classList.contains('auth-locked')) { emu.promptWait = null; emuPromptUpdates(opts); return; }
    if (n >= 150) { emu.promptWait = null; return; }
    emu.promptWait = setTimeout(() => step(n + 1), 4000);
  };
  emu.promptWait = setTimeout(() => step(tries || 0), 4000);
}

/**
 * Asks the main process which downloaded emulators have a newer build waiting,
 * then puts the answer on the shelf and - unless told not to - asks about it.
 *
 * Safe to call whenever a view opens: the main process holds its own answer for
 * a few minutes and only asks GitHub about emulators Apex actually installed, so
 * a machine with none costs nothing.
 */
async function emuCheckUpdates(force, opts) {
  if (emu.updatesBusy) return emu.updates;
  emu.updatesBusy = true;
  emu.updatesError = '';
  const before = emuUpdateSig();
  try {
    const res = await window.api.emuUpdates(!!force);
    if (res && res.ok) {
      const next = {};
      (res.updates || []).forEach((u) => { if (u && u.id) next[u.id] = u; });
      emu.updates = next;
      emu.updatesError = res.error || '';
      emu.updatesAt = Date.now();
      emuSaveState();
      if (force) emu.asked = {};
    } else {
      emu.updatesError = (res && res.error) || 'Could not reach the release pages.';
    }
  } catch (err) {
    emu.updatesError = (err && err.message) || 'Could not check for emulator updates.';
  }
  emu.updatesBusy = false;

  // The answer goes out to every surface that shows it: the sidebar count, the
  // shelf (if it is open) and, unless told not to, the user.
  emuPaintNav();
  // Only a changed answer is worth a redraw: the toolbar is the element holding
  // whatever the user was typing, and most checks change nothing.
  if (emuUpdateSig() !== before) {
    const el = document.getElementById('content');
    if (el && el.querySelector('#emu-grid-host')) emuPaintAll(el);
  }
  if (!opts || opts.prompt !== false) emuPromptUpdates();
  return emu.updates;
}

/**
 * The check that runs when the launcher opens.
 *
 * Throttled against the last answer rather than run every time, because the
 * question costs a request per installed emulator and the answer rarely changes
 * within a working day. Between checks the shelf still shows the last answer it
 * was given - including offering it again if the gate swallowed the prompt at
 * the previous launch.
 */
function emuBootUpdates() {
  emuLoadState();
  // Whatever was found at a previous launch is shown before anything is asked
  // again: the sidebar count and the offer both come off the saved answer.
  emuPaintNav();
  if (Date.now() - (emu.updatesAt || 0) >= EMU_UPDATE_INTERVAL) {
    emuCheckUpdates(false, { prompt: true });
    return;
  }
  if (emuPendingUpdates(false).length) emuPromptWhenFree();
}

/**
 * Download events come from the main process rather than the awaited call, so a
 * long download keeps reporting even while the card is being redrawn.
 */
function emuOnEvent(evt) {
  if (!evt || !evt.id) return;
  const { id, type } = evt;

  if (type === 'start') {
    emu.installs[id] = { phase: 'download', pct: 0 };
    emuPaintCard(id);
    return;
  }
  if (type === 'progress') {
    const job = emu.installs[id] || (emu.installs[id] = { phase: evt.phase, pct: 0 });
    job.phase = evt.phase;
    job.pct = evt.pct;
    emuPaintCard(id);
    return;
  }
  if (type === 'log') return;

  delete emu.installs[id];
  emuPaintCard(id);

  // The shelf lives in more than one place, and a download finishing changes
  // what both of them show - so Big Picture is told, once, when this ends.
  if (typeof bpEmuChanged === 'function') bpEmuChanged(id);

  if (type === 'done') {
    // Whatever was on offer has just gone in, so the offer is answered and the
    // build on record is the one that landed.
    const upd = emu.updates[id];
    if (upd) { delete emu.updates[id]; delete emu.skipped[id]; delete emu.asked[id]; }
    const entry = (emu.catalog || []).find((e) => e.id === id);
    if (entry && evt.version) entry.version = evt.version;
    emu.updatesAt = Date.now();
    emuSaveState();
    emuPaintNav();
    emuPaintCard(id);
    toast(emuStage(upd ? '{name} is updated.' : '{name} is installed.', { name: evt.name || 'The emulator' }), 'check');
    emuRefresh(document.querySelector('#content'), { detect: true });
  } else if (type === 'manual') {
    // Say why before a browser window appears on top of the launcher, or the page
    // looks like it opened by itself. A page-only entry arrives here as well, so
    // the reason is whatever the main process put in the event.
    if (evt.error || evt.message) toast(evt.error || evt.message, 'warn');
    // Only when there is somewhere to go: an entry with no page still produces
    // this event (to carry the reason above), and openExternal('') rejects with
    // an invalid URL that would surface as an uncaught renderer error.
    if (evt.page) window.api.openExternal(evt.page).catch(() => { /* the toast said why */ });
  } else if (type === 'error') {
    toast(evt.message || 'The download failed.', 'warn');
  }
}

let emuEventsWired = false;
function emuWireEvents() {
  if (emuEventsWired) return;
  emuEventsWired = true;
  try { window.api.onEmuEvent(emuOnEvent); } catch { /* no bridge, no events */ }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function emuShelfData() {
  const scan = emu.scan;
  if (!scan || !scan.bySystem) return [];
  const q = emu.query.trim().toLowerCase();
  return Object.entries(scan.bySystem)
    .map(([key, list]) => {
      const filtered = q ? list.filter((r) => r.title.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : list;
      return { key, list: filtered };
    })
    .filter(({ key, list }) => list.length && (emu.group === 'all' || emuSystem(key).group === emu.group))
    .sort((a, b) => b.list.length - a.list.length);
}

/** Repaints only the shelves, so the toolbar and scroll position survive. */
function emuPaintShelves() {
  const host = document.getElementById('emu-shelves');
  if (!host) return;
  const shelves = emuShelfData();
  host.innerHTML = shelves.length
    ? shelves.map(({ key, list }) => emuShelf(key, list)).join('')
    : `<div class="empty show">${icon('search', 32)}<p>No games match that.</p></div>`;
  emuWireCards(host);
}

function emuWireCards(root) {
  root.querySelectorAll('[data-launch]').forEach((b) => b.addEventListener('click', () => emuPlay(b)));
  root.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
    try { window.api.openPath(b.dataset.reveal); } catch { /* nothing to do */ }
  }));
}

async function emuPlay(btn) {
  const path = btn.dataset.launch;
  const system = btn.dataset.system;
  btn.disabled = true;
  const was = btn.innerHTML;
  btn.innerHTML = `${icon('hourglass', 15)} Starting\u2026`;
  const res = await window.api.emuLaunch(system, path, { overrides: emu.exes });
  if (!res || !res.ok) {
    btn.disabled = false;
    btn.innerHTML = was;
    // "No emulator is installed" is not a dead end: the shelf that fixes it is
    // further down this same page, so the message names the card to press.
    if (res && res.needsEmulator) {
      const want = (emu.catalog || []).find((e) => e.auto && (e.systems || []).includes(system));
      const card = want ? document.querySelector(`.emuget[data-emucard="${want.id}"]`) : null;
      const into = card || document.querySelector('.emuget-shelf');
      if (into) into.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(want ? `${res.error} Download ${want.name} from the shelf below.` : res.error, 'warn');
      return;
    }
    toast((res && res.error) || 'The emulator would not start.', 'warn');
    return;
  }
  toast(`${res.title} \u2192 ${res.emulator}`, 'check');
  // A launch can outlive the page; the button comes back on its own.
  setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = was; } }, 2500);
}

async function emuRefresh(el, opts) {
  const token = ++emu.token;
  const detect = !opts || opts.detect !== false;
  emu.busy = true;
  try {
    const jobs = [
      emu.systems ? Promise.resolve({ ok: true, systems: emu.systems }) : window.api.emuSystems(),
      emu.folders.length ? window.api.emuScan(emu.folders, {}) : Promise.resolve({ ok: true, roms: [], bySystem: {}, count: 0 })
    ];
    if (detect) jobs.push(window.api.emuDetect(emu.exes));
    // The shelf never changes shape, so it is fetched once per session.
    if (!emu.catalog) jobs.push(window.api.emuCatalog());
    const [sysList, scan, found, shelf] = await Promise.all(jobs);
    if (token !== emu.token) return;                 // the user moved on

    emu.systems = Array.isArray(sysList) ? sysList : (sysList && sysList.systems) || emu.systems;
    emu.scan = scan || emu.scan;
    if (shelf) emu.catalog = Array.isArray(shelf) ? shelf : (shelf.emulators || emu.catalog);
    if (found) {
      // The main process has already worked out both halves: what is installed
      // (`emulators`, each carrying the consoles it can run) and which one wins
      // each console (`systems`). Nothing is re-derived here.
      emu.emulators = found.emulators || [];
      emu.map = found.systems || {};
    }
    emu.error = (scan && scan.error) || (found && found.error) || '';
  } catch (err) {
    emu.error = (err && err.message) || 'Something went wrong reading those folders.';
  } finally {
    emu.busy = false;
  }
  if (token !== emu.token) return;
  if (document.querySelector('#content #emu-grid-host')) emuPaintAll(el);
  // Opening the shelf is the moment the user is looking at the emulators, so it
  // is the moment worth asking. The main process caches its answer, and the
  // prompt itself is asked once per build.
  emuCheckUpdates(false, { prompt: true });
}

/** Rebuilds everything except the scanner's own progress line. */
function emuPaintAll(el) {
  const host = el.querySelector('#emu-grid-host');
  if (!host) return;
  const scan = emu.scan;
  const total = (scan && scan.count) || 0;
  const bySystem = (scan && scan.bySystem) || {};
  const shelves = emuShelfData();

  const groups = EMU_GROUPS.filter((g) => Object.keys(bySystem).some((k) => emuSystem(k).group === g));
  const chip = (key, label, count) => `<button class="chip ${emu.group === key ? 'active' : ''}" data-egroup="${esc(key)}">${esc(label)}${count != null ? ` <em>${count}</em>` : ''}</button>`;

  const shelvesHtml = shelves.length
    ? shelves.map(({ key, list }) => emuShelf(key, list)).join('')
    : !emu.folders.length
      ? ''
      : total
        ? `<div class="empty show">${icon('search', 32)}<p>No games match that.</p></div>`
        : `<div class="empty show big">
            ${icon('folder', 36)}
            <h3>Nothing found in ${emu.folders.length === 1 ? 'that folder' : 'those folders'}</h3>
            <p>Apex could not identify a single game in there. Check that it holds ROM files
            rather than archives, or point it at another folder.</p>
            <div class="empty-actions">
              <button class="btn primary glow" data-act="emu-add">${icon('plus', 15)} Add another folder</button>
              <button class="btn secondary" data-act="emu-rescan">${icon('refresh', 15)} Rescan</button>
            </div>
          </div>`;

  host.innerHTML = `
    <div class="toolbar emu-toolbar">
      <div class="emu-folders">
        <span class="emu-folders-label">${icon('folder', 14)} ${emu.folders.length} folder${emu.folders.length === 1 ? '' : 's'}</span>
        <button class="btn secondary" data-act="emu-add">${icon('plus', 15)} Add folder</button>
        <button class="btn secondary" data-act="emu-rescan">${icon('refresh', 15)} Rescan</button>
      </div>
      <div class="toolbar-right">
        ${emuCatalogView().length ? `<button class="btn secondary" data-act="emu-updates" title="Ask each project's release page for a newer build">${icon('refresh', 15)} Check for updates</button>` : ''}
        <div class="search-box">${icon('search', 16)}<input id="emu-search" placeholder="Search your ROMs\u2026" value="${esc(emu.query)}" spellcheck="false"></div>
      </div>
    </div>

    ${emu.error ? `<p class="emu-warn">${icon('warning', 15)} ${esc(emu.error)}</p>` : ''}
    ${emu.updatesError ? `<p class="emu-warn">${icon('warning', 15)} ${esc(emu.updatesError)}</p>` : ''}
    ${scan && scan.capped ? `<p class="emu-warn">${icon('info', 15)} Stopped after ${total} files. Point Apex at a narrower folder for the full list.</p>` : ''}

    ${emu.emulators && emu.emulators.length ? `<div class="echips">
      <span class="echips-label">${icon('cpu', 14)} Emulators found</span>
      ${emu.emulators.map(emuEmulatorChip).join('')}
    </div>` : `<div class="echips none">
      <span class="echips-label">${icon('warning', 14)} No emulator found</span>
      <span class="echips-note">Download one from the shelf below, or point Apex at an emulator you
      already have.</span>
      <button class="btn secondary" data-act="emu-detect">${icon('search', 15)} Look again</button>
    </div>`}

    ${emuShelfPanel()}

    ${emu.folders.length ? `<div class="emu-fold-list">
      ${emu.folders.map((f) => `<span class="efolder" title="${esc(f)}">${icon('folder', 13)} <b>${esc(f.split(/[\\\\/]/).filter(Boolean).pop() || f)}</b>
        <button data-act="emu-rm" data-dir="${esc(f)}" title="Stop scanning this folder">${icon('close', 12)}</button></span>`).join('')}
    </div>` : ''}

    ${total ? `<div class="emu-groups">
      ${chip('all', 'All consoles', total)}
      ${groups.map((g) => chip(g, g, Object.entries(bySystem).filter(([k]) => emuSystem(k).group === g).reduce((n, [, l]) => n + l.length, 0))).join('')}
    </div>
    <div class="emu-count">${shelves.length} console${shelves.length === 1 ? '' : 's'} &middot; ${shelves.reduce((n, s) => n + s.list.length, 0)} shown</div>` : ''}

    <div id="emu-shelves">${shelvesHtml}</div>

    ${emuSourcesPanel()}`;

  emuWireCards(host);
  emuWireCatalog(host);

  host.querySelectorAll('[data-egroup]').forEach((b) => b.addEventListener('click', () => {
    emu.group = b.dataset.egroup;
    emuPaintAll(el);
  }));

  const search = host.querySelector('#emu-search');
  if (search) search.addEventListener('input', (e) => { emu.query = e.target.value; emuPaintShelves(); });

  host.querySelectorAll('[data-act="emu-add"]').forEach((b) => b.addEventListener('click', () => emuAddFolder(el)));
  host.querySelectorAll('[data-act="emu-rescan"]').forEach((b) => b.addEventListener('click', () => emuRefresh(el, { detect: false })));
  host.querySelectorAll('[data-act="emu-detect"]').forEach((b) => b.addEventListener('click', () => emuRefresh(el, { detect: true })));
  host.querySelectorAll('[data-act="emu-review"]').forEach((b) => b.addEventListener('click', () => emuPromptUpdates({ all: true })));
  host.querySelectorAll('[data-act="emu-updates"]').forEach((b) => b.addEventListener('click', async () => {
    // The button says what it is doing while the release pages are read; the
    // check itself repaints the shelf if the answer turned out different.
    const was = b.innerHTML;
    b.disabled = true;
    b.innerHTML = `${icon('hourglass', 15)} Checking\u2026`;
    await emuCheckUpdates(true, { prompt: true });
    if (b.isConnected) { b.disabled = false; b.innerHTML = was; }
  }));
  host.querySelectorAll('[data-act="emu-rm"]').forEach((b) => b.addEventListener('click', () => {
    emu.folders = emu.folders.filter((f) => f !== b.dataset.dir);
    emuSaveState();
    emuRefresh(el, { detect: false });
  }));
  host.querySelectorAll('[data-ext]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    try { window.api.openExternal(a.dataset.ext); } catch { /* nothing to do */ }
  }));
}

async function emuAddFolder(el) {
  let dir = null;
  try { dir = await window.api.pickFolder(''); } catch { dir = null; }
  if (!dir) return;
  if (!emu.folders.includes(dir)) emu.folders.push(dir);
  emuSaveState();
  emuRefresh(el, { detect: false });
}

function renderEmulators(el) {
  clearInterval(slideTimer);
  emuLoadState();
  emuWireEvents();
  emu.query = '';

  el.innerHTML = `
    <h1 class="page-title">Emulators</h1>
    <div class="page-intro">
      <p>Retro and console games, on the emulator you already have &mdash; or on one you download
      below. Apex reads the folders you choose, names the console each file belongs to, and opens
      it in the right emulator. It never downloads or distributes a game.</p>
    </div>
    <div id="emu-grid-host">
      <div class="emu-loading">${icon('hourglass', 22)} <span>Reading your folders\u2026</span></div>
    </div>`;

  emuRefresh(el, { detect: true });
}
