'use strict';

/**
 * LuaTools - the dashboard on the LuaTools tab of the Apex Tools view.
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
 *   - it can write a .lua and seed an appmanifest into Steam so a game shows up
 *     in the library, the way LuaTools does.
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
    <span class="ap-tile-del" data-ap-del="${esc(row.appid)}" title="Delete this game from Steam and the shelf">${icon('trash', 12)}</span>
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
        <small>Drop a .lua or appmanifest on the import box to inspect it, or type a Steam
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
      ${ids[0] ? `<button class="ap-btn is-primary" data-ap="apply" data-id="${esc(ids[0])}">${icon('download', 13)} Apply to Steam</button>` : ''}
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
          <p class="ap-hint">Adds the game to Steam itself, the LuaTools way: it writes
            the unlock file and a library entry for the id, and puts the loader
            plugin in place while Steam is closed. Restart Steam and the title
            waits in your library, ready to download. It joins your Apex shelf too.</p>
          <button class="ap-btn ap-install" data-ap="install">${icon('download', 14)} Install in Steam</button>
          <button class="ap-btn" data-ap="download-all">${icon('download', 14)} Download all</button>
          <button class="ap-btn" data-ap="inject">${icon('zap', 14)} Inject LuaTools</button>
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

      <div class="ap-dl" id="ap-dl" hidden></div>

      <section class="ap-depots-wrap" id="ap-depots-wrap">
        <div class="ap-sec-head">
          <span class="ap-kicker">Applied files &amp; depots</span>
          <small class="ap-sec-sub">Read straight from Steam's
            <code>stplug-in</code> folder. Toggle a depot, re-pin it to a
            manifest, or pull the depot's content straight from Steam's CDN.</small>
          <button class="ap-btn apx-mini" data-ap="apx:repair-manifests"
            title="Fetches manifests Steam pruned, from the manifest backend, into the root depotcache">
            ${icon('refresh', 12)} Repair manifests</button>
        </div>
        <div id="ap-depots"></div>
      </section>

      <section class="ap-modes-section" id="ap-modes-wrap">
        <div class="ap-sec-head">
          <span class="ap-kicker">Unlocker modes</span>
          <small class="ap-sec-sub">Only one is active at a time, the way
            LuaTools' Mode page works.</small>
        </div>
        <div class="ap-modes" id="ap-modes"></div>
      </section>
    </div>`;

  apTickClock();
  clearInterval(apClock);
  apClock = setInterval(apTickClock, 1000);

  apPaintGrid();
  apInspectPanel();
  apScanInto();

  // The LuaTools app ports: downloads queue, the depot table, the modes.
  apInitLuaEvents();
  apPaintDl();
  apPaintDepots();
  apPaintModes();

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

    const del = e.target.closest('[data-ap-del]');
    if (del) {
      await apDelete(del.dataset.apDel);
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
    if (String(btn.dataset.ap || '').startsWith('apx:')) {
      await apxAction(String(btn.dataset.ap).slice(4), root, btn);
      return;
    }
    await apAction(btn.dataset.ap, root, btn);
  });

  // Drag and drop: inspect the file and apply it to Steam.
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
  apPaintDepots();
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
 *
 * The applied shelf rows read from stplug-in are covered too - those AppIDs
 * have no tracked row yet, so before this ran they sat as "App 4496490" with a
 * blank placeholder forever. AppIDs with no store page fall back to Steam's
 * global app list (store:name).
 */
async function apResolveNames() {
  if (AP.namesResolving) return;
  const fakeTitle = (t) => !t.title || /^Steam app \d+$/i.test(t.title);
  const tracked = new Map(apTracked().map((t) => [t.appid, t]));
  // Every id on the shelf that has no real title or no artwork yet.
  const missing = apApplied().filter((row) => {
    const t = tracked.get(row.appid) || {};
    return fakeTitle({ title: t.title }) || !(State.artAuto && State.artAuto[`lua:${row.appid}`]);
  });
  if (!missing.length) return;
  AP.namesResolving = true;
  let changed = false;

  for (const row of missing) {
    const t = tracked.get(row.appid) || row;

    let name = '';
    if (fakeTitle(t)) {
      // Storefront first; the global app list answers for AppIDs that were
      // never published (store details and assets both 404 for those - that
      // is exactly where the "SA4" placeholders came from).
      const res = await window.api.storeDetails(row.appid).catch(() => null);
      const rec = res && (res.data || res.game);
      name = (rec && rec.name) || '';
    }

    const art = await window.api.storeAssets(row.appid).catch(() => null);
    if (!name && art && art.ok && art.name) name = art.name;
    if (!name && fakeTitle(t)) {
      const named = await window.api.storeName(row.appid).catch(() => null);
      if (named && named.ok && named.name) name = named.name;
    }
    if (art && art.ok) changed = apCacheArt(row.appid, art) || changed;

    if (name) {
      State.luaTracked = Array.isArray(State.luaTracked) ? State.luaTracked : [];
      const live = State.luaTracked.find((x) => String(x.appid) === row.appid);
      if (live) {
        if (live.title !== name) { live.title = name; changed = true; }
      } else {
        State.luaTracked.push({ appid: row.appid, title: name, at: Date.now() });
        changed = true;
      }
      const g = (State.custom || []).find((x) => String(x.steamAppId) === row.appid);
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
    // Automatically put the game into Steam's library, the way LuaTools does.
    try {
      const applied = await window.api.luaApply(file).catch(() => null);
      if (applied && applied.ok) {
        const m = (applied.appids || []).length;
        toast(m ? `Applied ${m} game${m === 1 ? '' : 's'} to Steam` : 'Applied to Steam', 'check');
        if (applied.loader === 'locked') toast('Steam is open - close it, then hit Inject LuaTools to finish setup', 'warn');
        else if (applied.loader === 'failed') toast('The LuaTools loader could not be installed - use Inject LuaTools', 'warn');
        else if (applied.loader === 'installed') toast('LuaTools plugin injected into Steam', 'check');
        await apScanInto();
        // Ask Steam to start downloading/installing each applied app.
        for (const id of (applied.appids || [])) {
          try { await window.api.openExternal(`steam://install/${id}`); } catch { /* best effort */ }
        }
        // Restart Steam so it reads the new appmanifest and starts the download.
        try { await window.api.steamRestart(); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  } else {
    toast((res && res.error) || 'Could not read that file', 'warn');
  }
}

/** Claims a title in the Apex library - never in Steam. */
async function apTrack(appid, toSteam) {
  const id = String(appid || '').replace(/[^\d]/g, '');
  if (!/^\d{3,9}$/.test(id)) { toast('Type a numeric Steam app id first', 'warn'); return; }

  // Adding by the app-id field is the full LuaTools hand: write the unlock
  // lua, seed the library manifest and (Steam being closed) put the loader
  // plugin in too - so Steam itself lists the title after its next restart.
  // "Track in Apex" from an import row keeps the shelf-only behaviour.
  let applyRes = null;
  if (toSteam) {
    toast(`Adding ${id} to Steam \u2014 writing the LuaTools files\u2026`, 'info');
    applyRes = await window.api.luaApply(id).catch((e) => ({ ok: false, error: e.message }));
    if (!applyRes || !applyRes.ok) {
      toast((applyRes && applyRes.error) || `Could not add app ${id} to Steam`, 'warn');
      return;
    }
  }

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

  if (toSteam) {
    // The Steam side is the point of the add: state the loader honestly,
    // because a lua without it is invisible to Steam.
    if (applyRes.loader === 'locked') {
      toast(`${name} added \u2014 Steam is open, so close it and hit Inject LuaTools to finish`, 'warn');
    } else if (applyRes.loader === 'failed') {
      toast(`${name} added \u2014 the loader plugin failed to install, use Inject LuaTools`, 'warn');
    } else {
      toast(`${name} added to Steam \u2014 restart Steam and it shows in the library`, 'check');
    }
    await apScanInto();
  } else {
    toast(added
      ? `${name} added to Apex \u2014 Steam is unchanged`
      : `${name} is already in Apex \u2014 Steam is unchanged`, 'check');
  }
}

/**
 * Deletes one game, everywhere: its unlock lines are commented out of the lua,
 * the seeded appmanifest leaves Steam's library, the depots only it needed
 * leave the depotcache (Steam's own removes the rest of it when told), and the
 * shelf forgets it. A Steam-written appmanifest of a real install is never
 * touched.
 */
async function apDelete(appid) {
  const id = String(appid || '').replace(/[^\d]/g, '');
  if (!/^\d{3,9}$/.test(id)) return;
  const title = apTitle(id) || `App ${id}`;
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Delete "${title}" from Steam and Apex?\n\nThis removes the unlock lines, the library entry Apex seeded and the cached depot files, and the shelf tile.`)) return;

  toast(`Deleting ${title}\u2026`, 'info');
  const res = await window.api.luaUninstallApp(id).catch((e) => ({ ok: false, error: e.message }));
  if (!res || !res.ok) {
    toast((res && res.error) || 'Could not delete the game', 'warn');
    return;
  }

  // Shelf state: the tracked row, the Apex library twin, ownership and art.
  let changed = false;
  const rows = Array.isArray(State.luaTracked) ? State.luaTracked : [];
  const kept = rows.filter((t) => String(t.appid) !== id);
  if (kept.length !== rows.length) { State.luaTracked = kept; changed = true; }

  if (Array.isArray(State.custom)) {
    const before = State.custom.length;
    State.custom = State.custom.filter((g) =>
      !(g && g.genre === 'Tracked' && String(g.steamAppId) === id));
    if (State.custom.length !== before) changed = true;
  }

  State.owned = State.owned || {};
  const ownedKey = `lua:${id}`;
  if (State.owned[ownedKey]) { delete State.owned[ownedKey]; changed = true; }
  if (State.artAuto && State.artAuto[ownedKey]) {
    delete State.artAuto[ownedKey];
    changed = true;
  }
  // detail panel state for that file is stale now
  if (res.file) { delete AP.detail[res.file]; delete AP.open[res.file]; }

  if (changed) { await persist(); if (typeof afterLibraryChange === 'function') afterLibraryChange(); }
  await apScanInto();
  apPaintGrid();

  const parts = [];
  if (res.lua) parts.push('unlock removed');
  const dead = (res.manifests || []).filter((m) => m.ok).length;
  if (dead) parts.push(`${dead} library entr${dead === 1 ? 'y' : 'ies'} deleted`);
  if ((res.depotcache || []).length) parts.push(`${res.depotcache.length} depot file${res.depotcache.length === 1 ? '' : 's'} pruned`);
  toast(`${title} deleted${parts.length ? ` \u2014 ${parts.join(', ')}` : ''}`, 'check');
  if (res.steamRunning) toast('Restart Steam so it drops the game too', 'warn');
}

async function apAction(act, root, btn) {
  const id = ((root.querySelector('#ap-appid') || {}).value || '').trim();

  if (act === 'add' || act === 'track') {
    await apTrack(act === 'track' ? btn.dataset.id : id, act === 'add');
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

  // Writes the LuaTools files + appmanifest so the title shows in Steam's
  // library, then hands the id to Steam to start the download directly.
  if (act === 'install') {
    if (!/^\d{3,9}$/.test(id)) { toast('Type a numeric Steam app id first', 'warn'); return; }
    try {
      const fn = (window.api.luaDownload || window.api.luaInstall);
      const res = await fn(id).catch(() => null);
      if (res && res.ok) {
        toast(`Added app ${id} to Steam's library for download`, 'check');
        try { await window.api.steamRestart(); } catch { /* best effort */ }
      }
      else if (res && res.error) toast(res.error, 'warn');
    } catch (e) { /* best effort */ }
    await window.api.openExternal(`steam://install/${id}`).catch(() => {});
    toast(`Steam will download app ${id} directly from its library`, 'info');
    return;
  }

  if (act === 'download-all') {
    try {
      const res = await window.api.luaDownloadAll().catch(() => null);
      if (res && res.ok) {
        toast(`Queued ${ (res.appids || []).length } game(s) for download in Steam`, 'check');
        try { await window.api.steamRestart(); } catch { /* best effort */ }
      } else if (res && res.error) toast(res.error, 'warn');
    } catch (e) { toast('Could not queue downloads', 'warn'); }
    return;
  }

  // "Inject LuaTools" is the one-button setup: runs the real LuaTools
  // installer (silent), then puts the Steam plugin in place so the .lua files
  // are actually loaded.
  if (act === 'inject') {
    try {
      const inst = await window.api.luaInstallLuaTools().catch(() => null);
      if (inst && inst.ok) toast('LuaTools installer launched', 'check');
      else if (inst && inst.error) toast(inst.error, 'warn');
    } catch (e) { toast('Could not launch the LuaTools installer', 'warn'); }
    try {
      const res = await window.api.luaInject().catch(() => null);
      if (res && res.ok) toast(`LuaTools plugin installed to ${res.path}`, 'check');
      else if (res && res.error) toast(res.error, 'warn');
    } catch (e) { toast('Could not install the plugin', 'warn'); }
    return;
  }

  if (act === 'apply') {
    const appid = btn.dataset.id || id;
    if (!/^\d{3,9}$/.test(String(appid || '').trim())) { toast('No app id to apply', 'warn'); return; }
    try {
      const res = await window.api.luaApply(String(appid).trim()).catch(() => null);
      if (res && res.ok) {
        toast(`Applied ${appid} to Steam`, 'check');
        await apScanInto();
      } else {
        toast((res && res.error) || 'Could not apply to Steam', 'warn');
      }
    } catch (e) { toast('Could not apply to Steam', 'warn'); }
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

// ===========================================================================
// LuaTools app ports (see luatoolsplus.js): depot editor, CDN downloads,
// unlocker modes. Actions are namespaced "apx:<name>" so they can't collide
// with the original tab's buttons.
// ===========================================================================

Object.assign(AP, {
  detail: {},    // file -> readLua() result (or in-flight state)
  open: {},      // file -> true while the file's depot rows are expanded
  runs: {},      // depot-download id -> live state painted by apPaintDl()
  modes: null,   // luaModes() result
  tool: null     // DepotDownloaderMod fetch progress while the tool downloads
});

/** One event subscription for the whole tab: depot downloads + mode installs. */
function apInitLuaEvents() {
  if (AP.eventsHooked || !window.api.onLuaEvent) return;
  AP.eventsHooked = true;
  window.api.onLuaEvent((evt) => {
    if (evt && evt.type === 'mode-done') {
      toast(evt.ok ? 'Unlocker mode updated'
        : `Mode install failed: ${evt.error || (evt.failed || []).join(', ')}`, evt.ok ? 'check' : 'warn');
      apLoadModes();
      return;
    }
    if (evt && evt.type === 'mode-progress') return; // the buttons cover it
    if (evt && evt.type === 'tool') {
      const run = AP.runs['tool-fetch'];
      if (run) { run.pct = evt.pct || 0; run.phase = 'Fetching DepotDownloaderMod\u2026'; apPaintDl(); }
      return;
    }
    const run = AP.runs[evt.id];
    if (!run) return;
    if (evt.type === 'start') run.state = 'running';
    else if (evt.type === 'manifest') { run.phase = `Fetching manifest for depot ${evt.depot}`; }
    else if (evt.type === 'progress') { run.pct = evt.pct || 0; run.phase = `Depot ${evt.depot} downloading`; }
    else if (evt.type === 'phase') { run.phase = `Depot ${evt.depot} ` + ({ manifest: 'fetching manifest', 'pre-allocating': 'pre-allocating', validating: 'validating', downloading: 'downloading' }[evt.phase] || evt.phase); }
    else if (evt.type === 'file') run.note = evt.note || '';
    else if (evt.type === 'stderr') run.note = evt.note || '';
    else if (evt.type === 'skip') { run.errors = run.errors || []; run.errors.push(`depot ${evt.depot}: ${evt.error || 'skipped'}`); }
    else if (evt.type === 'depot-done') { run.depotDone = (run.depotDone || 0) + 1; if (!evt.ok) { run.errors = run.errors || []; run.errors.push(`depot ${evt.depot}: exited with ${evt.error || evt.code}`); } }
    else if (evt.type === 'done') { run.state = evt.ok ? 'done' : 'error'; run.error = evt.error || null; run.pct = run.state === 'done' ? 1 : run.pct; }
    apPaintDl();
    if (evt.type === 'done' && run.state === 'done') { apScanInto().catch(() => {}); }
  });
}

/** Live progress rows for CDN depot downloads and tool fetches. */
function apPaintDl() {
  const box = document.getElementById('ap-dl');
  if (!box) return;
  const rows = [];
  for (const id of Object.keys(AP.runs)) {
    const r = AP.runs[id];
    if (r.state === 'done' && rows.length && !r.errors) continue; // collapse old successes
    rows.push(`<div class="apx-dl${r.state === 'done' ? ' is-ok' : ''}${r.state === 'error' ? ' is-bad' : ''}">
      <div class="apx-dl-title">${icon('download', 14)} App ${esc(r.appId)} \u2014 Steam CDN download
        ${r.state === 'running' ? `<button class="ap-btn is-danger apx-mini" data-ap="apx:dl-cancel" data-id="${esc(id)}">${icon('close', 11)} Stop</button>` : ''}
      </div>
      <div class="apx-bar"><span style="width:${Math.round((r.pct || 0) * 100)}%;${r.state === 'error' ? 'background:#ff7a7a' : ''}"></span></div>
      <div class="apx-dl-sub">
        <span>${esc(r.phase || 'Queued')}${r.depots && r.state === 'running' ? ` \u00b7 ${r.depotDone || 0}/${r.depots.length}` : ''}</span>
        <span>${Math.round((r.pct || 0) * 100)}%</span>
      </div>
      ${(r.errors || []).slice(0, 3).map((s) => `<small class="apx-err">${esc(s)}</small>`).join('')}
    </div>`);
  }
  box.hidden = !rows.length;
  box.innerHTML = rows.join('');
}

/** The stack of applied lua files, one of which can be expanded per time. */
function apPaintDepots() {
  const box = document.getElementById('ap-depots');
  if (!box) return;
  const users = (AP.scan && AP.scan.steam) || [];
  const files = [];
  for (const u of users) {
    for (const f of u.files || []) files.push({ name: f.name, at: f.at || 0, size: f.size || 0, lua: f.lua, appids: f.appids || [], pins: f.pins || [], dir: u.plugins });
  }
  if (!AP.scan) {
    box.innerHTML = `<div class="apx-busy">Reading Steam's plugin folders&hellip;</div>`;
    return;
  }
  if (!files.length) {
    box.innerHTML = `<div class="apx-empty">No lua files applied yet. Import one on the left, or add a game id above.</div>`;
    return;
  }
  box.innerHTML = files.map((f) => {
    const isOpen = AP.open[f.name];
    const d = AP.detail[f.name];
    const depots = (d && d.ok && d.depots) || [];
    const gold = (t) => esc(t);
    return `<div class="apx-file${isOpen ? ' is-open' : ''}">
      <button class="apx-file-head" data-ap="apx:file" data-file="${gold(f.name)}">
        <span class="apx-file-ico">${icon('file', 15)}</span>
        <strong>${gold(f.name)}</strong>
        <span class="apx-file-meta">${f.appids.length ? `${f.appids.length} app id${f.appids.length === 1 ? '' : 's'}` : 'no app id'}
          \u00b7 depots ${f.pins.length || 0}</span>
        <span class="apx-file-time">${esc(f.at ? timeAgo(new Date(f.at).toISOString()) : '')}</span>
        <span class="apx-chev">${icon(isOpen ? 'chevronUp' : 'chevron', 13)}</span>
      </button>
      ${isOpen ? apDepotDetail(f, d) : ''}
    </div>`;
  }).join('');
}

/** The expanded body of one lua file: its depots, DLC ids and editor inputs. */
function apDepotDetail(f, d) {
  if (!d) return `<div class="apx-busy">Reading ${esc(f.name)}&hellip;</div>`;
  if (!d.ok) return `<div class="apx-empty">${esc(d.error || 'Could not read that file')}</div>`;

  const fileAttr = `data-file="${esc(f.name)}"`;
  const edited = d.edited;
  const scanFile = ((AP.scan && AP.scan.steam || []).find((u) => u.primary) || {})
    .files && ((AP.scan.steam.find((u) => u.primary) || {}).files || []).find((x) => x.name === f.name);
  const cachedIds = new Set(((scanFile && scanFile.pins) || []).filter((p) => p.cached).map((p) => String(p.depot)));

  const deed = (row) => {
    const id = row.id;
    const isDepot = !!row.hasKey;
    const pin = row.pin;
    const dlDead = !isDepot || !row.key;
    return `<div class="apx-row">
      <span class="apx-id">${esc(id)}</span>
      ${isDepot
        ? `<span class="apx-tag"${row.key ? '' : ' title="No decryption key in that line"'}>${icon(row.key ? 'shield' : 'info', 11)} ${row.key ? 'depot key' : 'no key'}</span>`
        : `<span class="apx-tag muted">${icon('plus', 11)} DLC</span>`}
      ${isDepot && (row.pin || id === String(d.appId)) ? (cachedIds.has(String(id))
        ? `<span class="apx-badge is-ok" title="The pinned manifest is in Steam's depotcache">cached</span>`
        : `<span class="apx-badge is-warn" title="Steam pruned that manifest - hit 'Repair manifests' above and restart Steam">pruned</span>`) : ''}
      <button class="apx-switch ${row.enabled ? 'is-on' : ''}" data-ap="apx:depot-toggle" data-depot="${esc(id)}" ${fileAttr}
        title="Comment that addappid line in or out - LuaTools' own per-depot switch">
        <span></span><small>${row.enabled ? 'Enabled' : 'Disabled'}</small>
      </button>
      ${isDepot ? `<span class="apx-pin">
        <input type="text" inputmode="numeric" class="apx-pin-input" placeholder="${pin && pin.locked ? pin.manifest : 'manifest id'}"
          value="${pin && pin.locked ? esc(pin.manifest) : ''}" spellcheck="false" autocomplete="off">
        <button class="ap-btn apx-mini" data-ap="apx:pin" data-depot="${esc(id)}" ${fileAttr}>Pin</button>
        ${pin ? `<button class="apx-switch ${pin.locked ? 'is-on' : ''}" data-ap="apx:pin-lock" data-depot="${esc(id)}"
          title="Lock = pinned to that manifest (setManifestid active). Unlock = Steam may update the depot">
          <span></span><small>${pin.locked ? 'Locked' : 'Free'}</small></button>`
        : `<small class="apx-muted">no pin</small>`}
      </span>` : ''}
      <button class="ap-btn apx-mini is-primary" data-ap="apx:dl" data-depot="${esc(id)}"
        ${dlDead ? 'disabled title="Needs a depot key"' : `title="Download this depot's content from Steam's CDN"`} ${fileAttr}>
        ${icon('download', 12)} CDN
      </button>
      <button class="ap-btn is-danger apx-mini" data-ap="apx:depot-off" data-depot="${esc(id)}" ${fileAttr} title="Comment the whole line out">Clean</button>
    </div>`;
  };

  const base = d.appId;
  const name = base ? (apTitle(base) || `App ${base}`) : null;
  return `<div class="apx-detail">
    ${edited ? `<small class="apx-note">${icon('checkCircle', 11)} Edit applied. Toggle changes take effect when Steam's unlocker re-reads the folder.</small>` : ''}
    ${base ? `<div class="apx-row apx-base">
      <span class="apx-id">${esc(base)}</span>
      <strong>${esc(name || `App ${base}`)}</strong>
      <button class="ap-btn apx-mini" data-ap="apx:store" data-id="${esc(base)}">${icon('external', 12)} Store</button>
    </div>` : ''}
    ${depots.sort((a, b) => (a.id === base) - (b.id === base) || (a.id - b.id)).map(deed).join('')}
    ${(d.dlc || []).slice(0, 40).map(deed).join('')}
    ${(d.dlc || []).length > 40 ? `<div class="apx-empty">…and ${(d.dlc).length - 40} more DLC ids</div>` : ''}
    <div class="apx-forms">
      <span class="apx-form">
        <small>Add depot</small>
        <input type="text" class="apx-in apx-in-depot" placeholder="depot id" spellcheck="false">
        <input type="text" class="apx-in apx-in-key" placeholder="hex key (optional)" spellcheck="false">
        <button class="ap-btn apx-mini" data-ap="apx:depot-add" ${fileAttr}>${icon('plus', 12)} Add</button>
      </span>
      <span class="apx-form">
        <small>Add app id</small>
        <input type="text" class="apx-in apx-in-appid" placeholder="app id" spellcheck="false">
        <button class="ap-btn apx-mini" data-ap="apx:app-add" ${fileAttr}>${icon('plus', 12)} Add</button>
      </span>
      <span class="apx-form">
        <small>Track token</small>
        <input type="text" class="apx-in apx-in-token" placeholder="addtoken value" spellcheck="false">
        <button class="ap-btn apx-mini" data-ap="apx:token-add" ${fileAttr}>${icon('plus', 12)} Add</button>
      </span>
    </div>
  </div>`;
}

/** Open/expand a file, lazily loading its detailed parse once. */
async function apToggleFile(file) {
  const f = (AP.scan.steam || []).flatMap((u) => u.files || [])
    .find((x) => x.name === file);
  if (!f) return;
  const rec = { ...f, dir: ((AP.scan.steam || []).find((u) => (u.files || []).includes(f)) || {}).plugins };
  if (AP.open[file]) {
    AP.open[file] = false;
  } else {
    AP.open[file] = true;
    if (!AP.detail[file]) {
      AP.detail[file] = { loading: true };
      apPaintDepots();
      const full = String(rec.dir || '').replace(/[\\/]+$/, '') + '\\' + file;
      const res = await window.api.luaRead(full).catch(() => null);
      AP.detail[file] = res || { ok: false, error: 'Could not read that file' };
    }
  }
  apPaintDepots();
}

/** Fetch DepotDownloaderMod once, painting its own progress row. */
async function apEnsureDepotTool() {
  const st = await window.api.luaDownloader().catch(() => null);
  if (st && st.installed) return true;
  AP.runs['tool-fetch'] = { id: 'tool-fetch', appId: '', phase: 'Fetching DepotDownloaderMod\u2026', pct: 0, state: 'running', depots: [], errors: [] };
  apPaintDl();
  const got = await window.api.luaDownloaderFetch().catch(() => null);
  delete AP.runs['tool-fetch'];
  apPaintDl();
  if (!got || !got.ok) {
    toast((got && got.error) || 'DepotDownloaderMod could not be fetched', 'warn');
    return false;
  }
  toast('DepotDownloaderMod is ready', 'check');
  return true;
}

/** Pick a folder, then start one CDN run for the given depots of one lua. */
async function apDepotDownload(appId, file, depots) {
  if (!await apEnsureDepotTool()) return;
  const out = await window.api.pickFolder(null).catch(() => null);
  if (!out) return;
  const res = await window.api.luaDepotDownload({
    appId, file, depots: depots.map((d) => ({ depot: d.depot, manifest: d.manifest })), outDir: out
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!res || !res.ok) { toast((res && res.error) || 'Could not start that download', 'warn'); return; }
  AP.runs[res.id] = { id: res.id, appId, phase: 'Starting', pct: 0, state: 'running', depots, out: out };
  apPaintDl();
  toast(`Downloading ${depots.length} depot${depots.length === 1 ? '' : 's'} to ${out}`, 'check');
}

/** One unlocker mode card each: OST, BST and the opt-out Custom. */
async function apPaintModes() {
  const box = document.getElementById('ap-modes');
  if (!box) return;
  if (!AP.modes) box.innerHTML = `<div class="apx-busy">Looking up the unlocker releases&hellip;</div>`;
  if (!AP.modes) { apLoadModes(); return; }
  if (!window.api.luaSetMode) { box.innerHTML = ''; return; }

  const pill = (s) => ({
    'up-to-date': ['is-on', 'Up to date'],
    'update-available': ['is-warn', 'Update available'],
    'not-installed': ['', 'Not installed'],
    'user-managed': ['is-on', 'Your own'],
    'unknown': ['', 'Unknown']
  }[s] || ['', s || 'Unknown']);

  box.innerHTML = [
    ...(AP.modes.modes || []).map((m) => {
      const [cls, label] = pill(m.status);
      return `<div class="apx-mode${m.active ? ' is-active' : ''}">
        <div class="apx-mode-head">
          <strong>${esc(m.name)}</strong>
          <span class="apx-pill ${cls}">${m.active ? icon('shield', 11) + ' Active' : esc(label)}</span>
        </div>
        <small>${esc(m.description || '')}</small>
        <div class="apx-mode-foot">
          ${m.version ? `<span class="apx-muted">${esc(m.version)}</span>` : ''}
          <span class="apx-actions">
            ${m.id === 'custom' && !m.active
        ? `<button class="ap-btn apx-mini is-primary" data-ap="apx:mode" data-mode="custom">${icon('check', 12)} Use own</button>` : ''}
            ${m.id !== 'custom' && m.status !== 'up-to-date'
        ? `<button class="ap-btn apx-mini is-primary" data-ap="apx:mode" data-mode="${esc(m.id)}">${icon('download', 12)} ${m.status === 'not-installed' ? 'Install' : m.status === 'update-available' ? 'Update' : 'Try install'}</button>` : ''}
            ${m.active && m.id !== 'custom'
        ? `<button class="ap-btn apx-mini" data-ap="apx:cloudred">${icon('zap', 12)} CloudRedirect</button>` : ''}
          </span>
        </div>
      </div>`;
    })
  ].join('');
}

async function apLoadModes() {
  if (!window.api.luaModes) return;
  const res = await window.api.luaModes().catch(() => null);
  AP.modes = res && res.ok ? res : { ok: false, modes: [] };
  apPaintModes();
}

/** Climps one apx:* action per click, with the file / depot from the row. */
async function apxAction(kind, root, btn) {
  const row = btn.closest('.apx-row, .apx-detail, .apx-form');
  const get = (sel) => {
    const el = (row || root).querySelector(sel);
    return (el && el.value || '').trim();
  };
  const file = btn.dataset.file || (row && row.querySelector('[data-file]') || {}).dataset?.file;

  const reapply = async (res) => {
    if (res && res.ok) {
      const name = file;
      const cur = AP.detail[name];
      AP.detail[name] = { ok: true, file: res.file, name, dir: cur && cur.dir, edited: true, ...res };
      apPaintDepots();
      apScanInto().catch(() => {});
      toast('Lua saved (a backup was kept first)', 'check');
    } else toast((res && res.error) || 'The edit did not apply', 'warn');
  };

  if (kind === 'repair-manifests') {
    toast('Fetching pruned manifests\u2026', 'info');
    const res = await window.api.luaRepairManifests().catch((e) => ({ ok: false, error: e.message, repaired: [] }));
    if (res && res.ok) {
      const okN = (res.repaired || []).filter((r) => r.ok).length;
      const badN = (res.repaired || []).filter((r) => !r.ok).length;
      toast(okN
        ? `${okN} manifest${okN === 1 ? '' : 's'} restored${badN ? `, ${badN} failed` : ''} - restart Steam now`
        : badN ? `Could not fetch: ${badN} failed` : 'Every pinned manifest is already cached',
        badN || !okN ? 'warn' : 'check');
    } else toast((res && res.error) || 'Could not repair manifests', 'warn');
    apScanInto();
    return;
  }

  if (kind === 'file') { await apToggleFile(btn.dataset.file); return; }

  if (kind === 'store') {
    window.api.openExternal(`https://store.steampowered.com/app/${btn.dataset.id}/`).catch(() => {});
    return;
  }

  if (kind === 'depot-toggle') {
    const res = await window.api.luaEdit({ file, op: 'enable', depot: btn.dataset.depot }).catch(() => null);
    await reapply(res && res.ok ? Object.assign({ op: 'enable' }, res) : res);
    return;
  }

  if (kind === 'depot-off') {
    const res = await window.api.luaEdit({ file, op: 'disable', depot: btn.dataset.depot }).catch(() => null);
    await reapply(res);
    return;
  }

  if (kind === 'pin') {
    const input = btn.parentElement.querySelector('input');
    const manifest = (input && input.value.trim().replace(/\D/g, '')) || '';
    if (!manifest) { toast('Type the manifest id to pin first', 'warn'); return; }
    const res = await window.api.luaEdit({ file, op: 'setPin', depot: btn.dataset.depot, manifest }).catch(() => null);
    await reapply(res);
    return;
  }

  if (kind === 'pin-lock') {
    // The pin input's value says what to re-write; the switch just locks/unlocks.
    const pin = btn.closest('.apx-pin').querySelector('input').value.trim();
    const d = AP.detail[file];
    const cur = d && d.pins && d.pins.find((p) => p.depot === btn.dataset.depot);
    if (cur && cur.locked) {
      const res = await window.api.luaEdit({ file, op: 'unlock', depot: btn.dataset.depot }).catch(() => null);
      await reapply(res);
      return;
    }
    if (!pin) { toast('Type the manifest id to pin first', 'warn'); return; }
    const res = await window.api.luaEdit({ file, op: 'setPin', depot: btn.dataset.depot, manifest: pin }).catch(() => null);
    await reapply(res);
    return;
  }

  if (kind === 'depot-add') {
    const depot = get('.apx-in-depot').replace(/\D/g, '');
    const key = get('.apx-in-key').replace(/[^\w]/g, '');
    if (!depot) { toast('Type the depot id first', 'warn'); return; }
    const res = await window.api.luaEdit({ file, op: 'addDepot', depot, key: key || null, enabled: true }).catch(() => null);
    await reapply(res);
    return;
  }

  if (kind === 'app-add') {
    const appid = get('.apx-in-appid').replace(/\D/g, '');
    if (!appid) { toast('Type the app id first', 'warn'); return; }
    const res = await window.api.luaEdit({ file, op: 'addApp', appid }).catch(() => null);
    await reapply(res);
    return;
  }

  if (kind === 'token-add') {
    const token = get('.apx-in-token');
    if (!token) { toast('Type the token first', 'warn'); return; }
    const res = await window.api.luaEdit({ file, op: 'addToken', token }).catch(() => null);
    await reapply(res);
    return;
  }

  if (kind === 'dl') {
    const depot = btn.dataset.depot;
    const d = AP.detail[file];
    const pin = (((d || {}).depots || []).find((x) => x.id === depot) || {}).pin;
    const manifest = pin && pin.manifest;
    if (!manifest) {
      toast('Pin that depot to a manifest first \u2014 the CDN needs a version to fetch', 'warn');
      return;
    }
    const appId = (d && d.appId) || (btn.closest('.apx-detail') || {}).dataset?.appid;
    await apDepotDownload(appId, file, [{ depot, manifest }]);
    return;
  }

  if (kind === 'dl-cancel') {
    await window.api.luaDepotCancel(btn.dataset.id).catch(() => {});
    toast('Stopping that download', 'info');
    return;
  }

  if (kind === 'mode') {
    const mode = btn.dataset.mode;
    btn.disabled = true;
    const res = await window.api.luaSetMode({ mode }).catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (res && res.ok) {
      toast(`Mode: ${mode.toUpperCase()} \u2014 ${(res.failed || []).length ? `but ${res.failed.length} file(s) were locked (close Steam and retry)` : 'installed'}`, res.failed && res.failed.length ? 'warn' : 'check');
    } else toast((res && res.error) || 'Could not switch mode', 'warn');
    await apLoadModes();
    return;
  }

  if (kind === 'cloudred') {
    const res = await window.api.luaModeManage().catch((e) => ({ ok: false, error: e.message }));
    toast(res && res.ok ? 'CloudRedirect is starting' : `CloudRedirect: ${(res && res.error) || 'failed'}`, res && res.ok ? 'check' : 'warn');
    return;
  }
}
