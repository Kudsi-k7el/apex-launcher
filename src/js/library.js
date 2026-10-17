'use strict';

/**
 * Library view.
 *
 * Shows ONLY the games that are actually installed on this PC: titles matched
 * from Steam/Epic install manifests, executables the user linked manually, and
 * games installed through the store. Everything else lives in the Store tab.
 */

let libFilter = 'all';
let libSort = 'az';
let libSearch = '';
let libView = 'grid';          // 'grid' | 'list'

const SORTS = {
  az: 'Name A\u2013Z',
  za: 'Name Z\u2013A',
  size: 'Largest first',
  rating: 'Highest rated',
  release: 'Newest release',
  played: 'Recently played',
  time: 'Most played'
};

const FILTERS = [
  { k: 'all', label: 'All', ico: 'library' },
  { k: 'favorites', label: 'Favorites', ico: 'heart' },
  { k: 'updates', label: 'Updates', ico: 'refresh' },
  { k: 'custom', label: 'Added by me', ico: 'plus' }
];

const isCustomGame = (g) => !!(g.custom || String(g.id).startsWith('custom:'));

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
// A collection is a named set of library ids the user made themselves, kept in
// `State.collections` as id -> { name, games: [gameId] }. They show up as their
// own filter chips beside the built-in ones, and a title can sit in any number
// of them. Ids are derived from the name so a state file stays readable.

function collections() {
  State.collections = State.collections || {};
  return Object.entries(State.collections)
    .map(([id, c]) => ({ id, name: c.name || id, games: Array.isArray(c.games) ? c.games : [] }));
}

const collectionOf = (id) => (State.collections && State.collections[id]) || null;
const gamesInCollection = (id) => { const c = collectionOf(id); return c ? (Array.isArray(c.games) ? c.games : []) : []; };

/** How many titles the user can actually see in it (stale ids are ignored). */
const collectionCount = (id) => gamesInCollection(id).filter((gid) => isInstalled(gid)).length;

function collectionIdFor(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  let id = `col-${base || 'collection'}`;
  let n = 2;
  while (State.collections && State.collections[id]) id = `col-${base || 'collection'}-${n++}`;
  return id;
}

function createCollection(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  State.collections = State.collections || {};
  const id = collectionIdFor(clean);
  State.collections[id] = { name: clean, games: [] };
  return id;
}

function deleteCollection(id) {
  if (State.collections) delete State.collections[id];
  if (libFilter === `col:${id}`) libFilter = 'all';
}

/** Adds or removes a title; returns true when it ended up added. */
function toggleInCollection(id, gameId) {
  const c = collectionOf(id);
  if (!c) return false;
  c.games = Array.isArray(c.games) ? c.games : [];
  const i = c.games.indexOf(gameId);
  if (i >= 0) c.games.splice(i, 1); else c.games.push(gameId);
  return i < 0;
}

const isInAnyCollection = (gameId) => collections().some((c) => c.games.includes(gameId));

function libraryList() {
  const q = libSearch.trim().toLowerCase();
  let list = installedGames().filter((g) => {
    if (!q) return true;
    return [g.title, g.genre, g.developer, g.release, ...(g.tags || [])].join(' ').toLowerCase().includes(q);
  });

  if (libFilter === 'favorites') list = list.filter((g) => State.favorites[g.id]);
  else if (libFilter === 'updates') list = list.filter((g) => State.updates[g.id]);
  else if (libFilter === 'custom') list = list.filter(isCustomGame);
  else if (libFilter.startsWith('col:')) {
    const ids = new Set(gamesInCollection(libFilter.slice(4)));
    list = list.filter((g) => ids.has(g.id));
  }

  const lastPlayed = (g) => (State.stats.lastPlayed && State.stats.lastPlayed[g.id]) || 0;
  // `playtimeOf` (views.js) counts a running session too, so "Most played" stays
  // right even while a game is still open.
  const playedFor = (g) => (typeof playtimeOf === 'function'
    ? playtimeOf(g.id)
    : (State.stats.playtime && State.stats.playtime[g.id]) || 0);
  const cmp = {
    az: (a, b) => a.title.localeCompare(b.title),
    za: (a, b) => b.title.localeCompare(a.title),
    size: (a, b) => b.size - a.size,
    rating: (a, b) => b.rating - a.rating,
    release: (a, b) => b.release - a.release,
    played: (a, b) => lastPlayed(b) - lastPlayed(a),
    time: (a, b) => playedFor(b) - playedFor(a)
  }[libSort];

  return [...list].sort(cmp);
}

function libCard(g) {
  const fav = State.favorites[g.id];
  const inCol = isInAnyCollection(g.id);
  const src = sourceTag(g.id);
  const played = State.stats.lastPlayed && State.stats.lastPlayed[g.id];
  const mins = Math.round(((State.stats.playtime && State.stats.playtime[g.id]) || 0) / 60000);
  return `<article class="card clickable" data-card="${g.id}" title="Open details">
    <div class="card-art">
      ${art(g, 'cover')}
      <button class="fav ${fav ? 'on' : ''}" data-act="fav" data-id="${g.id}" title="Favorite">${icon('heart', 16)}</button>
      <button class="col-btn${inCol ? ' on' : ''}" data-act="collect" data-id="${g.id}" title="${inCol ? 'In a collection' : 'Add to a collection'}">${icon('bookmark', 16)}</button>
      <span class="release-tag">${icon('calendar', 12)} ${g.release}</span>
      <span class="card-open">${icon('arrowUpRight', 13)} Details</span>
      ${pill(g.id)}
      ${verifyBadge(g.id)}
    </div>
    <div class="card-info">
      <h4 title="${esc(g.title)}">${g.icon ? `<img class="card-ico" src="${g.icon}" alt="" draggable="false">` : ''}${esc(g.title)}</h4>
      <div class="card-dev">${esc(g.developer)}</div>
      <div class="tags">${(g.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      <div class="card-meta">
        ${platformBadge(g)}
        ${g.size ? `<span>${icon('hardDrive', 13)} ${fmtSize(g.size)}</span>` : ''}
        ${g.rating ? `<span>${icon('star', 13)} ${g.rating}</span>` : ''}
        ${mins ? `<span>${icon('clockPlay', 13)} ${mins} min</span>`
          : played ? `<span>${icon('clock', 13)} ${timeAgo(played)}</span>`
          : `<span>${icon('tag', 13)} ${esc(g.genre)}</span>`}
      </div>
      ${consoleBadges(g)}
      ${src ? `<div class="card-source">${src}</div>` : ''}
      <div class="actions" data-actions="${g.id}">${actionHtml(g.id)}</div>
    </div>
  </article>`;
}

/**
 * "3m ago" / "2d ago" / "12 Oct" — accepts a millisecond timestamp or any
 * date string (article dates arrive as ISO).
 */
function timeAgo(when) {
  const ts = typeof when === 'number' ? when : new Date(when || 0).getTime();
  if (!ts || isNaN(ts)) return '';
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Pre-ordered titles live in the Library next to the installed ones, in their
 * own row: nothing is playable yet, but the countdown to release day is right
 * there. Clicking a card opens its details page like any other.
 */
function poSection(list) {
  return `<section class="po-section">
    <div class="section-head">
      <h2 class="section-title">${icon('hourglass', 20)} Pre-ordered &amp; upcoming</h2>
      <span class="section-note">${list.length} title${list.length === 1 ? '' : 's'} \u00b7 countdown to release day</span>
    </div>
    <div class="grid po-grid">${list.map(poCard).join('')}</div>
  </section>`;
}

function poCard(g) {
  const iso = typeof releaseDateOf === 'function' ? releaseDateOf(g.id) : null;
  return `<article class="card clickable po-card" data-card="${g.id}" title="Open details">
    <div class="card-art">
      ${art(g, 'cover')}
      <span class="up-flag on">${icon('check', 12)} Pre-ordered</span>
    </div>
    <div class="card-info">
      <h4 title="${esc(g.title)}">${esc(g.title)}</h4>
      <div class="card-dev">${esc(g.developer)}</div>
      ${iso ? `<div class="cd-row">${countdownHtml(iso, { big: true })}</div>` : ''}
      <div class="card-meta">
        ${platformBadge(g)}
        <span>${icon('calendar', 13)} ${esc(g.releaseLabel || g.release || 'TBA')}</span>
        <span>${icon('tag', 13)} ${esc(g.price || 'TBA')}</span>
      </div>
      ${consoleBadges(g)}
      <div class="actions" data-actions="${g.id}">${actionHtml(g.id)}</div>
    </div>
  </article>`;
}

function renderLibrary(el) {
  clearInterval(slideTimer);

  const installed = installedGames();
  // Pre-ordered titles belong here too: they cannot be played yet, but they
  // are the user's, and their release countdown is tracked from this page.
  const pre = (typeof preorderedGames === 'function' ? preorderedGames() : [])
    .filter((g) => !isInstalled(g.id));

  // Nothing installed and nothing pre-ordered -> onboarding state.
  if (!installed.length && !pre.length) {
    el.innerHTML = `
      <h1 class="page-title">Library</h1>
      <div class="page-intro">
        <p>Games you own on this PC. Nothing is installed yet \u2014 scan for the
        games in your Steam, Epic, GOG, Ubisoft, EA and Xbox libraries, or add
        one from the Store.</p>
      </div>
      <div class="empty show big">
        ${icon('library', 40)}
        <h3>No installed games yet</h3>
        <p>Scan this PC for games in your store libraries, point Apex at a folder
        full of games, link an executable yourself, or grab something from the
        Store.</p>
        <div class="empty-actions">
          <button class="btn primary glow" data-act="scan-all">${icon('search', 15)} Scan for installed games</button>
          <button class="btn secondary" data-act="import-folder">${icon('folder', 15)} Import a folder</button>
          <button class="btn secondary" data-act="goto-store">${icon('store', 15)} Browse the Store</button>
          <button class="btn secondary" data-act="add-custom">${icon('plus', 15)} Add a game manually</button>
        </div>
      </div>`;
    return;
  }

  const chip = (f) => `<button class="chip ${libFilter === f.k ? 'active' : ''}" data-filter="${f.k}">${icon(f.ico, 14)} ${f.label}</button>`;
  const cols = collections();
  const colChip = (c) => `<button class="chip ${libFilter === `col:${c.id}` ? 'active' : ''}" data-filter="col:${c.id}"
    title="${esc(c.name)} \u00b7 ${collectionCount(c.id)} game${collectionCount(c.id) === 1 ? '' : 's'}">${icon('bookmark', 14)} ${esc(c.name)}</button>`;
  const intro = installed.length
    ? `${installed.length} installed game${installed.length === 1 ? '' : 's'} detected on this PC.`
    : 'Nothing is installed on this PC yet.';
  const preNote = pre.length
    ? ` ${pre.length} pre-ordered title${pre.length === 1 ? '' : 's'} waiting for release.`
    : '';

  el.innerHTML = `
    <h1 class="page-title">Library</h1>
    <div class="page-intro"><p>${intro}${preNote}</p></div>
    ${favDock()}
    <div class="toolbar">
      ${installed.length ? FILTERS.map(chip).join('') : ''}
      <div class="toolbar-right">
        <button class="btn secondary" data-act="scan-all">${icon('search', 15)} ${installed.length ? 'Rescan' : 'Scan for installed games'}</button>
        <button class="btn secondary" data-act="import-folder">${icon('folder', 15)} Import a folder</button>
        <button class="btn secondary" data-act="add-custom">${icon('plus', 15)} Add game</button>
        ${installed.length ? `<div class="view-toggle" role="group" aria-label="Layout">
          <button class="${libView === 'grid' ? 'on' : ''}" data-view-mode="grid" title="Grid view">${icon('grid', 15)}</button>
          <button class="${libView === 'list' ? 'on' : ''}" data-view-mode="list" title="List view">${icon('list', 15)}</button>
        </div>
        <div class="search-box">${icon('search', 16)}<input id="search" placeholder="Search your library\u2026" value="${esc(libSearch)}" spellcheck="false"></div>
        <div class="dropdown">
          <button class="btn secondary" data-act="menu">${icon('filter', 15)} Sort: ${SORTS[libSort]} ${icon('chevron', 14)}</button>
          <div class="menu">${Object.entries(SORTS).map(([k, v]) => `<a data-sort="${k}" class="${libSort === k ? 'sel' : ''}">${icon('check', 14)} ${v}</a>`).join('')}</div>
        </div>` : ''}
      </div>
    </div>
    ${installed.length ? `<div class="col-bar">
      <span class="col-label">${icon('layers', 14)} Collections</span>
      ${cols.map(colChip).join('')}
      <button class="chip ghost" data-act="new-collection">${icon('plus', 14)} New collection</button>
    </div>` : ''}
    ${pre.length ? poSection(pre) : ''}
    ${installed.length ? `<div class="count" id="count"></div>
    <div class="grid${libView === 'list' ? ' list' : ''}" id="lib-grid">${installed.map(libCard).join('')}</div>
    <div class="empty" id="empty">${icon('search', 36)}<p>No installed games match your filters.</p>
      <button class="btn secondary" id="clear-filters">${icon('refresh', 15)} Clear filters</button></div>` : ''}`;

  el.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    libFilter = b.dataset.filter;
    el.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    applyLibraryFilter();
  }));

  el.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    libSort = b.dataset.sort;
    closeMenus();
    renderLibrary(el);
  }));

  // Layout toggle. Purely a class on the grid, so nothing is rebuilt and the
  // artwork stays decoded.
  el.querySelectorAll('[data-view-mode]').forEach((b) => b.addEventListener('click', () => {
    libView = b.dataset.viewMode;
    el.querySelectorAll('[data-view-mode]').forEach((x) => x.classList.toggle('on', x === b));
    const grid = el.querySelector('#lib-grid');
    if (grid) grid.classList.toggle('list', libView === 'list');
  }));

  const search = el.querySelector('#search');
  if (search) search.addEventListener('input', (e) => { libSearch = e.target.value; applyLibraryFilter(); });

  const clear = el.querySelector('#clear-filters');
  if (clear) clear.addEventListener('click', () => {
    libFilter = 'all';
    libSearch = '';
    el.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x.dataset.filter === 'all'));
    if (search) search.value = '';
    applyLibraryFilter();
  });

  applyLibraryFilter();
}

// Show/hide + reorder existing cards so images and progress bars stay intact.
function applyLibraryFilter() {
  const grid = document.getElementById('lib-grid');
  if (!grid) return;
  const list = libraryList();
  const ids = new Set(list.map((g) => g.id));

  list.forEach((g, i) => {
    const c = grid.querySelector(`[data-card="${g.id}"]`);
    if (c) c.style.order = i;
  });
  grid.querySelectorAll('[data-card]').forEach((c) => {
    c.style.display = ids.has(c.dataset.card) ? '' : 'none';
  });

  const empty = document.getElementById('empty');
  if (empty) empty.classList.toggle('show', list.length === 0);

  const count = document.getElementById('count');
  if (count) count.textContent = `${list.length} of ${installedGames().length} installed`;
}

// ---------------------------------------------------------------------------
// Collection dialogs
// ---------------------------------------------------------------------------
// Both are plain `openModal` dialogs (see modal.js). Creating one from the
// toolbar and filing a title from a card meet in the same picker, so there is
// only one place that knows how a collection is edited.

function openNewCollectionModal(onDone) {
  openModal({
    title: 'New collection',
    ico: 'layers',
    body: `<div class="form-grid">
        <label class="field wide"><span>Name</span>
          <input id="col-name" type="text" placeholder="Backlog" autocomplete="off" spellcheck="false" maxlength="40"></label>
      </div>
      <p class="modal-note">${icon('info', 14)} Collections are yours alone \u2014 they stay on this PC and are never uploaded anywhere.</p>`,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>
      <button class="btn primary glow" id="col-create">${icon('plus', 15)} Create</button>`,
    onMount(el) {
      const input = el.querySelector('#col-name');
      const go = () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        createCollection(name);
        persist();
        closeModal();
        toast(`Collection "${name}" created`, 'check');
        if (onDone) onDone();
      };
      el.querySelector('#col-create').addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      input.focus();
    }
  });
}

/** File one title into any number of collections. */
function openCollectModal(gameId, onDone) {
  const g = byId(gameId) || { title: gameId };
  const rows = () => collections().map((c) => `
    <button class="col-row${c.games.includes(gameId) ? ' on' : ''}" data-toggle-col="${esc(c.id)}">
      <span class="col-tick">${icon('check', 14)}</span>
      <span class="col-row-name">${esc(c.name)}</span>
      <span class="col-row-count">${collectionCount(c.id)}</span>
    </button>`).join('');

  openModal({
    title: `Collections \u00b7 ${g.title}`,
    ico: 'bookmark',
    body: `<div class="col-list" id="col-list">
        ${collections().length ? rows() : `<p class="modal-note">${icon('info', 14)} No collections yet \u2014 make one below.</p>`}
      </div>
      <div class="field-row col-new-row">
        <input id="col-quick" type="text" placeholder="New collection\u2026" autocomplete="off" spellcheck="false" maxlength="40">
        <button class="btn secondary" id="col-quick-add">${icon('plus', 15)} Add</button>
      </div>`,
    footer: `<button class="btn primary glow" data-modal-close>${icon('check', 15)} Done</button>`,
    onMount(el) {
      const list = el.querySelector('#col-list');
      const repaint = () => {
        list.innerHTML = collections().length
          ? rows()
          : `<p class="modal-note">${icon('info', 14)} No collections yet \u2014 make one below.</p>`;
        if (onDone) onDone();
      };

      // Rows are rebuilt on every toggle, so delegate instead of re-binding.
      list.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('[data-toggle-col]');
        if (!b) return;
        const id = b.dataset.toggleCol;
        const added = toggleInCollection(id, gameId);
        const c = collectionOf(id);
        toast(added ? `Added to "${c.name}"` : `Removed from "${c.name}"`, added ? 'check' : 'info');
        persist();
        repaint();
      });

      const quick = el.querySelector('#col-quick');
      const quickAdd = () => {
        const name = quick.value.trim();
        if (!name) { quick.focus(); return; }
        const id = createCollection(name);
        toggleInCollection(id, gameId);
        quick.value = '';
        persist();
        toast(`Added to "${name}"`, 'check');
        repaint();
      };
      el.querySelector('#col-quick-add').addEventListener('click', quickAdd);
      quick.addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(); });
    }
  });
}
