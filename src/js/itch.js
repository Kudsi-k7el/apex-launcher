'use strict';

/**
 * itch.io view.
 *
 * The public half of itch.io — browsing and searching — needs no account at
 * all: Apex reads the same RSS feeds and `data.json` documents the site serves
 * to any visitor. Downloading a build is the part that needs an identity, so
 * the install buttons ask for the user's own API key (Settings › itch.io) and
 * then hand the transfer to the same download engine every other install uses.
 *
 * Nothing here invents a link. A build is only offered once itch.io itself has
 * answered with a URL for the account on this machine, so a paid title is never
 * downloaded without being owned.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let itchFeed = 'free';        // active browse feed id
let itchPage = 1;             // page within that feed
let itchFeedList = null;      // [{ id, label, ico }] from the main process
let itchItems = [];           // cards currently on screen
let itchBusy = false;
let itchQuery = '';           // live text in the search box
let itchSearching = false;    // the grid shows search results, not a feed
let itchLastQuery = '';
let itchOpenItem = null;      // the card whose dialog is open
let itchOpenDetail = null;    // its `data.json` payload, once fetched
let itchOpenUploads = [];     // its build list, once fetched

/** itch.io ships archives in a handful of shapes; anything else is left alone. */
const ITCH_ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
/** Presents a browse result to the shared artwork/banner code as a game. */
function itchAsGame(it) {
  return {
    id: it.id,
    title: it.title,
    developer: it.author,
    genre: (it.tags && it.tags[0]) || 'Indie',
    tags: it.tags || [],
    colors: null,
    cover: it.cover || null,
    platform: 'itch',
    itch: { url: it.url }
  };
}

const ITCH_PLAT_LABEL = { windows: 'Windows', osx: 'macOS', linux: 'Linux', android: 'Android' };
function itchPlatLabel(p) { return ITCH_PLAT_LABEL[p] || 'Download'; }

/** "Windows · macOS" style line for the little platform icons on a card. */
function itchPlatforms(it) {
  const p = it.platforms || {};
  return ['windows', 'osx', 'linux', 'android'].filter((k) => p[k]).map(itchPlatLabel);
}

function itchFeedLabel(id) {
  const f = (itchFeedList || []).find((x) => x.id === id);
  return f ? f.label : 'games';
}

function setItchStatus(kind, text) {
  const el = document.getElementById('itch-status');
  if (!el) return;
  if (!text) { el.className = 'itch-status'; el.innerHTML = ''; return; }
  el.className = `itch-status ${kind}`;
  el.innerHTML = `${icon(kind === 'loading' ? 'refresh' : kind === 'error' ? 'warning' : 'info', 15)}<span>${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function itchCard(it) {
  const plats = itchPlatforms(it);
  const free = !it.price || it.price === 'Free';
  const priceLabel = free ? 'Free' : it.price;
  return `<article class="card clickable itch-card" data-itch-open="${esc(it.id)}" title="Open ${esc(it.title)}">
    <div class="card-art">
      ${art(itchAsGame(it), 'cover')}
      <span class="plat plat-itch itch-origin">${icon('flame', 12)}itch.io</span>
      <span class="itch-price ${free ? 'free' : ''}">${esc(priceLabel)}</span>
      ${it.demo ? `<span class="itch-demo">${icon('download', 11)} Demo</span>` : ''}
    </div>
    <div class="card-info">
      <h4 title="${esc(it.title)}">${esc(it.title)}</h4>
      <div class="card-dev">${esc(it.author)}</div>
      ${(it.tags || []).length ? `<div class="tags">${it.tags.slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="card-meta">
        ${plats.length ? `<span>${icon('hardDrive', 13)} ${esc(plats.join(' · '))}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn primary sm" data-itch-open="${esc(it.id)}">${icon('download', 14)} Get</button>
      </div>
    </div>
  </article>`;
}

function paintItchGrid(append) {
  const grid = document.getElementById('itch-grid');
  if (!grid) return;
  if (!append) grid.innerHTML = itchItems.map(itchCard).join('');
  else grid.insertAdjacentHTML('beforeend', itchItems.slice(grid.children.length).map(itchCard).join(''));
}

function paintItchPager() {
  const box = document.getElementById('itch-pager');
  if (!box) return;
  if (itchSearching) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <button class="btn secondary sm" data-itch-page="${Math.max(1, itchPage - 1)}" ${itchPage <= 1 || itchBusy ? 'disabled' : ''}>
      ${icon('left', 14)} Previous
    </button>
    <span class="itch-page-n">Page ${itchPage}</span>
    <button class="btn secondary sm" data-itch-page="${itchPage + 1}" ${itchBusy ? 'disabled' : ''}>
      Next ${icon('right', 14)}
    </button>`;
}

function paintItchFeedBar() {
  const box = document.getElementById('itch-feeds');
  if (!box) return;
  const list = itchFeedList || [];
  box.innerHTML = `
    <div class="itch-feedbar">
      ${list.map((f) => `<button class="itch-chip ${(!itchSearching && itchFeed === f.id) ? 'active' : ''}" data-itch-feed="${esc(f.id)}">
        ${icon(f.ico, 14)}<span>${esc(f.label)}</span></button>`).join('')}
    </div>
    <div class="toolbar-right">
      <div class="search-box">
        ${icon('search', 16)}
        <input id="itch-search" type="search" placeholder="Search itch.io…" value="${esc(itchQuery)}" spellcheck="false" autocomplete="off">
      </div>
    </div>`;

  const input = box.querySelector('#itch-search');
  if (!input) return;
  input.addEventListener('input', () => { itchQuery = input.value; });
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (input.value.trim()) itchSearch(input.value.trim()); }, 450);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); itchSearch(input.value.trim()); }
  });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function itchLoadFeeds() {
  if (itchFeedList && itchFeedList.length) return itchFeedList;
  let res = null;
  try { res = await window.api.itchFeeds(); } catch { res = null; }
  itchFeedList = Array.isArray(res) && res.length ? res : [
    { id: 'free', label: 'Free games', ico: 'gift' },
    { id: 'popular', label: 'New & popular', ico: 'sparkles' },
    { id: 'rated', label: 'Top rated', ico: 'trophy' },
    { id: 'newest', label: 'Just released', ico: 'rocket' }
  ];
  return itchFeedList;
}

async function itchLoad(opts = {}) {
  if (itchBusy) return;
  const { feed, page, reset } = opts;

  if (typeof feed === 'string') { itchFeed = feed; itchSearching = false; itchPage = 1; }
  if (typeof page === 'number') { itchPage = Math.max(1, page); itchSearching = false; }
  if (reset) { itchItems = []; }

  itchBusy = true;
  setItchStatus('loading', `Loading ${itchFeedLabel(itchFeed)}…`);
  paintItchFeedBar();
  paintItchPager();

  let items = [];
  let error = null;
  try {
    const res = await window.api.itchBrowse(itchFeed, itchPage);
    if (!res || res.ok === false) throw new Error((res && res.error) || 'itch.io could not be reached.');
    items = Array.isArray(res.items) ? res.items : [];
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }

  itchBusy = false;
  if (error) {
    setItchStatus('error', `itch.io could not be reached: ${error}`);
    paintItchPager();
    return;
  }

  itchItems = reset ? items : itchItems.filter((x) => !items.some((y) => y.id === x.id)).concat(items);
  paintItchGrid(!reset);
  paintItchPager();
  setItchStatus(items.length ? '' : 'empty', items.length ? '' : 'Nothing came back from itch.io for this feed.');
}

async function itchSearch(query) {
  const q = String(query || '').trim();
  itchQuery = q;
  itchLastQuery = q;
  itchSearching = true;
  itchPage = 1;

  paintItchFeedBar();
  paintItchPager();

  if (!q) { itchSearching = false; itchLoad({ reset: true }); return; }

  itchBusy = true;
  setItchStatus('loading', `Searching itch.io for “${q}”…`);

  let items = [];
  let error = null;
  try {
    const res = await window.api.itchSearch(q);
    if (!res || res.ok === false) throw new Error((res && res.error) || 'itch.io search failed.');
    items = Array.isArray(res.items) ? res.items : [];
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }

  itchBusy = false;
  if (error) { setItchStatus('error', `Search failed: ${error}`); return; }

  itchItems = items;
  paintItchGrid(false);
  setItchStatus(items.length ? '' : 'empty',
    items.length ? '' : `Nothing on itch.io matched “${q}”.`);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
function renderItch(el) {
  // The store's hero carousel shares this timer; leaving it running would tick
  // against a view that no longer has a hero.
  clearInterval(slideTimer);

  el.innerHTML = `
    <h1 class="page-title">${icon('flame', 24)} itch.io</h1>
    <div class="page-intro">
      <p>The independent side of PC gaming: hand-picked indie releases, game jams and demos,
      browsed straight from itch.io's own public feeds. Installs land in your Library exactly
      like any other title.</p>
    </div>

    <div class="toolbar itch-toolbar" id="itch-feeds"></div>
    <div class="itch-status" id="itch-status"></div>
    <div class="grid itch-grid" id="itch-grid"></div>
    <div class="itch-pager" id="itch-pager"></div>`;

  setItchStatus('loading', 'Connecting to itch.io…');

  (async () => {
    await itchLoadFeeds();
    paintItchFeedBar();
    await itchLoad({ reset: true });
  })();
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------
function itchOpenDialog(it) {
  itchOpenItem = it;
  itchOpenDetail = null;
  itchOpenUploads = [];

  const free = !it.price || it.price === 'Free';
  const body = `
    <div class="itch-det">
      <div class="itch-det-hero">
        ${art(itchAsGame(it), 'wide')}
        <div class="itch-det-shade"></div>
        <span class="plat plat-itch itch-det-origin">${icon('flame', 12)}itch.io</span>
      </div>
      <div class="itch-det-head">
        <h2>${esc(it.title)}</h2>
        <div class="itch-det-sub">
          <span>by ${esc(it.author)}</span>
          <span class="itch-det-price ${free ? 'free' : ''}">${esc(free ? 'Free' : it.price)}</span>
        </div>
        ${it.blurb ? `<p class="itch-det-blurb">${esc(it.blurb)}</p>` : ''}
        ${(it.tags || []).length ? `<div class="tags">${it.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="itch-shots" id="itch-det-shots"></div>
      <div class="itch-install" id="itch-det-install">
        <div class="itch-note">${icon('refresh', 15)}<span>Checking what this title offers…</span></div>
      </div>
    </div>`;

  openModal({
    title: `${it.title} · itch.io`,
    ico: 'flame',
    body,
    footer: `<button class="btn secondary" data-itch-web="${esc(it.url)}">${icon('external', 15)} Open on itch.io</button>
      <button class="btn" data-modal-close>Close</button>`,
    onMount: () => { itchFillDetail(it); }
  });
}

async function itchFillDetail(it) {
  const shots = document.getElementById('itch-det-shots');
  const install = document.getElementById('itch-det-install');
  if (!install) return; // the dialog was closed before this resolved

  let det = null;
  try { det = await window.api.itchDetail(it.url); } catch { det = null; }
  if (det && det.ok === false) det = null;
  if (det) itchOpenDetail = det;
  if (!document.body.contains(install)) return;

  if (shots && det) {
    const list = Array.isArray(det.screenshots) ? det.screenshots : [];
    shots.innerHTML = list.length
      ? list.slice(0, 6).map((s) => `<img src="${esc(s)}" alt="" loading="lazy" draggable="false">`).join('')
      : '';
  }

  await itchFillInstalls(it, det);
}

async function itchFillInstalls(it, det) {
  const box = document.getElementById('itch-det-install');
  if (!box) return;

  const key = String((State.settings.itch && State.settings.itch.apiKey) || '').trim();
  if (!key) {
    box.innerHTML = `
      <div class="itch-need">
        <span class="itch-need-ico">${icon('flame', 22)}</span>
        <div class="itch-need-text">
          <h4>Connect itch.io to install</h4>
          <p>Browsing itch.io needs no account. To download a build, Apex asks itch.io
          for a link using your own API key — it is stored on this PC only, and only ever
          sent to itch.io.</p>
        </div>
        <button class="btn primary" data-itch-settings>${icon('settings', 15)} Open Settings</button>
      </div>`;
    return;
  }

  const gameId = (det && det.gameId) || null;
  if (!gameId) {
    box.innerHTML = `<div class="itch-note warn">${icon('warning', 15)}<span>itch.io did not return an id for this title, so its builds cannot be listed.</span></div>`;
    return;
  }

  let res = null;
  try { res = await window.api.itchUploads(gameId); } catch { res = null; }
  if (!box.isConnected) return;

  const uploads = (res && Array.isArray(res.uploads)) ? res.uploads : [];
  if (!res || res.ok === false || (!uploads.length && res.error)) {
    const msg = (res && res.error) === 'no-key'
      ? 'Connect itch.io in Settings first.'
      : (res && res.error) || 'itch.io did not answer.';
    box.innerHTML = `<div class="itch-note warn">${icon('warning', 15)}<span>${esc(msg)}</span></div>`;
    return;
  }
  if (!uploads.length) {
    box.innerHTML = `<div class="itch-note warn">${icon('warning', 15)}<span>This account has no downloadable build for this title.</span></div>`;
    return;
  }

  itchOpenUploads = uploads;
  const mac = navigator.platform && /mac/i.test(navigator.platform);
  const sorted = uploads.slice().sort((a, b) => {
    const score = (u) => (u.platform === 'windows' ? 0 : (!mac && !u.platform ? 1 : (u.platform === 'osx' ? 2 : 3)));
    return score(a) - score(b) || (b.size || 0) - (a.size || 0);
  });

  box.innerHTML = `
    <h4 class="itch-builds-title">${icon('download', 15)} Available builds</h4>
    <div class="itch-builds">
      ${sorted.map((u) => `<div class="itch-build">
        <span class="itch-build-plat">${esc(itchPlatLabel(u.platform))}</span>
        <div class="itch-build-text">
          <b>${esc(u.filename)}</b>
          <small>${fmtSize((u.size || 0) / 1073741824)}${u.demo ? ' · demo' : ''}${u.preorder ? ' · pre-order' : ''}</small>
        </div>
        <button class="btn primary sm" data-itch-install="${esc(u.id)}" data-itch-upload="${esc(u.id)}">
          ${icon('download', 13)} Install
        </button>
      </div>`).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * Makes sure the title exists as a game record before a download starts, and
 * stamps it with where it came from.
 *
 * `applyDownloadEvent` drops events for ids it cannot resolve, so this has to
 * happen *before* the transfer is handed to the engine.
 */
function registerItchGame(it, det) {
  State.custom = Array.isArray(State.custom) ? State.custom : [];
  let g = State.custom.find((x) => x.id === it.id);

  if (!g) {
    g = makeCustomGame({
      title: it.title,
      developer: it.author,
      genre: (it.tags && it.tags[0]) || 'Indie',
      exe: null,
      imageUrl: it.cover || null,
      colors: null
    });
    g.id = it.id;                 // stable: `itch:<author>/<slug>`
    State.custom.push(g);
  }

  g.title = it.title;
  g.developer = it.author;
  g.release = g.release || new Date().getFullYear();
  g.genre = (it.tags && it.tags[0]) || g.genre || 'Indie';
  g.tags = ['itch.io'].concat((it.tags || []).filter((t) => !/^itch\.io$/i.test(t))).slice(0, 5);
  g.cover = it.cover || g.cover || null;
  g.price = it.price || 'Free';
  g.platform = 'itch';
  g.custom = true;
  g.itch = {
    url: it.url,
    gameId: (det && det.gameId) || (g.itch && g.itch.gameId) || null,
    author: it.author,
    cover: it.cover || null
  };
  if (it.blurb) g.blurb = it.blurb;
  return g;
}

async function itchInstall(uploadId) {
  const it = itchOpenItem;
  if (!it || !uploadId) return;

  // Make sure we have the numeric game id: it comes from data.json, and the
  // dialog may have been opened before that fetch finished.
  if (!itchOpenDetail || !itchOpenDetail.gameId) {
    try { itchOpenDetail = await window.api.itchDetail(it.url); } catch { itchOpenDetail = null; }
    if (itchOpenDetail && itchOpenDetail.ok === false) itchOpenDetail = null;
  }

  const up = itchOpenUploads.find((u) => String(u.id) === String(uploadId)) || null;
  const g = registerItchGame(it, itchOpenDetail);
  if (up && up.size) g.size = up.size / 1073741824;

  // Ownership is implied by the itch.io account the key belongs to; the engine
  // still re-checks it against the real build before a byte moves.
  State.owned[g.id] = true;
  State.installed = State.installed || {};
  await persist();

  closeModal();
  await startDownload(g.id, 'install', {
    provider: 'itch',
    gameId: g.itch.gameId,
    uploadId,
    filename: up ? up.filename : null,
    size: up ? up.size : 0,
    dest: it.title,
    extract: !!(up && ITCH_ARCHIVE_RE.test(up.filename || ''))
  });
}

/**
 * After the engine places an itch.io install, point the launcher at the game's
 * own executable so "Play" works without the user hunting for it. The biggest
 * executable in the folder is almost always the game; installers, redistribs
 * and crash handlers are already filtered out by `folder:scanGames`.
 */
async function itchLinkExe(id, dest) {
  if (!id || !dest || !/^itch:/.test(id)) return;
  let res = null;
  try { res = await window.api.scanFolder(dest); } catch { return; }
  const list = (res && res.ok && Array.isArray(res.games)) ? res.games : [];
  if (!list.length) return;

  const best = list.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!best || !best.exe) return;

  State.local = State.local || { installs: {}, roots: {}, stores: {} };
  State.local.installs = State.local.installs || {};
  State.local.installs[id] = {
    type: 'exe',
    exe: best.exe,
    path: best.dir || dest,
    name: best.name || null,
    source: 'itch'
  };
  await persist();

  const g = byId(id);
  toast(`${g ? g.title : 'Game'} is ready to play`, 'check');
  if (typeof current !== 'undefined' && (current === 'library' || current === 'detail')) render(false);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;

  const feed = t.closest('[data-itch-feed]');
  if (feed) { itchLoad({ feed: feed.dataset.itchFeed, reset: true }); return; }

  const page = t.closest('[data-itch-page]');
  if (page) { itchLoad({ page: Number(page.dataset.itchPage), reset: true }); return; }

  const open = t.closest('[data-itch-open]');
  if (open) {
    const item = itchItems.find((x) => x.id === open.dataset.itchOpen)
      // Cards painted by the unified search live outside `itchItems`.
      || (typeof uniItchFind === 'function' ? uniItchFind(open.dataset.itchOpen) : null);
    if (item) itchOpenDialog(item);
    return;
  }

  const install = t.closest('[data-itch-install]');
  if (install) { itchInstall(install.dataset.itchInstall); return; }

  const settings = t.closest('[data-itch-settings]');
  if (settings) { closeModal(); switchView('settings'); return; }

  const web = t.closest('[data-itch-web]');
  if (web) {
    if (window.api && window.api.openExternal) window.api.openExternal(web.dataset.itchWeb).catch(() => {});
  }
});

// The engine's terminal event for an itch install points at the real folder.
if (window.api && window.api.onDownloadEvent) {
  window.api.onDownloadEvent((evt) => {
    if (evt && evt.state === 'done' && evt.dest && /^itch:/.test(evt.id || '')) {
      itchLinkExe(evt.id, evt.dest);
    }
  });
}
