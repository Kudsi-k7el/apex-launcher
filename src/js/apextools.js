'use strict';

/**
 * Apex Tools - the dashboard that opens the Tools view.
 *
 * Three columns, the way the reference page reads: import on the left, the clock
 * in the middle, the Steam app id on the right. Under them, the games that
 * SteamTools' LuaTools has applied to this Steam account - read straight out of
 * `<steam>/userdata/<id>/config/stplug-in`.
 *
 * What this page does and does not touch:
 *   - it reads the plugin folder and shows the app ids it finds;
 *   - it inspects a .lua / .acf you drop on it and says what the file targets;
 *   - it deletes files from that folder when you ask (an uninstall);
 *   - it never writes a .lua or a manifest, and never changes what Steam owns.
 * The Add button therefore adds the title to the Apex library, which is a thing
 * Apex is allowed to do.
 */

const AP = { page: 1, sort: 'recent', query: '', scan: null, inspected: null };
let apClock = null;

/** Every app id found in a stplug-in folder, newest first, de-duplicated. */
function apApplied() {
  const out = [];
  const seen = new Set();
  const scan = AP.scan || { steam: [] };

  for (const user of scan.steam || []) {
    for (const file of user.files || []) {
      for (const appid of file.appids || []) {
        if (!appid || seen.has(appid)) continue;
        seen.add(appid);
        out.push({ appid: String(appid), file: file.name, dir: user.plugins, at: file.at || 0 });
      }
    }
  }
  return out;
}

/** The catalogue name for a Steam app id, when Apex already knows the game. */
function apTitle(appid) {
  const hit = (typeof allGames === 'function' ? allGames() : [])
    .find((g) => g && String(g.steamAppId) === String(appid));
  return hit ? hit.title : null;
}

function apGame(appid) {
  const title = apTitle(appid) || `Steam app ${appid}`;
  return {
    id: `lua:${appid}`,
    title,
    steamAppId: String(appid),
    developer: 'LuaTools',
    genre: 'Applied'
  };
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

/** The applied-games grid: one card per app id, with the app id under it. */
function apCardRow() {
  let rows = apApplied();
  const q = AP.query.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => {
      const title = apTitle(r.appid) || '';
      return r.appid.includes(q) || title.toLowerCase().includes(q) || r.file.toLowerCase().includes(q);
    });
  }
  if (AP.sort === 'az') {
    rows.sort((a, b) => String(apTitle(a.appid) || a.appid)
      .localeCompare(String(apTitle(b.appid) || b.appid)));
  } else {
    rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  return rows;
}

function apTile(row) {
  const title = apTitle(row.appid);
  const when = row.at ? timeAgo(new Date(row.at).toISOString()) : '';
  return `<button class="ap-tile" data-ap-info="${esc(row.appid)}" title="${esc(title || row.appid)}">
    <span class="ap-tile-art">${art(apGame(row.appid), 'cover')}</span>
    <span class="ap-tile-name">${esc(title || `App ${row.appid}`)}</span>
    <span class="ap-tile-meta">${icon('shield', 11)} ${esc(when || 'Applied')}</span>
  </button>`;
}

function apPaintGrid() {
  const grid = document.getElementById('ap-grid');
  const pager = document.getElementById('ap-pager');
  if (!grid) return;

  const all = apCardRow();
  const per = 12;
  const pages = Math.max(1, Math.ceil(all.length / per));
  AP.page = Math.min(Math.max(1, AP.page), pages);
  const slice = all.slice((AP.page - 1) * per, AP.page * per);

  const count = document.getElementById('ap-count');
  if (count) count.textContent = `${all.length} game${all.length === 1 ? '' : 's'}`;

  grid.innerHTML = slice.length
    ? slice.map(apTile).join('')
    : `<div class="ap-empty">
        <strong>No games found${all.length ? ' for that search' : ', add your first game to get started'}</strong>
        <small>Apex lists what LuaTools put in Steam's stplug-in folder. Nothing is applied yet.</small>
      </div>`;

  if (pager) {
    pager.innerHTML = pages > 1 ? `
      <button class="ap-page" data-ap-page="${AP.page - 1}" ${AP.page === 1 ? 'disabled' : ''}>${icon('left', 15)}</button>
      <span>${AP.page} / ${pages}</span>
      <button class="ap-page" data-ap-page="${AP.page + 1}" ${AP.page === pages ? 'disabled' : ''}>${icon('right', 15)}</button>` : '';
  }
}

/** The result of inspecting a dropped file, shown under the drop zone. */
function apInspectPanel() {
  const box = document.getElementById('ap-inspect');
  if (!box) return;
  const r = AP.inspected;

  if (!r) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;

  if (!r.ok) {
    box.innerHTML = `<div class="ap-file is-bad">${icon('warning', 15)}<div>
      <strong>Could not read that file</strong><small>${esc(r.error || '')}</small></div></div>`;
    return;
  }

  const ids = r.appids || [];
  const names = ids.map((id) => `${esc(apTitle(id) || `Steam app ${id}`)} <span class="ap-file-id">${esc(id)}</span>`);
  const inside = (AP.scan && AP.scan.steam || []).some((u) => String(r.file || '')
    .toLowerCase().startsWith(String(u.plugins).toLowerCase()));

  box.innerHTML = `<div class="ap-file">
    <div class="ap-file-head">
      ${icon('file', 15)}
      <strong title="${esc(r.file)}">${esc(r.name || 'file')}</strong>
      <span class="ap-file-kind">${esc(r.kind || 'lua')}</span>
    </div>
    <div class="ap-file-body">
      ${names.length
        ? names.map((n) => `<div class="ap-file-row">${n}</div>`).join('')
        : `<div class="ap-file-row muted">No app id inside that file.</div>`}
      ${r.depots && r.depots.length ? `<div class="ap-file-row muted">${r.depots.length} depot${r.depots.length === 1 ? '' : 's'}: ${r.depots.slice(0, 8).map(esc).join(', ')}</div>` : ''}
    </div>
    <div class="ap-file-actions">
      ${ids[0] ? `<button class="ap-btn" data-ap="store" data-id="${esc(ids[0])}">${icon('external', 13)} Store page</button>` : ''}
      ${ids[0] ? `<button class="ap-btn" data-ap="track" data-id="${esc(ids[0])}">${icon('plus', 13)} Track in Apex</button>` : ''}
      ${inside ? `<button class="ap-btn is-danger" data-ap="drop-file" data-file="${esc(r.file)}">${icon('trash', 13)} Remove file</button>` : ''}
    </div>
  </div>`;
}

function apPaint(host) {
  host.innerHTML = `
    <div class="ap">
      <div class="ap-top">
        <section class="ap-col ap-col-import">
          <span class="ap-kicker">Import</span>
          <div class="ap-drop" id="ap-drop">
            <span class="ap-drop-ico">${icon('upload', 22)}</span>
            <strong>Drag files here</strong>
            <small>lua &middot; zip &middot; manifest</small>
            <button class="ap-btn" data-ap="browse">Browse</button>
          </div>
          <div class="ap-inspect" id="ap-inspect" hidden></div>
        </section>

        <section class="ap-col ap-col-clock">
          <div class="ap-clock-time" id="ap-clock-time"></div>
          <div class="ap-clock-date" id="ap-clock-date"></div>
        </section>

        <section class="ap-col ap-col-appid">
          <span class="ap-kicker">App id of Steam</span>
          <input id="ap-appid" type="text" inputmode="numeric" placeholder="e.g. 1245620"
            spellcheck="false" autocomplete="off">
          <button class="ap-add" data-ap="add">${icon('plus', 16)} Add</button>
          <p class="ap-hint">Enter the Steam App ID to add a game to your Apex library.
            Steam itself is never changed.</p>
          <div class="ap-appid-actions">
            <button class="ap-btn" data-ap="restart">${icon('power', 14)} Restart Steam</button>
            <button class="ap-btn" data-ap="steamdb">${icon('external', 14)} SteamDB</button>
          </div>
        </section>
      </div>

      <div class="ap-grid-head">
        <span class="ap-count" id="ap-count"></span>
        <div class="ap-sort">
          <button class="ap-sort-btn ${AP.sort === 'recent' ? 'active' : ''}" data-ap-sort="recent">Recent</button>
          <button class="ap-sort-btn ${AP.sort === 'az' ? 'active' : ''}" data-ap-sort="az">A-Z</button>
        </div>
        <button class="ap-btn ap-reload" data-ap="reload">${icon('refresh', 14)} Reload covers</button>
        <div class="ap-search">
          ${icon('search', 15)}
          <input id="ap-search" type="search" placeholder="Search games…"
            value="${esc(AP.query)}" spellcheck="false" autocomplete="off">
        </div>
      </div>

      <div class="ap-grid" id="ap-grid"></div>
      <div class="ap-pager" id="ap-pager"></div>
    </div>`;

  apTickClock();
  clearInterval(apClock);
  apClock = setInterval(apTickClock, 1000);

  apPaintGrid();
  apInspectPanel();
  apScanInto();

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

    const info = e.target.closest('[data-ap-info]');
    if (info) {
      const appid = info.dataset.apInfo;
      const url = `https://store.steampowered.com/app/${appid}/`;
      window.api.openExternal(url).catch(() => {});
      return;
    }

    const btn = e.target.closest('[data-ap]');
    if (!btn) return;
    await apAction(btn.dataset.ap, root, btn);
  });

  // Drag and drop: inspect the file, never write it anywhere.
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
    const p = file && file.path;
    if (!p) { toast('Drop a .lua or .manifest from this PC', 'info'); return; }
    apInspect(p);
  });
}

/** Loads the plugin folders once and repaints the grid when they arrive. */
async function apScanInto() {
  if (!window.api.luaScan) return;
  let res = null;
  try { res = await window.api.luaScan(); } catch { res = null; }
  if (!res || !res.ok) return;
  AP.scan = res;
  apPaintGrid();
}

async function apInspect(file) {
  const res = await window.api.luaInspect(file).catch(() => null);
  AP.inspected = res || { ok: false, error: 'Could not read that file' };
  apInspectPanel();
  if (res && res.ok) {
    const n = (res.appids || []).length;
    toast(n ? `${res.name}: ${n} app id${n === 1 ? '' : 's'}` : `${res.name} read`, 'info');
  } else {
    toast((res && res.error) || 'Could not read that file', 'warn');
  }
}

/** Claims a title in the Apex library - never in Steam. */
async function apTrack(appid) {
  const id = String(appid || '').replace(/[^\d]/g, '');
  if (!/^\d{3,9}$/.test(id)) { toast('Type a numeric Steam app id first', 'warn'); return; }

  const known = (typeof allGames === 'function' ? allGames() : [])
    .find((g) => g && String(g.steamAppId) === id);

  if (known) {
    if (State.owned[known.id]) { toast(`${known.title} is already in your library`, 'info'); return; }
    State.owned[known.id] = true;
    await persist();
    if (typeof afterLibraryChange === 'function') afterLibraryChange();
    toast(`${known.title} added to your Apex library`, 'check');
    return;
  }

  let details = null;
  try { details = await window.api.storeDetails(id); } catch { details = null; }
  const name = details && details.ok && details.game && details.game.name
    ? details.game.name
    : `Steam app ${id}`;

  const g = makeCustomGame({ title: name, developer: 'Steam', genre: 'Tracked' });
  g.steamAppId = id;
  State.custom = State.custom || [];
  if (State.custom.some((x) => x.id === g.id)) { toast(`${name} is already tracked`, 'info'); return; }
  State.custom.push(g);
  State.owned[g.id] = true;
  await persist();
  if (typeof afterLibraryChange === 'function') afterLibraryChange();
  toast(`${name} tracked in your Apex library`, 'check');
}

async function apAction(act, root, btn) {
  const id = ((root.querySelector('#ap-appid') || {}).value || '').trim();

  if (act === 'add' || act === 'track') {
    await apTrack(act === 'track' ? btn.dataset.id : id);
    return;
  }

  if (act === 'store') {
    const appid = btn.dataset.id;
    window.api.openExternal(`https://store.steampowered.com/app/${appid}/`).catch(() => {});
    return;
  }

  if (act === 'steamdb') {
    if (!/^\d{3,9}$/.test(id)) { toast('Type a numeric Steam app id first', 'warn'); return; }
    window.api.openExternal(`https://steamdb.info/app/${id}/`).catch(() => {});
    return;
  }

  if (act === 'restart') {
    const res = await window.api.steamRestart().catch(() => null);
    if (res && res.ok) toast(res.restarted ? 'Steam is restarting' : 'Steam is starting', 'check');
    else toast(`Could not restart Steam: ${(res && res.error) || 'unknown error'}`, 'warn');
    return;
  }

  if (act === 'browse') {
    const file = await window.api.pickLuaFile().catch(() => null);
    if (file) apInspect(file);
    return;
  }

  if (act === 'drop-file') {
    const file = btn.dataset.file;
    const dir = ((AP.scan && AP.scan.steam) || []).map((u) => u.plugins)
      .find((p) => String(file).toLowerCase().startsWith(String(p).toLowerCase()));
    if (!dir) { toast('That file is not inside a Steam plugin folder', 'warn'); return; }
    const res = await window.api.luaRemove(file, dir).catch(() => null);
    if (res && res.ok) {
      toast('Removed from Steam', 'check');
      AP.inspected = null;
      apInspectPanel();
      await apScanInto();
    } else {
      toast((res && res.error) || 'Could not remove that file', 'warn');
    }
    return;
  }

  if (act === 'reload') {
    await apScanInto();
    toast('Covers reloaded', 'check');
  }
}
