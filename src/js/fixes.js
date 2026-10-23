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
let fxTab = 'luatools';       // luatools | bypass | onlinefix | steamless
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
    <h1 class="page-title">${icon('shield', 24)} Apex Tools</h1>
    <div class="page-intro">
      <p>One page for the tools around your library: import an app-id file, read the Steam app id,
      and see every game applied to this Steam account &mdash; read straight out of Steam's
      stplug-in folder. Bypass and OnlineFix list what each title needs and apply a fix you already
      have on disk; SteamLess swaps the Steamworks DLLs inside a game for your own copies. Apex
      stores metadata and tooling and never ships the fix files themselves.</p>
    </div>

    <div class="fx-tabs" role="tablist">
      <button class="fx-tab ${fxTab === 'luatools' ? 'active' : ''}" data-fx-tab="luatools">${icon('file', 15)} Apex Tools</button>
      <button class="fx-tab ${fxTab === 'bypass' ? 'active' : ''}" data-fx-tab="bypass">${icon('shield', 15)} Bypass</button>
      <button class="fx-tab ${fxTab === 'onlinefix' ? 'active' : ''}" data-fx-tab="onlinefix">${icon('globe', 15)} OnlineFix</button>
      <button class="fx-tab ${fxTab === 'steamless' ? 'active' : ''}" data-fx-tab="steamless">${icon('zap', 15)} SteamLess</button>
    </div>

    <div class="fx-catalog-bar ${fxTab === 'luatools' ? 'hidden' : ''}">
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

  if (fxTab === 'luatools') apPaint(document.getElementById('fx-body'));
  else if (fxTab !== 'steamless') fxPaintCatalog();
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
  if (fxTab === 'luatools') {
    const body = document.getElementById('fx-body');
    if (body) apPaint(body);
    return;
  }
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

    // Publishers lead the page the way a storefront's own shelves do: a centred
    // row of marks, then the covers. "All" is the first mark, so the row reads
    // as one choice rather than a filter plus a list. Above the covers sits one
    // wide banner for the first title on the shelf, which is the "what is this
    // page" image the catalogue never carried.
    body.innerHTML = `
      <div class="fx-shelf">
        <div class="fx-pubs" role="group" aria-label="Publishers">
          <button class="fx-pub-card ${fxPublisher === 'ALL' ? 'active' : ''}" data-fx-pub="ALL">
            <span class="fx-pub-mark">${icon('shield', 24)}</span>
            <span class="fx-pub-name">All</span>
          </button>
          ${publishers.map((p) => `<button class="fx-pub-card ${fxPublisher === p ? 'active' : ''}" data-fx-pub="${esc(p)}" title="${esc(p)}">
            ${fxPubMark(p)}
            <span class="fx-pub-name">${esc(fxPubLabel(p))}</span>
          </button>`).join('')}
        </div>
        ${fxBypass && fxBypass.error ? `<div class="lt-note warn">${icon('warning', 15)}<span>${esc(fxBypass.error)}</span></div>` : ''}
        ${fxBypassHero(shown[0])}
        <div class="grid fx-grid fx-grid-cards">
          ${shown.length ? shown.map(fxBypassCard).join('') : `<div class="empty show">${icon('info', 30)}<p>No bypass entry matches that search.</p></div>`}
        </div>
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

/**
 * Two-letter mark for a publisher we have no glyph for: "Rockstar Games" -> RG,
 * "EA" -> EA.
 */
function fxMonogram(name) {
  const words = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Glyph and tint per publisher. The tints are the only borrowed thing here -
 * a colour is a colour - while the glyph is Apex's own silhouette from
 * icons.js, always read together with the name printed under it.
 */
const FX_PUB_MARKS = [
  { re: /rockstar/i, brand: 'rockstarBrand', glyph: 'star', tint: '#f5b21a', label: 'Rockstar' },
  { re: /ubisoft/i, brand: 'ubisoftBrand', glyph: 'ubisoft', tint: '#4d9fff', label: 'Ubisoft' },
  { re: /^ea$|electronic\s*arts/i, brand: 'eaBrand', glyph: 'ea', tint: '#ff3b3b', label: 'EA' },
  { re: /denuvo/i, glyph: 'denuvo', tint: '#35d6a4', label: 'Denuvo' },
  { re: /playstation|sony/i, brand: 'playstationBrand', glyph: 'disc', tint: '#5b8dff', label: 'PlayStation' },
  { re: /nintendo/i, glyph: 'gamepad', tint: '#ff5a5a', label: 'Nintendo' },
  { re: /xbox|microsoft/i, glyph: 'xbox', tint: '#5ec46b', label: 'Xbox' },
  { re: /valve|steam/i, brand: 'steamBrand', glyph: 'steam', tint: '#9fb4c8', label: 'Steam' },
  { re: /epic/i, brand: 'epicBrand', glyph: 'epic', tint: '#cfd3d8', label: 'Epic' },
  { re: /cd\s*projekt|gog/i, brand: 'gogBrand', glyph: 'gog', tint: '#a06bff', label: 'GOG' },
  { re: /others|other|unknown/i, glyph: 'grid', tint: '#9aa3b2', label: 'Others' }
];

/**
 * The short label under the mark. The catalogue's own names are long ("Rockstar
 * Games"), and a tile is 100px wide, so the tile prints the shop name.
 */
function fxPubLabel(publisher) {
  const hit = FX_PUB_MARKS.find((m) => m.re.test(String(publisher || '')));
  return hit && hit.label ? hit.label : publisher;
}

function fxPubMark(publisher) {
  const hit = FX_PUB_MARKS.find((m) => m.re.test(String(publisher || '')));
  if (hit) {
    const art = hit.brand ? brandIcon(hit.brand, 30) : icon(hit.glyph, 26);
    return `<span class="fx-pub-mark" style="--pub:${hit.tint}">${art}</span>`;
  }
  return `<span class="fx-pub-mark fx-pub-letters">${esc(fxMonogram(publisher))}</span>`;
}

/**
 * Steam's own CDN serves the wide art for any app id, and a catalogue entry is
 * a game with an app id. The cards try the 16:9 library hero first, then the
 * header, then the catalogue's own custom image, then the drawn banner.
 */
const FX_STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';

function fxSteamArt(appId) {
  const id = String(appId || '').replace(/[^\d]/g, '');
  if (!id) return {};
  return {
    hero: `${FX_STEAM_CDN}${id}/library_hero.jpg`,
    wide: `${FX_STEAM_CDN}${id}/header.jpg`,
    cover: `${FX_STEAM_CDN}${id}/library_600x900.jpg`
  };
}

/**
 * The wide banner above the shelf: the first title's Steam hero art, with the
 * title, publisher and the same Apply fix action as its card. If the art 404s
 * the gradient underneath is the fallback, and the text still reads.
 */
function fxBypassHero(it) {
  if (!it) return '';
  const steam = fxSteamArt(it.appId);
  const src = it.image || steam.hero || '';
  const alt = steam.wide || '';
  return `<div class="fx-hero" data-fx-info="${esc(it.appId)}" data-fx-kind="bypass">
    ${src ? `<img class="fx-hero-img" src="${esc(src)}"${alt ? ` data-alt="${esc(alt)}"` : ''} alt="" draggable="false">` : ''}
    <div class="fx-hero-scrim"></div>
    <div class="fx-hero-body">
      <span class="fx-hero-kicker">${icon('shield', 13)} Featured</span>
      <h3>${esc(it.name)}</h3>
      <p>${esc(it.publisher || '')}${it.appId ? ` &middot; App ${esc(it.appId)}` : ''}</p>
      <button class="btn primary sm" data-fx-apply="${esc(it.appId)}" data-fx-kind="bypass">${icon('download', 14)} Apply fix</button>
    </div>
  </div>`;
}

function fxBypassCard(it) {
  const steam = fxSteamArt(it.appId);
  const g = {
    id: `bypass:${it.appId}`,
    title: it.name,
    developer: it.publisher,
    genre: 'Bypass',
    banner: it.image || steam.hero || null,
    cover: steam.wide || it.image || null
  };
  return `<article class="card fx-card fx-card-wide" data-fx-info="${esc(it.appId)}" data-fx-kind="bypass" title="Open ${esc(it.name)}">
    <div class="card-art">
      ${art(g, 'banner')}
      <span class="plat plat-lightning fx-origin">${icon('shield', 12)}Bypass</span>
    </div>
    <div class="card-info">
      <h4 title="${esc(it.name)}">${esc(it.name)}</h4>
      <div class="card-dev">${esc(it.publisher)}</div>
      <div class="card-meta"><span>App ${esc(it.appId)}</span></div>
      <div class="actions">
        <button class="btn primary sm" data-fx-apply="${esc(it.appId)}" data-fx-kind="bypass">${icon('download', 14)} Apply fix</button>
      </div>
    </div>
  </article>`;
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
