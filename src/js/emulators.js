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
  systems: null,      // the static console table from the main process
  emulators: null,    // what is actually installed
  map: null,          // system -> { emulator, name, exe }
  scan: null,         // the last ROM scan
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
  emu.loaded = true;
}

function emuSaveState() {
  State.emulators = { folders: emu.folders.slice(), exes: { ...emu.exes } };
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

/** What the page shows when no folder has been added yet. */
function emuEmpty() {
  return `<div class="empty show big">
    ${icon('gamepad', 40)}
    <h3>Point Apex at your ROM folders</h3>
    <p>Add the folders your games already live in. Apex reads them, works out which
    console each file belongs to, and lists them on a shelf &mdash; nothing is moved,
    renamed or uploaded.</p>
    <div class="empty-actions">
      <button class="btn primary glow" data-act="emu-add">${icon('folder', 15)} Add a ROM folder</button>
      <button class="btn secondary" data-act="emu-detect">${icon('search', 15)} Look for emulators</button>
    </div>
  </div>`;
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
    const [sysList, scan, found] = await Promise.all(jobs);
    if (token !== emu.token) return;                 // the user moved on

    emu.systems = Array.isArray(sysList) ? sysList : (sysList && sysList.systems) || emu.systems;
    emu.scan = scan || emu.scan;
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
      ? emuEmpty()
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
        <div class="search-box">${icon('search', 16)}<input id="emu-search" placeholder="Search your ROMs\u2026" value="${esc(emu.query)}" spellcheck="false"></div>
      </div>
    </div>

    ${emu.error ? `<p class="emu-warn">${icon('warning', 15)} ${esc(emu.error)}</p>` : ''}
    ${scan && scan.capped ? `<p class="emu-warn">${icon('info', 15)} Stopped after ${total} files. Point Apex at a narrower folder for the full list.</p>` : ''}

    ${emu.emulators && emu.emulators.length ? `<div class="echips">
      <span class="echips-label">${icon('cpu', 14)} Emulators found</span>
      ${emu.emulators.map(emuEmulatorChip).join('')}
    </div>` : `<div class="echips none">
      <span class="echips-label">${icon('warning', 14)} No emulator found</span>
      <span class="echips-note">Install RetroArch, Dolphin or PCSX2 and press rescan, or point Apex at the
      emulator you already have.</span>
      <button class="btn secondary" data-act="emu-detect">${icon('search', 15)} Look again</button>
    </div>`}

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

  host.querySelectorAll('[data-egroup]').forEach((b) => b.addEventListener('click', () => {
    emu.group = b.dataset.egroup;
    emuPaintAll(el);
  }));

  const search = host.querySelector('#emu-search');
  if (search) search.addEventListener('input', (e) => { emu.query = e.target.value; emuPaintShelves(); });

  host.querySelectorAll('[data-act="emu-add"]').forEach((b) => b.addEventListener('click', () => emuAddFolder(el)));
  host.querySelectorAll('[data-act="emu-rescan"]').forEach((b) => b.addEventListener('click', () => emuRefresh(el, { detect: false })));
  host.querySelectorAll('[data-act="emu-detect"]').forEach((b) => b.addEventListener('click', () => emuRefresh(el, { detect: true })));
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
  emu.query = '';

  el.innerHTML = `
    <h1 class="page-title">Emulators</h1>
    <div class="page-intro">
      <p>Retro and console games, on the emulator you already have. Apex reads the
      folders you choose, names the console each file belongs to, and opens it in the
      right emulator &mdash; it never downloads or distributes a game.</p>
    </div>
    <div id="emu-grid-host">
      <div class="emu-loading">${icon('hourglass', 22)} <span>Reading your folders\u2026</span></div>
    </div>`;

  emuRefresh(el, { detect: true });
}
