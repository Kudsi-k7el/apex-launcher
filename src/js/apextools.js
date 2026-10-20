'use strict';

/**
 * Apex Tools: the dashboard that opens the Tools view.
 *
 * The clock, the App-ID lookup, the Steam helpers and a paged grid of the
 * titles Apex already knows about. Everything here talks to channels that
 * existed before this page - it adds convenience, not capability.
 *   - Add a Steam library folder  -> drives.addSteamLibrary (existing)
 *   - Restart Steam               -> steam:restart (kill + steam://open/main)
 *   - Steam / SteamDB             -> the app id you type, opened in the browser
 *   - Drop a folder               -> scanFolder + importGameEntry (existing)
 */

const AP = { page: 1, sort: 'recent', query: '' };
let apClock = null;

/** Tracks played or owned, newest play first (or A-Z). */
function apGames() {
  const lastPlayed = (State.stats && State.stats.lastPlayed) || {};
  let list = (typeof allGames === 'function' ? allGames() : [])
    .filter((g) => g && g.id && (State.installed[g.id] || State.owned[g.id] || State.custom.includes(g)))
    .filter((g) => {
      const q = AP.query.trim().toLowerCase();
      if (!q) return true;
      return `${g.title} ${g.developer || ''}`.toLowerCase().includes(q);
    });

  if (AP.sort === 'az') {
    list = list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
  } else {
    list = list.sort((a, b) => (lastPlayed[b.id] || 0) - (lastPlayed[a.id] || 0));
  }
  return list;
}

function apClockText() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return { time: `${hh}:${mm}`, date };
}

function apTickClock() {
  const slot = document.getElementById('ap-clock-time');
  if (!slot) { clearInterval(apClock); apClock = null; return; }
  const t = apClockText();
  slot.textContent = t.time;
  const d = document.getElementById('ap-clock-date');
  if (d) d.textContent = t.date;
}

function apCard(g) {
  const played = State.stats && State.stats.lastPlayed && State.stats.lastPlayed[g.id];
  return `<button class="ap-tile" data-act="open" data-id="${esc(g.id)}" title="${esc(g.title)}">
    <span class="ap-tile-art">${art(g, 'cover')}</span>
    <span class="ap-tile-name">${esc(g.title)}</span>
    <span class="ap-tile-meta">${played
      ? `${icon('clock', 11)} ${esc(timeAgo(new Date(played).toISOString()))}`
      : `${icon('hardDrive', 11)} Installed`}</span>
  </button>`;
}

function apPaintGrid() {
  const grid = document.getElementById('ap-grid');
  const pager = document.getElementById('ap-pager');
  if (!grid) return;

  const all = apGames();
  const per = 12;
  const pages = Math.max(1, Math.ceil(all.length / per));
  AP.page = Math.min(Math.max(1, AP.page), pages);
  const slice = all.slice((AP.page - 1) * per, AP.page * per);

  const count = document.getElementById('ap-count');
  if (count) count.textContent = `${all.length} game${all.length === 1 ? '' : 's'}`;

  grid.innerHTML = slice.length
    ? slice.map(apCard).join('')
    : `<div class="empty show">${icon('search', 30)}<p>${all.length ? 'Nothing matches that search.' : 'No games yet - import a folder or install something.'}</p></div>`;

  if (pager) {
    pager.innerHTML = pages > 1 ? `
      <button class="ap-page" data-ap-page="${AP.page - 1}" ${AP.page === 1 ? 'disabled' : ''}>${icon('left', 15)}</button>
      <span>${AP.page} / ${pages}</span>
      <button class="ap-page" data-ap-page="${AP.page + 1}" ${AP.page === pages ? 'disabled' : ''}>${icon('right', 15)}</button>` : '';
  }
}

/** Steam library folders, when the main process can read them. */
async function apPaintLibraries() {
  const box = document.getElementById('ap-libs');
  if (!box) return;
  if (!window.api.steamLibraries) { box.innerHTML = ''; return; }
  let res = null;
  try { res = await window.api.steamLibraries(); } catch { res = null; }
  const libs = (res && res.libraries) || [];
  box.innerHTML = libs.length
    ? `<div class="ap-lib-head">${icon('hardDrive', 14)} Steam libraries</div>
       <div class="ap-lib-row">${libs.map((l) => `<span class="ap-lib" title="${esc(l)}">${esc(l)}</span>`).join('')}</div>`
    : '';
}

function apPaint(host) {
  apClockText();
  host.innerHTML = `
    <div class="ap">
      <div class="ap-top">
        <div class="ap-card ap-clock-card">
          <span class="ap-clock-time" id="ap-clock-time"></span>
          <span class="ap-clock-date" id="ap-clock-date"></span>
        </div>

        <div class="ap-card">
          <span class="ap-label">Steam app id</span>
          <div class="ap-appid-row">
            <input id="ap-appid" type="text" inputmode="numeric" placeholder="e.g. 1245620" spellcheck="false" autocomplete="off">
            <button class="ap-go" data-ap="lookup">${icon('search', 15)} Find</button>
          </div>
          <p class="ap-hint">Opens the store page for that id. No account, no library changes.</p>
          <div class="ap-appid-actions">
            <button class="ap-btn" data-ap="steamdb">${icon('external', 14)} SteamDB</button>
            <button class="ap-btn" data-ap="restart">${icon('power', 14)} Restart Steam</button>
            <button class="ap-btn" data-ap="addlib">${icon('plus', 14)} Add library folder</button>
          </div>
        </div>

        <div class="ap-card ap-drop" id="ap-drop">
          <span class="ap-drop-ico">${icon('upload', 22)}</span>
          <strong>Drop a folder here</strong>
          <small>or a single .exe, to add it to your library</small>
          <button class="ap-btn" data-ap="browse">${icon('folder', 14)} Browse</button>
        </div>
      </div>

      <div class="ap-libs" id="ap-libs"></div>

      <div class="ap-grid-head">
        <span class="ap-count" id="ap-count"></span>
        <div class="ap-sort">
          <button class="ap-sort-btn ${AP.sort === 'recent' ? 'active' : ''}" data-ap-sort="recent">Recent</button>
          <button class="ap-sort-btn ${AP.sort === 'az' ? 'active' : ''}" data-ap-sort="az">A-Z</button>
        </div>
        <div class="ap-search">
          ${icon('search', 15)}
          <input id="ap-search" type="search" placeholder="Search games…" value="${esc(AP.query)}" spellcheck="false" autocomplete="off">
        </div>
        <button class="ap-btn" data-ap="reload">${icon('refresh', 14)} Reload covers</button>
      </div>

      <div class="ap-grid" id="ap-grid"></div>
      <div class="ap-pager" id="ap-pager"></div>
    </div>`;

  apTickClock();
  clearInterval(apClock);
  apClock = setInterval(apTickClock, 1000);

  apPaintGrid();
  apPaintLibraries();

  // Covers arrive a moment later for anything not cached yet.
  if (typeof ensureArt === 'function') ensureArt(apGames().slice(0, 12)).catch(() => {});

  const root = host.querySelector('.ap');
  root.addEventListener('input', (e) => {
    if (e.target.id === 'ap-search') {
      AP.query = e.target.value;
      AP.page = 1;
      apPaintGrid();
    }
  });

  root.addEventListener('click', async (e) => {
    const page = e.target.closest('[data-ap-page]');
    if (page) { AP.page = Number(page.dataset.apPage) || 1; apPaintGrid(); return; }

    const sort = e.target.closest('[data-ap-sort]');
    if (sort) {
      AP.sort = sort.dataset.apSort;
      root.querySelectorAll('[data-ap-sort]').forEach((b) => b.classList.toggle('active', b === sort));
      AP.page = 1;
      apPaintGrid();
      return;
    }

    const btn = e.target.closest('[data-ap]');
    if (!btn) return;
    await apAction(btn.dataset.ap, root);
  });

  // Drag and drop: a folder or an .exe becomes a library entry.
  const drop = root.querySelector('#ap-drop');
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    const p = file && (file.path || (window.api.pathForFile && window.api.pathForFile(file)));
    if (!p) { toast('Drop a folder or an .exe from this PC', 'info'); return; }
    apImportPath(p);
  });
}

async function apImportPath(path) {
  const isDir = await window.api.pathExists(path).catch(() => false);
  if (!isDir) { toast('That path does not exist', 'warn'); return; }

  const res = await window.api.scanFolder(path).catch(() => null);
  if (!res || !res.ok) { toast(`Could not scan that folder: ${(res && res.error) || 'unknown error'}`, 'warn'); return; }
  if (!res.games.length) { toast('No launchable executables in there', 'info'); return; }

  if (res.games.length === 1) {
    await importGameEntry(res.games[0]);
    return;
  }

  openModal({
    title: `${res.games.length} games found`,
    ico: 'folder',
    body: `<p class="ap-hint">Pick the ones to add. Apex only records the path - it moves nothing.</p>
      <div class="import-list">${res.games.map((g, i) => `<label class="import-row">
        <input type="checkbox" data-ap-imp="${i}" checked>
        <div class="import-info"><strong>${esc(g.name)}</strong><small>${esc(g.exe)}</small></div>
      </label>`).join('')}</div>`,
    footer: '<button class="btn primary" id="ap-imp-go">Add selected</button>',
    onMount: (modal) => {
      modal.querySelector('#ap-imp-go').addEventListener('click', async () => {
        const picks = [...modal.querySelectorAll('[data-ap-imp]:checked')]
          .map((c) => res.games[Number(c.dataset.apImp)]);
        for (const g of picks) await importGameEntry(g);
        closeModal();
      });
    }
  });
}

async function apAction(act, root) {
  const id = (root.querySelector('#ap-appid') || {}).value?.trim() || '';

  if (act === 'lookup' || act === 'steamdb') {
    if (!/^\d{3,9}$/.test(id)) { toast('Type a numeric Steam app id first', 'warn'); return; }
    const url = act === 'steamdb'
      ? `https://steamdb.info/app/${id}/`
      : `https://store.steampowered.com/app/${id}/`;
    const ok = await window.api.openExternal(url).catch(() => false);
    if (!ok) toast('Could not open that page', 'warn');
    return;
  }

  if (act === 'restart') {
    const res = await window.api.steamRestart().catch(() => null);
    if (res && res.ok) toast(res.restarted ? 'Steam is restarting' : 'Steam is starting', 'check');
    else toast(`Could not restart Steam: ${(res && res.error) || 'unknown error'}`, 'warn');
    return;
  }

  if (act === 'addlib') {
    const dir = await window.api.pickFolder(State.settings.installPath);
    if (!dir) return;
    const res = await window.api.addSteamLibrary(dir).catch(() => null);
    if (res && res.ok !== false) { toast('Steam now uses that folder as a library', 'check'); apPaintLibraries(); }
    else toast(`Could not add that library: ${(res && res.error) || 'unknown error'}`, 'warn');
    return;
  }

  if (act === 'browse') { importFolder(); return; }

  if (act === 'reload') {
    const shown = apGames().slice(0, 12);
    for (const g of shown) {
      delete State.artAuto[g.id];
      if (typeof artAsked !== 'undefined') artAsked.delete(g.id);
    }
    if (typeof ensureArt === 'function') await ensureArt(shown);
    apPaintGrid();
    toast('Covers reloaded', 'check');
  }
}
