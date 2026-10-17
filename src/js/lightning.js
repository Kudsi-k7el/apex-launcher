'use strict';

/**
 * Nexus view.
 *
 * The catalogue half of Project Lightning's multi-provider surface. A title is
 * not tied to one host: it carries links on several providers (GoFile,
 * Buzzheavier, MegaDB, Rootz, or a WebTorrent magnet) and Apex resolves one of
 * them and downloads it straight through the built-in engine instead of handing
 * the link to a browser.
 *
 * Searching and reading details is metadata-only, so it needs no account.
 * Nothing is ever fetched until the title is handed to the download engine,
 * which re-checks the host policy on its own (see net/sources.js).
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ltItems = [];        // cards currently on screen
let ltQuery = '';        // live text in the search box
let ltBusy = false;
let ltLoaded = false;    // the initial browse has run
let ltLastQuery = '';
let ltOpenItem = null;   // the card whose dialog is open
let ltOpenDetail = null; // its resolved details, once fetched

const LT_ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
/** Presents a Lightning item to the shared artwork/banner code as a game. */
function ltAsGame(it) {
  return {
    id: it.id,
    title: it.title,
    developer: it.developer || 'Nexus',
    genre: 'PC',
    colors: null,
    cover: it.cover || null,
    logo: it.logo || null,
    steamAppId: it.steamAppId || null,
    platform: 'lightning'
  };
}

const ltSizeGb = (it) => (Number(it.sizeBytes) || 0) / 1073741824;

function ltProviders(it) {
  const names = new Set();
  const push = (u) => {
    const s = String(u || '').toLowerCase();
    if (/^magnet:/.test(s)) names.add('WebTorrent');
    else if (s.includes('gofile')) names.add('GoFile');
    else if (s.includes('buzzheavier') || s.includes('bzzhr')) names.add('Buzzheavier');
    else if (s.includes('megadb')) names.add('MegaDB');
    else if (s.includes('rootz')) names.add('Rootz');
    else if (/^https?:/.test(s)) names.add('Direct');
  };
  // Only real mirrors count - `it.url` is the catalogue page, not a mirror.
  (it.mirrors || []).forEach(push);
  return [...names];
}

function ltSetStatus(kind, text) {
  const el = document.getElementById('lt-status');
  if (!el) return;
  if (!text) { el.className = 'lt-status'; el.innerHTML = ''; return; }
  el.className = `lt-status ${kind}`;
  el.innerHTML = `${icon(kind === 'loading' ? 'refresh' : kind === 'error' ? 'warning' : 'info', 15)}<span>${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function ltCard(it) {
  const size = it.size || (ltSizeGb(it) >= 0.01 ? fmtSize(Math.round(ltSizeGb(it) * 10) / 10) : null);
  const provs = ltProviders(it);
  return `<article class="card clickable lt-card" data-lt-open="${esc(it.id)}" title="Open ${esc(it.title)}">
    <div class="card-art">
      ${art(ltAsGame(it), 'cover')}
      <span class="plat plat-lightning lt-origin">${icon('zap', 12)}Nexus</span>
    </div>
    <div class="card-info">
      <h4 title="${esc(it.title)}">${esc(it.title)}</h4>
      <div class="card-dev">${esc(it.developer || 'Nexus')}</div>
      ${provs.length ? `<div class="tags">${provs.slice(0, 3).map((p) => `<span>${esc(p)}</span>`).join('')}</div>` : ''}
      <div class="card-meta">
        ${size ? `<span>${icon('hardDrive', 13)} ${esc(size)}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn primary sm" data-lt-open="${esc(it.id)}">${icon('download', 14)} Get</button>
      </div>
    </div>
  </article>`;
}

function paintLtGrid() {
  const grid = document.getElementById('lt-grid');
  if (!grid) return;
  grid.innerHTML = ltItems.map(ltCard).join('');
}

/**
 * Replaces one card in place, so a late detail fill does not rebuild the whole
 * grid (which would restart every cover image).
 */
function ltPatchCard(it) {
  const grid = document.getElementById('lt-grid');
  if (!grid || !it || !it.id) return;
  const node = grid.querySelector(`.lt-card[data-lt-open="${it.id}"]`);
  if (node) node.outerHTML = ltCard(it);
}

/**
 * Fills in the fields the listing page does not carry (size, Steam app id,
 * provider tags) *after* the grid is already on screen.
 *
 * SteamRip sits behind Cloudflare, so the fetches stay gentle: two workers, a
 * short pause between requests, and only the cards on the first page.
 */
let ltEnrichToken = 0;

async function ltEnrichCards() {
  const token = ++ltEnrichToken;
  if (!window.api || typeof window.api.lightningDetails !== 'function') return;
  const queue = ltItems
    .filter((it) => it && it.url && !it.steamAppId && !(Number(it.sizeBytes) > 0))
    .slice(0, 12);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const it = queue[next++];
      if (!it || token !== ltEnrichToken) return;
      try {
        const det = await window.api.lightningDetails(it.url);
        if (token !== ltEnrichToken) return;
        if (det && det.ok !== false) {
          it.size = det.size || it.size;
          it.sizeBytes = det.sizeBytes || it.sizeBytes;
          it.steamAppId = det.steamAppId || it.steamAppId;
          it.cover = det.cover || it.cover;
          it.logo = det.logo || it.logo;
          it.mirrors = det.mirrors || it.mirrors;
          ltPatchCard(it);
        }
      } catch { /* a card without details is still usable */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  await Promise.all([worker(), worker()]);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function ltLoad(query) {
  if (ltBusy) return;
  ltQuery = String(query == null ? ltQuery : query);
  ltLastQuery = ltQuery;
  ltBusy = true;

  ltSetStatus('loading', ltQuery ? `Searching Nexus for “${ltQuery}”…` : 'Loading the Nexus catalogue…');

  let items = [];
  let error = null;
  try {
    const res = await window.api.lightningSearch(ltQuery);
    if (!res || res.ok === false) throw new Error((res && res.error) || 'Nexus could not be reached.');
    items = Array.isArray(res.items) ? res.items : [];
  } catch (err) {
    error = (err && err.message) ? err.message : String(err);
  }

  ltBusy = false;
  ltLoaded = true;

  if (error) { ltSetStatus('error', `Nexus could not be reached: ${error}`); return; }

  ltItems = items;
  paintLtGrid();
  ltSetStatus(items.length ? '' : 'empty',
    items.length ? '' : (ltQuery
      ? `Nothing on Nexus matched “${ltQuery}”.`
      : 'The catalogue came back empty. Try a search, or check your connection.'));

  // Sizes and provider tags arrive from the per-title pages; fill them in
  // without making the user wait for the grid to appear.
  if (items.length) ltEnrichCards();
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
function renderLightning(el) {
  // The store's hero carousel shares this timer; leaving it running would tick
  // against a view that no longer has a hero.
  clearInterval(slideTimer);

  el.innerHTML = `
    <h1 class="page-title">${icon('zap', 24)} Nexus</h1>
    <div class="page-intro">
      <p>A multi-provider catalogue, ported from Project Lightning. A title can be hosted on several mirrors
      at once &mdash; Apex resolves one and downloads it straight through the built-in engine,
      so a Cloudflare block on a mirror never stops the install. Installs land in your Library
      exactly like any other title.</p>
    </div>

    <div class="toolbar lt-toolbar">
      <div class="search-box">
        ${icon('search', 16)}
        <input id="lt-search" type="search" placeholder="Search Nexus…" value="${esc(ltQuery)}" spellcheck="false" autocomplete="off">
      </div>
      <div class="toolbar-right">
        <button class="btn secondary sm" id="lt-refresh">${icon('refresh', 15)} Refresh</button>
      </div>
    </div>

    <div class="lt-status" id="lt-status"></div>
    <div class="grid lt-grid" id="lt-grid"></div>`;

  const input = el.querySelector('#lt-search');
  if (input) {
    let timer = null;
    input.addEventListener('input', () => {
      ltQuery = input.value;
      clearTimeout(timer);
      timer = setTimeout(() => ltLoad(input.value.trim()), 500);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); ltLoad(input.value.trim()); }
    });
  }
  const refresh = el.querySelector('#lt-refresh');
  if (refresh) refresh.addEventListener('click', () => ltLoad(ltLastQuery));

  if (!ltLoaded || ltLastQuery) ltLoad(ltLastQuery);
  else { paintLtGrid(); ltSetStatus(''); }
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------
function ltOpenDialog(it) {
  ltOpenItem = it;
  ltOpenDetail = null;

  const size = it.size || (ltSizeGb(it) >= 0.01 ? fmtSize(Math.round(ltSizeGb(it) * 10) / 10) : 'Unknown size');
  const provs = ltProviders(it);

  const body = `
    <div class="lt-det">
      <div class="lt-det-hero">
        ${art(ltAsGame(it), 'wide')}
        <div class="lt-det-shade"></div>
        <span class="plat plat-lightning lt-det-origin">${icon('zap', 12)}Nexus</span>
      </div>
      <div class="lt-det-head">
        <h2>${esc(it.title)}</h2>
        <div class="lt-det-sub">
          <span>${esc(it.developer || 'Nexus')}</span>
          <span class="lt-det-size">${icon('hardDrive', 13)} ${esc(size)}</span>
        </div>
      </div>
      ${it.steamAppId ? `<div class="lt-det-row">${icon('gamepad', 14)} Steam App ${esc(it.steamAppId)}</div>` : ''}
      ${provs.length ? `<div class="lt-det-row">${icon('layers', 14)} Mirrors: ${esc(provs.join(' · '))}</div>` : ''}
      <div class="lt-install" id="lt-det-install">
        <div class="lt-note">${icon('refresh', 15)}<span>Checking what this title offers…</span></div>
      </div>
    </div>`;

  openModal({
    title: `${it.title} · Nexus`,
    ico: 'zap',
    body,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Close</button>`,
    onMount: () => { ltFillDetail(it); }
  });
}

async function ltFillDetail(it) {
  const box = document.getElementById('lt-det-install');
  if (!box) return;

  let det = null;
  try { det = await window.api.lightningDetails(it.url || it.id); } catch { det = null; }
  if (det && det.ok === false) det = null;
  if (det) ltOpenDetail = det;
  if (!box.isConnected) return;

  const mirrors = (det && Array.isArray(det.mirrors) && det.mirrors.length)
    ? det.mirrors
    : (Array.isArray(it.mirrors) ? it.mirrors : []);
  const mirrorList = (det && Array.isArray(det.mirrorList) && det.mirrorList.length)
    ? det.mirrorList
    : null;
  const hostNames = [...new Set((mirrorList || []).map((m) => m && m.label).filter(Boolean))]
    .map((label) => esc(String(label).replace(/\s*download here\s*/i, '').trim()))
    .filter(Boolean);

  box.innerHTML = `
    <div class="lt-note ok">${icon('checkCircle', 15)}<span>
      ${mirrors.length
        ? `${mirrors.length} download mirror${mirrors.length === 1 ? '' : 's'} available${hostNames.length ? ` (${hostNames.join(', ')})` : ''}. Apex resolves a direct file per provider and falls over to the next mirror if one is blocked.`
        : 'Apex will resolve a download mirror for this title when you install.'}
    </span></div>
    <button class="btn primary glow" data-lt-install="${esc(it.id)}">${icon('download', 15)} Install</button>`;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------
/**
 * Makes sure the title exists as a game record before the download starts.
 * `applyDownloadEvent` drops events for ids it cannot resolve, so this has to
 * happen before the transfer is handed to the engine.
 */
function registerLightningGame(it) {
  State.custom = Array.isArray(State.custom) ? State.custom : [];
  let g = State.custom.find((x) => x.id === it.id);

  if (!g) {
    g = makeCustomGame({
      title: it.title,
      developer: it.developer || 'Nexus',
      genre: 'PC',
      exe: null,
      imageUrl: it.cover || null,
      colors: null
    });
    g.id = it.id;                 // stable across re-installs
    State.custom.push(g);
  }

  g.title = it.title;
  g.developer = it.developer || g.developer || 'Nexus';
  g.genre = g.genre || 'PC';
  g.tags = ['Nexus'].concat((g.tags || []).filter((t) => !/^nexus$/i.test(t))).slice(0, 5);
  g.cover = it.cover || g.cover || null;
  g.logo = it.logo || g.logo || null;
  if (it.steamAppId) g.steamAppId = String(it.steamAppId);
  g.custom = true;
  return g;
}

async function ltInstall(id) {
  const it = ltItems.find((x) => x.id === id) || ltOpenDetail || ltOpenItem;
  if (!it) return;

  const g = registerLightningGame(it);
  const sizeGb = Math.max(0, Math.round(ltSizeGb(it) * 10) / 10);
  if (sizeGb) g.size = sizeGb;

  // Ownership is implied by choosing to install here; the engine still checks
  // the host policy and resolves the real mirror before a byte moves.
  State.owned[g.id] = true;
  State.installed = State.installed || {};
  await persist();

  closeModal();
  await startDownload(g.id, 'install', {
    provider: 'lightning',
    url: it.url || null,
    dest: it.title,
    cover: it.cover || null,
    logo: it.logo || null,
    steamAppId: it.steamAppId || null,
    size: Number(it.sizeBytes) || 0,
    extract: true
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;

  const install = t.closest('[data-lt-install]');
  if (install) { ltInstall(install.dataset.ltInstall); return; }

  const open = t.closest('[data-lt-open]');
  if (open) {
    const item = ltItems.find((x) => x.id === open.dataset.ltOpen);
    if (item) ltOpenDialog(item);
    return;
  }
});

// The engine's terminal event can point at the folder it extracted into; keep
// the Lightning record's install path so "open folder" works afterwards.
if (window.api && window.api.onDownloadEvent) {
  window.api.onDownloadEvent((evt) => {
    if (evt && evt.state === 'done' && evt.dest) {
      const g = (typeof byId === 'function') ? byId(evt.id) : null;
      if (g && (g.tags || []).includes('Nexus')) {
        State.installDirs = State.installDirs || {};
        State.installDirs[evt.id] = evt.dest;
        persist();
      }
    }
  });
}
