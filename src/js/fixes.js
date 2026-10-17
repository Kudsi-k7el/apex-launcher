'use strict';

/**
 * Tools view: Project Lightning's Bypass, OnlineFix and SteamLess features.
 *
 *   - Bypass / OnlineFix read the two catalogues shipped with Apex (and
 *     refreshable from the project's GitHub). They are pure metadata: what a
 *     title needs, what error to expect, and where the fix goes.
 *   - "Apply fix" copies a fix the user already has on disk (a source folder,
 *     an archive, or a GitHub URL) onto the game's install folder. Every file
 *     it replaces is backed up first, in the user's Apex data folder.
 *   - SteamLess finds the Steamworks DLLs inside a game and swaps them for the
 *     user's own copies, again with a backup.
 *
 * Apex ships the tooling and the catalogues only; the fix files themselves
 * always come from something the user points it at.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let fxTab = 'bypass';        // bypass | onlinefix | steamless
let fxMeta = null;           // catalogs() summary
let fxBypass = null;         // { items, publishers, total }
let fxOnlinefix = null;      // { items, total }
let fxQuery = '';
let fxPublisher = 'ALL';
let fxBusy = false;

let fxScan = null;           // last steamlessScan result
let fxScanDir = '';

/** The user's remembered folders / choices for these tools. */
function fxSettings() {
  State.settings.pl = State.settings.pl || {};
  return State.settings.pl;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function fxLoadMeta(force) {
  try { fxMeta = await window.api.plCatalogs(force ? { force: true } : undefined); }
  catch { fxMeta = null; }
  return fxMeta;
}

async function fxLoadCatalog(tab) {
  if (tab === 'bypass') {
    let res = null;
    try { res = await window.api.plBypass(fxQuery); } catch { res = null; }
    fxBypass = res && res.ok !== false ? res : { ok: false, items: [], publishers: [], total: 0, error: (res && res.error) };
    return fxBypass;
  }
  if (tab === 'onlinefix') {
    let res = null;
    try { res = await window.api.plOnlinefix(fxQuery); } catch { res = null; }
    fxOnlinefix = res && res.ok !== false ? res : { ok: false, items: [], total: 0, error: (res && res.error) };
    return fxOnlinefix;
  }
  return null;
}

const fxActiveItems = () => (fxTab === 'bypass' ? (fxBypass && fxBypass.items) : (fxOnlinefix && fxOnlinefix.items)) || [];

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
function renderFixes(el) {
  clearInterval(slideTimer);

  const pl = fxSettings();

  el.innerHTML = `
    <h1 class="page-title">${icon('shield', 24)} Tools</h1>
    <div class="page-intro">
      <p>Fix and tooling helpers ported from Project Lightning. Bypass and OnlineFix list what each
      title needs and apply a fix you already have on disk; SteamLess swaps the Steamworks DLLs
      inside a game for your own copies. Apex stores the catalogue metadata and the tooling &mdash;
      it never ships the fix files themselves, and it backs up everything it replaces.</p>
    </div>

    <div class="fx-tabs" role="tablist">
      <button class="fx-tab ${fxTab === 'bypass' ? 'active' : ''}" data-fx-tab="bypass">${icon('shield', 15)} Bypass</button>
      <button class="fx-tab ${fxTab === 'onlinefix' ? 'active' : ''}" data-fx-tab="onlinefix">${icon('globe', 15)} OnlineFix</button>
      <button class="fx-tab ${fxTab === 'steamless' ? 'active' : ''}" data-fx-tab="steamless">${icon('zap', 15)} SteamLess</button>
    </div>

    <div class="fx-catalog-bar">
      <div class="search-box">
        ${icon('search', 16)}
        <input id="fx-search" type="search" placeholder="Search the ${esc(fxTab === 'onlinefix' ? 'OnlineFix' : 'Bypass')} catalogue…" value="${esc(fxQuery)}" spellcheck="false" autocomplete="off">
      </div>
      <div class="toolbar-right">
        <span class="fx-count" id="fx-count"></span>
        <button class="btn secondary sm" id="fx-refresh">${icon('refresh', 15)} Refresh from GitHub</button>
      </div>
    </div>

    <div class="lt-status" id="fx-status"></div>
    <div id="fx-body"></div>`;

  hydrateIcons(el);

  const input = el.querySelector('#fx-search');
  if (input) {
    let timer = null;
    input.addEventListener('input', () => {
      fxQuery = input.value;
      clearTimeout(timer);
      timer = setTimeout(async () => { await fxLoadCatalog(fxTab); fxPaintBody(); }, 300);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); fxLoadCatalog(fxTab).then(fxPaintBody); }
    });
  }

  const refresh = el.querySelector('#fx-refresh');
  if (refresh) refresh.addEventListener('click', () => fxRefreshCatalog(refresh));

  if (fxTab !== 'steamless') fxPaintCatalog();
  else fxPaintSteamless();
}

function fxSetStatus(kind, text) {
  const el = document.getElementById('fx-status');
  if (!el) return;
  if (!text) { el.className = 'lt-status'; el.innerHTML = ''; return; }
  el.className = `lt-status ${kind}`;
  el.innerHTML = `${icon(kind === 'loading' ? 'refresh' : kind === 'error' ? 'warning' : 'info', 15)}<span>${esc(text)}</span>`;
}

async function fxRefreshCatalog(btn) {
  if (fxBusy) return;
  fxBusy = true;
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh', 15)} Refreshing…`;
  fxSetStatus('loading', 'Downloading the latest Bypass and OnlineFix catalogues from GitHub…');

  let res = null;
  try { res = await window.api.plRefresh(); } catch { res = null; }

  btn.disabled = false;
  btn.innerHTML = prev;
  fxBusy = false;

  if (!res || res.ok === false) {
    const detail = res && Array.isArray(res.results)
      ? res.results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`).join('; ')
      : (res && res.error) || 'unknown error';
    fxSetStatus('error', `Refresh failed — ${detail}`);
    return;
  }

  await fxLoadMeta();
  await fxLoadCatalog(fxTab);
  fxPaintBody();
  fxSetStatus('info', `Catalogues refreshed from GitHub — ${res.counts.bypass} bypass, ${res.counts.onlinefix} OnlineFix entries.`);
}

// ---------------------------------------------------------------------------
// Catalogue body (Bypass / OnlineFix)
// ---------------------------------------------------------------------------
function fxPaintBody() {
  if (fxTab === 'steamless') { fxPaintSteamless(); return; }
  fxPaintCatalog();
}

async function fxPaintCatalog() {
  const body = document.getElementById('fx-body');
  if (!body) return;

  await fxLoadMeta();

  const count = document.getElementById('fx-count');
  const input = document.getElementById('fx-search');
  if (input) {
    input.placeholder = `Search the ${fxTab === 'onlinefix' ? 'OnlineFix' : 'Bypass'} catalogue…`;
    if (input.value !== fxQuery) input.value = fxQuery;
  }
  const refresh = document.getElementById('fx-refresh');
  if (refresh && !refresh.disabled) { /* keep its label stable */ }

  await fxLoadCatalog(fxTab);

  if (fxTab === 'bypass') {
    const publishers = (fxBypass && fxBypass.publishers) || [];
    const items = fxBypass && fxBypass.items ? fxBypass.items : [];
    const shown = fxPublisher === 'ALL' ? items : items.filter((it) => it.publisher === fxPublisher);
    if (count) count.textContent = `${shown.length} of ${(fxBypass && fxBypass.total) || 0}`;

    body.innerHTML = `
      <div class="fx-chips">
        <button class="fx-chip ${fxPublisher === 'ALL' ? 'active' : ''}" data-fx-pub="ALL">All publishers</button>
        ${publishers.map((p) => `<button class="fx-chip ${fxPublisher === p ? 'active' : ''}" data-fx-pub="${esc(p)}">${esc(p)}</button>`).join('')}
      </div>
      ${fxBypass && fxBypass.error ? `<div class="lt-note warn">${icon('warning', 15)}<span>${esc(fxBypass.error)}</span></div>` : ''}
      <div class="fx-list">
        ${shown.length ? shown.map(fxBypassRow).join('') : `<div class="empty show">${icon('info', 30)}<p>No bypass entry matches that search.</p></div>`}
      </div>`;
    return;
  }

  const items = fxOnlinefix && fxOnlinefix.items ? fxOnlinefix.items : [];
  if (count) count.textContent = `${items.length} of ${(fxOnlinefix && fxOnlinefix.total) || 0}`;
  body.innerHTML = `
    ${fxOnlinefix && fxOnlinefix.error ? `<div class="lt-note warn">${icon('warning', 15)}<span>${esc(fxOnlinefix.error)}</span></div>` : ''}
    <div class="grid fx-grid">
      ${items.length ? items.map(fxOnlinefixCard).join('') : `<div class="empty show">${icon('info', 30)}<p>No OnlineFix entry matches that search.</p></div>`}
    </div>`;
}

function fxBypassRow(it) {
  return `<div class="fx-row" data-fx-item="${esc(it.appId)}" data-fx-kind="bypass">
    <div class="fx-row-main">
      <div class="fx-row-title">
        <strong>${esc(it.name)}</strong>
        <span class="fx-appid">App ${esc(it.appId)}</span>
        <span class="fx-pub">${esc(it.publisher)}</span>
      </div>
      ${it.comments ? `<div class="fx-comment">${icon('messageSquare', 13)} ${esc(it.comments)}</div>` : ''}
      ${(it.required || []).length ? `<div class="fx-chips small">${it.required.map((r) => `<span class="fx-req">${icon('box', 12)} ${esc(r)}</span>`).join('')}</div>` : ''}
      ${(it.errors || []).length ? `<div class="fx-errors">${icon('warning', 13)} ${esc(it.errors[0])}${it.errors.length > 1 ? ` <span class="fx-more">+${it.errors.length - 1} more</span>` : ''}</div>` : ''}
    </div>
    <div class="fx-row-actions">
      <span class="fx-launch">${it.launchSteam ? `<span class="fx-tag">${icon('gamepad', 12)} Steam</span>` : ''}${it.launchExe ? `<span class="fx-tag">${icon('cpu', 12)} EXE</span>` : ''}</span>
      <button class="btn primary sm" data-fx-apply="${esc(it.appId)}" data-fx-kind="bypass">${icon('download', 14)} Apply fix</button>
      <button class="btn secondary sm icon-only" data-fx-info="${esc(it.appId)}" data-fx-kind="bypass" title="Details">${icon('info', 15)}</button>
    </div>
  </div>`;
}

function fxOnlinefixCard(it) {
  const g = {
    id: `onlinefix:${it.appId}`,
    title: it.name,
    developer: it.fixName,
    genre: 'OnlineFix',
    cover: it.image || null
  };
  return `<article class="card fx-card" data-fx-info="${esc(it.appId)}" data-fx-kind="onlinefix" title="Open ${esc(it.name)}">
    <div class="card-art">
      ${art(g, 'cover')}
      <span class="plat plat-lightning fx-origin">${icon('globe', 12)}OnlineFix</span>
    </div>
    <div class="card-info">
      <h4 title="${esc(it.name)}">${esc(it.name)}</h4>
      <div class="card-dev">${esc(it.fixName)}</div>
      <div class="card-meta"><span>App ${esc(it.appId)}</span></div>
      <div class="actions">
        <button class="btn primary sm" data-fx-apply="${esc(it.appId)}" data-fx-kind="onlinefix">${icon('download', 14)} Apply fix</button>
      </div>
    </div>
  </article>`;
}

function fxFindItem(appId, kind) {
  const list = kind === 'onlinefix' ? (fxOnlinefix && fxOnlinefix.items) : (fxBypass && fxBypass.items);
  return (list || []).find((x) => String(x.appId) === String(appId)) || null;
}

// ---------------------------------------------------------------------------
// Info dialog
// ---------------------------------------------------------------------------
function fxOpenInfo(item, kind) {
  if (!item) return;
  const rows = [];
  rows.push(`<div class="fx-info-row"><span>Title</span><b>${esc(item.name)}</b></div>`);
  rows.push(`<div class="fx-info-row"><span>App ID</span><b>${esc(item.appId)}</b></div>`);
  if (kind === 'bypass') {
    rows.push(`<div class="fx-info-row"><span>Publisher</span><b>${esc(item.publisher)}</b></div>`);
    rows.push(`<div class="fx-info-row"><span>Launch</span><b>${[item.launchSteam ? 'Steam' : null, item.launchExe ? 'EXE' : null].filter(Boolean).join(' · ') || '—'}</b></div>`);
  }
  rows.push(`<div class="fx-info-row"><span>Fix name</span><b>${esc(item.fixName)}</b></div>`);

  const body = `
    <div class="fx-info">
      ${item.image ? `<div class="fx-info-art"><img src="${esc(item.image)}" alt="" loading="lazy" draggable="false"></div>` : ''}
      ${rows.join('')}
      ${item.comments ? `<p class="fx-info-note">${icon('messageSquare', 14)} ${esc(item.comments)}</p>` : ''}
      ${(item.required || []).length ? `
        <h4 class="modal-sub">${icon('box', 15)} Required programs</h4>
        <div class="fx-chips small">${item.required.map((r) => `<span class="fx-req">${esc(r)}</span>`).join('')}</div>` : ''}
      ${(item.errors || []).length ? `
        <h4 class="modal-sub">${icon('warning', 15)} Known errors &amp; notes</h4>
        <ul class="fx-info-errors">${item.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      <p class="fx-info-foot">Apex stores the catalogue metadata only. The fix files come from the folder or URL you choose when you apply it.</p>
    </div>`;

  openModal({
    title: `${item.name} · ${kind === 'onlinefix' ? 'OnlineFix' : 'Bypass'}`,
    ico: kind === 'onlinefix' ? 'globe' : 'shield',
    body,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Close</button>
      <button class="btn primary glow" data-fx-apply="${esc(item.appId)}" data-fx-kind="${kind}">${icon('download', 15)} Apply fix</button>`
  });
}

// ---------------------------------------------------------------------------
// Apply-fix dialog
// ---------------------------------------------------------------------------
function fxOpenApplyDialog(item, kind) {
  if (!item) return;
  const pl = fxSettings();
  const dest = pl.lastGameFolder || State.settings.installPath || '';
  const source = pl.fixSource || '';

  const body = `
    <div class="fx-apply">
      <p class="fx-apply-lead">Applying <b>${esc(item.fixName)}</b> to a game folder. Apex backs up
      every file it replaces into your Apex data folder, so this is reversible.</p>

      <label class="field wide"><span>Game folder *</span>
        <div class="field-row">
          <input id="fx-dest" type="text" placeholder="The installed game's folder" value="${esc(dest)}" spellcheck="false">
          <button class="btn secondary" id="fx-dest-pick">${icon('folder', 15)} Browse…</button>
        </div>
      </label>

      <label class="field wide"><span>Fix source folder</span>
        <div class="field-row">
          <input id="fx-src" type="text" placeholder="A folder you prepared with the fix files" value="${esc(source)}" spellcheck="false">
          <button class="btn secondary" id="fx-src-pick">${icon('folder', 15)} Browse…</button>
        </div>
      </label>

      <label class="field wide"><span>Fix URL(s) <small>(optional, GitHub only)</small></span>
        <textarea id="fx-urls" rows="3" spellcheck="false" placeholder="https://github.com/…/fix.zip&#10;One URL per line"></textarea>
      </label>

      <div class="fx-apply-opts">
        <label class="fx-check"><input type="checkbox" id="fx-extract" checked> Extract archives automatically</label>
        <label class="fx-check"><input type="checkbox" id="fx-backup" checked> Back up replaced files</label>
      </div>

      <div class="fx-result" id="fx-result"></div>
    </div>`;

  openModal({
    title: `Apply fix · ${item.name}`,
    ico: 'download',
    body,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>
      <button class="btn primary glow" id="fx-apply-go">${icon('download', 15)} Apply fix</button>`,
    onMount(el) {
      el.querySelector('#fx-dest-pick').addEventListener('click', async () => {
        const picked = await window.api.pickFolder(el.querySelector('#fx-dest').value || undefined);
        if (picked) el.querySelector('#fx-dest').value = picked;
      });
      el.querySelector('#fx-src-pick').addEventListener('click', async () => {
        const picked = await window.api.pickFolder(el.querySelector('#fx-src').value || pl.fixSource || undefined);
        if (picked) el.querySelector('#fx-src').value = picked;
      });

      el.querySelector('#fx-apply-go').addEventListener('click', () => fxApplyFix(el, item, kind));
    }
  });
}

async function fxApplyFix(el, item, kind) {
  const btn = el.querySelector('#fx-apply-go');
  const result = el.querySelector('#fx-result');

  const dest = el.querySelector('#fx-dest').value.trim();
  const sourceDir = el.querySelector('#fx-src').value.trim();
  const urls = el.querySelector('#fx-urls').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const extract = el.querySelector('#fx-extract').checked;
  const backup = el.querySelector('#fx-backup').checked;

  if (!dest) { toast('Choose the game folder first', 'warn'); return; }
  if (!sourceDir && !urls.length) { toast('Add a fix source folder or at least one URL', 'warn'); return; }

  // Remember the choices for next time.
  const pl = fxSettings();
  pl.lastGameFolder = dest;
  if (sourceDir) pl.fixSource = sourceDir;
  persist();

  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh', 15)} Applying…`;
  if (result) result.innerHTML = `<div class="lt-note">${icon('refresh', 15)}<span>Copying the fix and backing up what it replaces…</span></div>`;

  let res = null;
  try { res = await window.api.plApplyFix({ appId: item.appId, name: item.name, dest, sourceDir, urls, extract, backup }); }
  catch { res = null; }

  btn.disabled = false;
  btn.innerHTML = prev;

  if (!res || res.ok === false) {
    const msg = (res && res.error) || 'The fix could not be applied.';
    if (result) result.innerHTML = `<div class="lt-note warn">${icon('warning', 15)}<span>${esc(msg)}</span></div>`;
    toast(msg, 'warn');
    return;
  }

  if (result) {
    result.innerHTML = `
      <div class="fx-result-ok">${icon('checkCircle', 18)}<div>
        <strong>${res.applied.length} file${res.applied.length === 1 ? '' : 's'} written</strong>
        <small>${res.backedUp.length ? `${res.backedUp.length} replaced file(s) backed up` : 'Nothing needed backing up'}${res.downloaded.length ? ` · ${res.downloaded.length} downloaded` : ''}</small>
        ${res.backupDir ? `<code>${esc(res.backupDir)}</code>` : ''}
        ${res.errors && res.errors.length ? `<ul class="fx-info-errors">${res.errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      </div></div>`;
  }
  toast(`${item.name}: fix applied (${res.applied.length} file${res.applied.length === 1 ? '' : 's'})`, 'check');
}

// ---------------------------------------------------------------------------
// SteamLess
// ---------------------------------------------------------------------------
function fxPaintSteamless() {
  const body = document.getElementById('fx-body');
  if (!body) return;
  const count = document.getElementById('fx-count');
  if (count) count.textContent = '';
  fxSetStatus('', '');

  const input = document.getElementById('fx-search');
  if (input) input.placeholder = 'Search is for the catalogues — not used here';
  const bar = document.querySelector('#content .fx-catalog-bar');
  if (bar) bar.classList.add('hidden');

  const pl = fxSettings();
  const dlls = (fxScan && fxScan.items) || [];

  body.innerHTML = `
    <section class="panel fx-sl">
      <h3>${icon('zap', 18)} SteamLess — Steamworks DLL swap</h3>
      <p class="panel-note">Point Apex at a game folder; it finds the Steamworks libraries
      (<code>steam_api.dll</code> / <code>steam_api64.dll</code>) inside it. Then choose a folder holding your
      replacement DLLs and Apex swaps them in, keeping a backup of the originals. Use a tool such as
      SteamLess or the game's own untouched DLLs &mdash; Apex never ships them itself.</p>

      <div class="setting-row">
        <div class="s-ico">${icon('folder', 20)}</div>
        <div class="s-text"><h4>Game folder to scan</h4>
          <code id="fx-sl-dir">${esc(fxScanDir || 'No folder selected')}</code></div>
        <div class="about-actions">
          <button class="btn secondary" id="fx-sl-pick">${icon('folder', 15)} Choose folder</button>
          <button class="btn primary" id="fx-sl-scan" ${fxScanDir ? '' : 'disabled'}>${icon('search', 15)} Scan</button>
        </div>
      </div>

      <div id="fx-sl-results">
        ${fxScan ? fxSlResults(dlls) : `<div class="fx-note">${icon('info', 15)}<span>Scan a game folder to list its Steamworks DLLs.</span></div>`}
      </div>

      ${fxScan && dlls.length ? `
      <div class="setting-row">
        <div class="s-ico">${icon('box', 20)}</div>
        <div class="s-text"><h4>Replacement DLL folder</h4>
          <p>Must contain <code>steam_api.dll</code> and/or <code>steam_api64.dll</code>. Each scanned file is matched by name.</p>
          <code id="fx-sl-src">${esc(pl.steamlessSource || 'No folder selected')}</code></div>
        <div class="about-actions">
          <button class="btn secondary" id="fx-sl-src-pick">${icon('folder', 15)} Choose folder</button>
          <button class="btn primary glow" id="fx-sl-replace">${icon('zap', 15)} Replace DLLs</button>
        </div>
      </div>
      <div class="lt-status" id="fx-sl-status"></div>` : ''}
    </section>

    <section class="panel">
      <h3>${icon('info', 18)} How it works</h3>
      <div class="fx-steps">
        <div class="fx-step"><span>1</span><div><b>Choose the game folder</b><small>The folder that holds the game's <code>.exe</code>.</small></div></div>
        <div class="fx-step"><span>2</span><div><b>Scan for Steamworks DLLs</b><small>Apex lists every <code>steam_api</code> library it finds, with a hash.</small></div></div>
        <div class="fx-step"><span>3</span><div><b>Choose your replacement DLLs</b><small>From a folder you prepared. Matched by filename.</small></div></div>
        <div class="fx-step"><span>4</span><div><b>Replace &amp; back up</b><small>The originals are copied into your Apex data folder first.</small></div></div>
      </div>
    </section>`;

  hydrateIcons(body);
  fxWireSteamless(body, dlls);
}

function fxSlResults(dlls) {
  if (!dlls.length) {
    return `<div class="fx-note">${icon('checkCircle', 15)}<span>No <code>steam_api</code> DLL found in that folder. Nothing to swap.</span></div>`;
  }
  return `
    <h4 class="modal-sub">${icon('hardDrive', 15)} Found ${dlls.length} Steamworks DLL${dlls.length === 1 ? '' : 's'}</h4>
    <div class="fx-dll-list">
      ${dlls.map((d, i) => `<label class="fx-dll">
        <input type="checkbox" data-fx-dll="${i}" checked>
        <div class="fx-dll-text">
          <b>${esc(d.relative || d.path)}</b>
          <small>${fmtSize((d.size || 0) / 1073741824)} · ${esc((d.sha256 || '').slice(0, 16) || 'no hash')}…</small>
        </div>
      </label>`).join('')}
    </div>`;
}

function fxWireSteamless(body, dlls) {
  const pick = body.querySelector('#fx-sl-pick');
  if (pick) pick.addEventListener('click', async () => {
    const picked = await window.api.pickFolder(fxScanDir || fxSettings().lastGameFolder || undefined);
    if (!picked) return;
    fxScanDir = picked;
    fxSettings().lastGameFolder = picked;
    persist();
    fxPaintSteamless();
  });

  const scan = body.querySelector('#fx-sl-scan');
  if (scan) scan.addEventListener('click', async () => {
    if (!fxScanDir) { toast('Choose a game folder first', 'warn'); return; }
    const prev = scan.innerHTML;
    scan.disabled = true;
    scan.innerHTML = `${icon('refresh', 15)} Scanning…`;
    let res = null;
    try { res = await window.api.plSteamlessScan({ dir: fxScanDir }); } catch { res = null; }
    scan.disabled = false;
    scan.innerHTML = prev;

    if (!res || res.ok === false) { toast((res && res.error) || 'Scan failed', 'warn'); return; }
    fxScan = res;
    fxPaintSteamless();
    if (!(res.items || []).length) toast('No Steamworks DLLs found', 'info');
    else toast(`Found ${res.items.length} Steamworks DLL${res.items.length === 1 ? '' : 's'}`, 'check');
  });

  const srcPick = body.querySelector('#fx-sl-src-pick');
  if (srcPick) srcPick.addEventListener('click', async () => {
    const picked = await window.api.pickFolder(fxSettings().steamlessSource || undefined);
    if (!picked) return;
    fxSettings().steamlessSource = picked;
    persist();
    const code = document.getElementById('fx-sl-src');
    if (code) code.textContent = picked;
  });

  const replace = body.querySelector('#fx-sl-replace');
  if (replace) replace.addEventListener('click', async () => {
    const sourceDir = fxSettings().steamlessSource || '';
    if (!sourceDir) { toast('Choose the replacement DLL folder first', 'warn'); return; }

    const targets = [...body.querySelectorAll('[data-fx-dll]')]
      .filter((cb) => cb.checked)
      .map((cb) => (dlls[+cb.dataset.fxDll] || {}).path)
      .filter(Boolean);
    if (!targets.length) { toast('Select at least one DLL to replace', 'warn'); return; }

    const status = document.getElementById('fx-sl-status');
    const prev = replace.innerHTML;
    replace.disabled = true;
    replace.innerHTML = `${icon('refresh', 15)} Replacing…`;

    let res = null;
    try { res = await window.api.plSteamlessReplace({ targets, sourceDir, backup: true }); } catch { res = null; }

    replace.disabled = false;
    replace.innerHTML = prev;

    if (!res || res.ok === false) {
      const msg = (res && res.error) || 'The DLLs could not be replaced.';
      if (status) { status.className = 'lt-status error'; status.innerHTML = `${icon('warning', 15)}<span>${esc(msg)}</span>`; }
      toast(msg, 'warn');
      return;
    }

    if (status) {
      status.className = 'lt-status';
      status.innerHTML = `${icon('checkCircle', 15)}<span>${res.replaced.length} DLL${res.replaced.length === 1 ? '' : 's'} replaced${res.errors.length ? ` · ${res.errors.length} failed` : ''}.</span>`;
    }
    toast(`${res.replaced.length} DLL${res.replaced.length === 1 ? '' : 's'} replaced`, 'check');

    // Re-scan so the hashes on screen reflect the new files.
    try {
      const again = await window.api.plSteamlessScan({ dir: fxScanDir });
      if (again && again.ok) { fxScan = again; fxPaintSteamless(); }
    } catch { /* keep the current list */ }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;

  const tab = t.closest('[data-fx-tab]');
  if (tab) {
    fxTab = tab.dataset.fxTab;
    fxQuery = '';
    fxPublisher = 'ALL';
    if (typeof current !== 'undefined' && current === 'tools') render(false);
    return;
  }

  const pub = t.closest('[data-fx-pub]');
  if (pub) {
    fxPublisher = pub.dataset.fxPub;
    const bar = document.querySelector('#content .fx-catalog-bar');
    if (bar) bar.classList.remove('hidden');
    fxPaintCatalog();
    return;
  }

  const apply = t.closest('[data-fx-apply]');
  if (apply) {
    const item = fxFindItem(apply.dataset.fxApply, apply.dataset.fxKind);
    if (item) { const wasModal = !!apply.closest('.modal-backdrop'); fxOpenApplyDialog(item, apply.dataset.fxKind); void wasModal; }
    return;
  }

  const info = t.closest('[data-fx-info]');
  if (info) {
    const item = fxFindItem(info.dataset.fxInfo, info.dataset.fxKind);
    if (item) fxOpenInfo(item, info.dataset.fxKind);
    return;
  }
});
