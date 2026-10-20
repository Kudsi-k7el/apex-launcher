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

/**
 * The app ids this launcher added from the App id box.
 *
 * SteamTools has its own store in `stplug-in`; an id typed into Apex is not in
 * there, so it has to be remembered in the saved state or it would vanish from
 * the shelf the moment the view repainted. Older builds only wrote a custom
 * `Tracked` game, so those are lifted into the same list on read.
 */
function apTracked() {
  const out = [];
  const seen = new Set();

  const push = (appid, title, at) => {
    const id = String(appid || '').trim();
    if (!/^\d{3,9}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ appid: id, title: title || null, at: at || 0, source: 'apex', file: '' });
  };

  for (const row of State.luaTracked || []) push(row.appid, row.title, row.at);
  for (const g of State.custom || []) {
    if (g && g.genre === 'Tracked' && g.steamAppId) push(g.steamAppId, g.title, 0);
  }
  return out;
}

/** Every app id on the shelf: what LuaTools applied first, then what Apex added. */
function apApplied() {
  const out = [];
  const seen = new Set();
  const scan = AP.scan || { steam: [] };

  for (const user of scan.steam || []) {
    for (const file of user.files || []) {
      for (const appid of file.appids || []) {
        if (!appid || seen.has(appid)) continue;
        seen.add(appid);
        out.push({
          appid: String(appid), file: file.name, dir: user.plugins,
          at: file.at || 0, source: 'steam'
        });
      }
    }
  }

  for (const row of apTracked()) {
    if (seen.has(row.appid)) continue;
    seen.add(row.appid);
    out.push(row);
  }
  return out;
}

/** The catalogue name for a Steam app id, when Apex already knows the game. */
function apTitle(appid) {
  const id = String(appid);
  const tracked = apTracked().find((t) => t.appid === id);
  if (tracked && tracked.title) return tracked.title;
  const hit = (typeof allGames === 'function' ? allGames() : [])
    .find((g) => g && String(g.steamAppId) === id);
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
      return r.appid.includes(q) || title.toLowerCase().includes(q)
        || String(r.file || '').toLowerCase().includes(q);
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
  const apex = row.source === 'apex';
  const meta = apex
    ? `${icon('plus', 11)} ${esc(when || 'Added in Apex')}`
    : `${icon('shield', 11)} ${esc(when || 'Applied')}`;
  return `<button class="ap-tile${apex ? ' is-apex' : ''}" data-ap-info="${esc(row.appid)}" title="${esc(title || row.appid)}">
    <span class="ap-tile-art">${art(apGame(row.appid), 'cover')}</span>
    <span class="ap-tile-name">${esc(title || `App ${row.appid}`)}</span>
    <span class="ap-tile-meta">${meta}</span>
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

  // SteamTools' folder is where the shelf came from; say so plainly when it is
  // missing, otherwise an "Add" here looks like it should change Steam too.
  const note = document.getElementById('ap-note');
  if (note) {
    const users = (AP.scan && AP.scan.steam) || [];
    const found = users.some((u) => u.hasPlugins);
    note.hidden = !AP.scan || found;
    note.innerHTML = note.hidden ? '' : `${icon('warning', 14)}
      <span>SteamTools was not found in this Steam install (no <code>stplug-in</code>
      folder). Games you add here stay in Apex &mdash; Steam is not changed.</span>`;
  }

  grid.innerHTML = slice.length
    ? slice.map(apTile).join('')
    : `<div class="ap-empty">
        <strong>No games found${all.length ? ' for that search' : ' yet'}</strong>
        <small>Drop a LuaTools file on the import box to inspect it, or type a Steam
        app id on the right. Games added there are listed here too &mdash; Steam
        itself only shows the games you own or install.</small>
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
          <p class="ap-hint">Adds the title to your Apex library and to the list below.
            Steam itself is not changed &mdash; it only shows games you own or install,
            and unlocking needs SteamTools plus a valid LuaTools file.</p>
          <button class="ap-btn ap-install" data-ap="install">${icon('download', 14)} Install in Steam</button>
          <div class="ap-appid-actions">
            <button class="ap-btn" data-ap="restart">${icon('power', 14)} Restart Steam</button>
            <button class="ap-btn" data-ap="steamdb">${icon('external', 14)} SteamDB</button>
          </div>
        </section>
      </div>

      <div class="ap-note" id="ap-note" hidden></div>

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
  apResolveNames();
}

/** Puts the real Steam library capsule where art() looks for it. */
function apCacheArt(appid, a) {
  if (!a || !a.ok || !(a.cover || a.wide || a.hero)) return false;
  State.artAuto = State.artAuto || {};
  State.artAuto[`lua:${appid}`] = a.cover || a.wide || a.hero;
  return true;
}

/**
 * Old adds were saved as "Steam app 4954910" because store:details answers with
 * `data.name`, not `game.name`. Fill those names in once, from the store.
 * Their banners also need a lookup: the old predictable CDN path 404s for
 * recent AppIDs, so the portrait capsule comes from store:assets.
 */
async function apResolveNames() {
  if (AP.namesResolving) return;
  const missing = apTracked().filter((t) => !t.title || /^Steam app \d+$/i.test(t.title)
    || !(State.artAuto && State.artAuto[`lua:${t.appid}`]));
  if (!missing.length) return;
  AP.namesResolving = true;
  let changed = false;

  for (const t of missing) {
    let rec = null;
    if (!t.title || /^Steam app \d+$/i.test(t.title)) {
      const res = await window.api.storeDetails(t.appid).catch(() => null);
      rec = res && (res.data || res.game);
    }

    const art = await window.api.storeAssets(t.appid).catch(() => null);
    const name = (rec && rec.name) || (art && art.name) || t.title;
    if (art && art.ok) changed = apCacheArt(t.appid, art) || changed;

    if (name) {
      State.luaTracked = Array.isArray(State.luaTracked) ? State.luaTracked : [];
      const row = State.luaTracked.find((x) => String(x.appid) === t.appid);
      if (row) {
        if (row.title !== name) { row.title = name; changed = true; }
      } else {
        State.luaTracked.push({ appid: t.appid, title: name, at: Date.now() });
        changed = true;
      }
      const g = (State.custom || []).find((x) => String(x.steamAppId) === t.appid);
      if (g) {
        if (g.title !== name) { g.title = name; changed = true; }
        if (art && art.ok) {
          const cover = art.cover || art.wide || null;
          const wide = art.wide || null;
          const hero = art.hero || null;
          if (g.cover !== cover || g.wide !== wide || g.hero !== hero) {
            g.cover = cover; g.wide = wide; g.hero = hero;
            changed = true;
          }
        }
      }
    }
  }

  AP.namesResolving = false;
  if (changed) {
    await persist();
    if (typeof afterLibraryChange === 'function') afterLibraryChange();
    apPaintGrid();
  }
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

  let details = null;
  try { details = await window.api.storeDetails(id).catch(() => null); } catch { details = null; }
  // store:details answers with `data`; older code looked for `game` and so every
  // title fell back to "Steam app <id>".
  const rec = details && (details.data || details.game);
  const art = await window.api.storeAssets(id).catch(() => null);
  apCacheArt(id, art);

  const known = (typeof allGames === 'function' ? allGames() : [])
    .find((g) => g && String(g.steamAppId) === id);
  const name = (rec && rec.name) || (art && art.name) || (known && known.title) || `Steam app ${id}`;

  // The shelf reads this list, so an id added here has to be remembered or it
  // disappears on the next repaint (stplug-in never contained it).
  State.luaTracked = Array.isArray(State.luaTracked) ? State.luaTracked : [];
  const tracked = State.luaTracked.find((t) => String(t.appid) === id);
  if (tracked) {
    tracked.title = name;
    tracked.at = tracked.at || Date.now();
  } else {
    State.luaTracked.push({ appid: id, title: name, at: Date.now() });
  }

  const added = !known || !State.owned[known.id];
  if (known) {
    State.owned[known.id] = true;
    if (rec && rec.name) known.title = rec.name;
  } else {
    const g = makeCustomGame({ title: name, developer: 'Steam', genre: 'Tracked' });
    g.steamAppId = id;
    if (art && art.ok) {
      g.cover = art.cover || art.wide || null;
      g.wide = art.wide || null;
      g.hero = art.hero || null;
    }
    State.custom = State.custom || [];
    State.custom.push(g);
    State.owned[g.id] = true;
  }

  await persist();
  if (typeof afterLibraryChange === 'function') afterLibraryChange();
  apPaintGrid();

  const input = document.getElementById('ap-appid');
  if (input) input.value = '';

  toast(added
    ? `${name} added to Apex \u2014 Steam is unchanged`
    : `${name} is already in Apex \u2014 Steam is unchanged`, 'check');
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

  // Hands the id to the Steam client and lets Steam enforce ownership: it
  // installs what the account owns and opens the store page for everything else.
  if (act === 'install') {
    if (!/^\d{3,9}$/.test(id)) { toast('Type a numeric Steam app id first', 'warn'); return; }
    await window.api.openExternal(`steam://install/${id}`).catch(() => {});
    toast(`Steam will install app ${id} if this account owns it`, 'info');
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
