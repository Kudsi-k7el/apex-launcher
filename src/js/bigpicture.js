'use strict';

/**
 * Big Picture mode.
 * ---------------------------------------------------------------------------
 * A 10-foot, controller-first view of the whole launcher for a TV or a sofa.
 *
 * The pattern is the one every console and set-top interface shares: one
 * full-screen layer, a horizontal bar of sections, a hero panel for whatever is
 * currently selected, a long shelf of oversized tiles underneath, and a
 * permanent legend along the bottom that names the button for each verb. The
 * mouse still works; the d-pad just works better.
 *
 * The layout, the palette, the wording and the sounds are all Apex's own — the
 * audio is synthesised at runtime by sfx.js, so nothing is borrowed or shipped
 * from anywhere else.
 *
 * Focus and selection are deliberately separate: the ring can walk onto a tile
 * (moving the hero with it, see BP.followFocus) while the store view underneath
 * is untouched, so leaving Big Picture drops the user exactly where they were.
 */

const BP_TABS = [
  { key: 'library', label: 'Library', ico: 'library' },
  { key: 'store', label: 'Store', ico: 'store' },
  { key: 'itch', label: 'itch.io', ico: 'flame' },
  { key: 'nexus', label: 'Nexus', ico: 'zap' },
  { key: 'downloads', label: 'Downloads', ico: 'download' },
  { key: 'news', label: 'News', ico: 'news' }
];

const BP = {
  openFlag: false,
  tab: 'library',
  entries: [],
  index: 0,
  fs: false,
  weFullscreened: false,
  clockTimer: null,
  refreshTimer: null,
  nexusTimer: null,
  searchQuery: '',
  // Live storefront results for the shelf search box: the Store section asks
  // Steam, the itch.io section asks itch.io (exactly like the desktop views).
  liveSteam: [],
  liveItch: [],
  liveBusy: { steam: false, itch: false },
  liveError: { steam: null, itch: null },
  liveFor: '',
  liveTimer: null,

  isOpen: () => BP.openFlag
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const bpRoot = () => document.getElementById('bigpic');

function bpDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "12 items" / "1 item" / nothing at all. */
function bpCount(n) {
  if (!n) return '';
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

/** The section's contents, as a uniform list of entries every renderer understands. */
function bpEntries(tab) {
  let out = [];

  if (tab === 'news') {
    out = (State.news.items || []).map((n, i) => ({ kind: 'news', key: `n${i}`, news: n }));
  } else if (tab === 'downloads') {
    for (const id of Object.keys(DL)) out.push({ kind: 'download', key: `a${id}`, id, dl: DL[id], live: true });
    for (const h of HISTORY) out.push({ kind: 'download', key: `h${h.id}${h.at}`, id: h.id, hist: h });
  } else if (tab === 'itch') {
    // This section is the itch.io *catalogue*, not the user's library. An
    // installed itch.io title moves into the Library like every other game, so
    // it is deliberately not repeated here. What is listed is the itch.io
    // catalogue the itch view has already loaded (feeds / browse / search).
    const seen = new Set();
    const cat = (typeof itchItems !== 'undefined' && Array.isArray(itchItems)) ? itchItems : [];
    for (const it of cat) {
      if (!it || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ kind: 'itch', key: it.id, id: it.id, it, game: itchAsGame(it) });
    }
  } else if (tab === 'nexus') {
    // The Nexus catalogue, exactly as the Nexus view loaded it. Installed titles
    // are deliberately not filtered out: the hero offers "Open" for those, and
    // hiding them would make the shelf jump around after an install.
    const seen = new Set();
    const cat = (typeof ltItems !== 'undefined' && Array.isArray(ltItems)) ? ltItems : [];
    for (const it of cat) {
      if (!it || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ kind: 'nexus', key: it.id, id: it.id, it, game: ltAsGame(it) });
    }
  } else {
    const games = tab === 'store' ? storeGames() : [...installedGames(), ...preorderedGames()];
    const seen = new Set();
    for (const g of games) {
      if (!g || seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ kind: 'game', key: g.id, id: g.id, game: g });
    }
  }

  const q = (BP.searchQuery || '').trim().toLowerCase();
  if (q) {
    out = out.filter((e) => {
      const g = e.game || (e.id && byId(e.id));
      const title = (g && g.title) || (e.news && e.news.title) || '';
      return String(title).toLowerCase().includes(q);
    });
  }

  // Live storefront matches, appended after the local ones and de-duplicated.
  // Store searches the Steam storefront; itch.io searches itch.io. The other
  // sections (Library, Downloads, News) stay purely local.
  if (q.length >= 2) {
    if (tab === 'store') out = out.concat(bpLiveEntries('steam', out));
    else if (tab === 'itch') out = out.concat(bpLiveEntries('itch', out));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Live storefront search (mirrors the Store and itch.io views)
// ---------------------------------------------------------------------------
/** A live Steam result, shaped like a game so the tiles and hero can draw it. */
function bpSteamGame(it) {
  return {
    id: `live:${it.appId}`,
    title: it.name,
    price: it.priceLabel || '',
    steamAppId: it.appId,
    tinyImage: it.tinyImage || null,
    live: true
  };
}

function bpResetLive() {
  clearTimeout(BP.liveTimer);
  BP.liveSteam = [];
  BP.liveItch = [];
  BP.liveBusy = { steam: false, itch: false };
  BP.liveError = { steam: null, itch: null };
  BP.liveFor = '';
}

/** Live results as shelf entries, skipping anything the local list already has. */
function bpLiveEntries(source, existing) {
  if (BP.liveBusy[source] || BP.liveError[source]) return [];

  if (source === 'steam') {
    const seen = new Set(existing
      .map((e) => (e.game && e.game.steamAppId) ? String(e.game.steamAppId) : '')
      .filter(Boolean));
    const out = [];
    for (const it of BP.liveSteam) {
      const app = String(it.appId || '');
      if (!app || seen.has(app)) continue;
      seen.add(app);
      out.push({ kind: 'steam', key: `s${app}`, id: `live:${app}`, it, game: bpSteamGame(it) });
    }
    return out;
  }

  const seen = new Set(existing.map((e) => e.id).filter(Boolean));
  const out = [];
  for (const it of BP.liveItch) {
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push({ kind: 'itch', key: `i${it.id}`, id: it.id, it, game: itchAsGame(it) });
  }
  return out;
}

/** Debounced: fires the matching storefront once typing settles. */
function bpQueueLive() {
  clearTimeout(BP.liveTimer);

  // Nexus searches its own catalogue endpoint rather than a storefront API, so
  // it reuses the Nexus view's loader instead of the live* result slots.
  if (BP.tab === 'nexus') {
    if (typeof ltLoad !== 'function') return;
    clearTimeout(BP.nexusTimer);
    const want = (BP.searchQuery || '').trim();
    BP.nexusTimer = setTimeout(() => {
      Promise.resolve(ltLoad(want)).then(() => {
        if (!BP.isOpen() || BP.tab !== 'nexus') return;
        if ((BP.searchQuery || '').trim() !== want) return;
        bpBuild();
        BP.focusTile();
      }).catch(() => { /* the shelf explains there is nothing to show */ });
    }, 420);
    return;
  }

  const q = (BP.searchQuery || '').trim();
  const source = BP.tab === 'store' ? 'steam' : BP.tab === 'itch' ? 'itch' : null;
  if (!source || q.length < 2) { bpResetLive(); return; }

  BP.liveFor = `${source}:${q}`;
  BP.liveError[source] = null;
  BP.liveBusy[source] = true;
  BP.liveTimer = setTimeout(() => bpRunLive(source, q), 340);
}

async function bpRunLive(source, q) {
  let res = null;
  try {
    res = source === 'steam' ? await window.api.storeSearch(q) : await window.api.itchSearch(q);
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }

  // A newer keystroke has already superseded this request.
  if (BP.liveFor !== `${source}:${q}`) return;

  BP.liveBusy[source] = false;
  if (res && res.ok) {
    if (source === 'steam') { BP.liveSteam = res.items || []; BP.liveError.steam = null; }
    else { BP.liveItch = res.items || []; BP.liveError.itch = null; }
  } else {
    const msg = (res && res.error) || 'Search failed';
    if (source === 'steam') { BP.liveSteam = []; BP.liveError.steam = msg; }
    else { BP.liveItch = []; BP.liveError.itch = msg; }
  }

  if (BP.isOpen()) { bpBuild(); BP.focusTile(); }
}

// ---------------------------------------------------------------------------
// Chrome: sections, clock, status
// ---------------------------------------------------------------------------
function bpRenderTabs() {
  const wrap = document.getElementById('bp-tabs');
  if (!wrap) return;
  wrap.innerHTML = BP_TABS.map((t) => {
    const on = t.key === BP.tab;
    const badge = t.key === 'downloads' && Object.keys(DL).length
      ? `<em class="bp-tab-badge">${Object.keys(DL).length}</em>` : '';
    return `<button class="bp-tab${on ? ' on' : ''}" data-bp="tab" data-tab="${t.key}">
      ${icon(t.ico, 17)}<span>${esc(t.label)}</span>${badge}</button>`;
  }).join('');
}

function bpRenderStatus() {
  const clock = document.getElementById('bp-clock');
  if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const sound = document.getElementById('bp-sound');
  if (sound) {
    const muted = SFX.isMuted();
    sound.innerHTML = icon(muted ? 'volumeOff' : 'volume', 18);
    sound.classList.toggle('off', muted);
    sound.title = muted ? 'UI sounds are off \u00b7 press X / Square' : 'UI sounds are on \u00b7 press X / Square';
  }

  const fs = document.getElementById('bp-fs');
  if (fs) {
    fs.innerHTML = icon(BP.fs ? 'fullscreenExit' : 'fullscreen', 18);
    fs.title = BP.fs ? 'Leave full screen (F11)' : 'Full screen (F11)';
  }

  const pad = document.getElementById('bp-pad');
  if (pad) {
    const rec = (typeof GP !== 'undefined') ? GP.first() : null;
    pad.innerHTML = rec ? icon(rec.glyph, 18) : icon('gamepad', 18);
    pad.classList.toggle('on', !!rec);
    pad.title = rec ? `${rec.name} \u00b7 ${rec.label}` : 'No controller detected';
  }
}

/** The bottom legend. Keyboard names when there is no pad, pad names when there is. */
function bpRenderFoot() {
  const foot = document.getElementById('bp-foot');
  if (!foot) return;

  const rec = (typeof GP !== 'undefined') ? GP.first() : null;
  const items = [];

  if (rec) {
    items.push([rec.a, 'Select']);
    items.push([rec.b, 'Back']);
    items.push(['\u25C0\u25B6', 'Browse']);
    items.push(['LB/RB', 'Section']);
    items.push([rec.x, 'Sound']);
    items.push([rec.menu, 'Menu']);
  } else {
    items.push(['Enter', 'Select']);
    items.push(['\u2190\u2192', 'Browse']);
    items.push(['Tab', 'Section']);
    items.push(['X', 'Sound']);
    items.push(['M', 'Menu']);
  }

  foot.innerHTML = items.map(([k, label]) =>
    `<span class="bp-key"><kbd>${esc(k)}</kbd>${esc(label)}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Hero panel
// ---------------------------------------------------------------------------
function bpEmptyHero() {
  const cfg = {
    library: ['library', 'Nothing installed yet', 'Install something from the Store and it will appear here, ready to launch.'],
    store: ['store', 'Nothing to show', 'Every catalogue title is already in your library.'],
    downloads: ['download', 'No downloads', 'Installs and updates you start will queue up here.'],
    news: ['news', 'No news yet', 'Head to the News page to pull the latest headlines.']
  }[BP.tab] || ['info', 'Nothing here', ''];
  return `<div class="bp-hero-empty">
    <span class="bp-empty-ico">${icon(cfg[0], 30)}</span>
    <h2>${esc(cfg[1])}</h2>
    <p>${esc(cfg[2])}</p>
  </div>`;
}

/**
 * Transparent wordmark for the Big Picture hero, mirroring the detail view:
 * the typed title stays in the DOM as the accessible fallback and CSS swaps it
 * out the moment the image actually decodes. Resolution goes through the same
 * `State.logoAuto` cache the detail view fills (see logoart.js).
 *
 * Falls back to a plain <h1> when there is no game id to look a logo up by, so
 * a live storefront result without a catalogue entry still renders correctly.
 */
function bpLogoHtml(g, titleText, idOverride) {
  const id = idOverride || (g && g.id) || '';
  const title = esc(titleText || (g && g.title) || '');
  if (!id) return `<h1>${title}</h1>`;
  const src = (g && g.logo) || (State.logoAuto && State.logoAuto[id]) || '';
  return `<div class="bp-logo-wrap">
      <h1 class="bp-logo-text">${title}</h1>
      <img class="bp-logo" data-logo-id="${esc(id)}"${src ? ` src="${esc(src)}"` : ''} alt="${title}" draggable="false">
    </div>`;
}

/** Fills the hero's wordmark slot: cached ones now, a lookup for the rest. */
function bpResolveLogos(hero, g) {
  if (!hero) return;
  if (typeof syncLogos === 'function') syncLogos(hero);
  if (g && g.id && typeof loadHeroLogo === 'function') loadHeroLogo(g);
}

function bpHeroGame(g) {
  const st = statusOf(g.id);
  const eyebrow = st === 'play' || st === 'running' || st === 'downloading' ? 'Ready to play'
    : (typeof isUpcoming === 'function' && isUpcoming(g.id))
      ? (isPreordered(g.id) ? 'In your library \u00b7 pre-ordered' : 'Coming soon')
      : isOwned(g.id) ? 'In your library' : 'Not owned on this account';

  const meta = [
    g.developer ? `<span>${esc(g.developer)}</span>` : '',
    g.price ? `<span class="bp-price">${esc(priceTag(g))}</span>` : '',
    g.genre ? `<span>${esc(g.genre)}</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  const blurb = g.blurb || g.description || '';
  const cd = (typeof isUpcoming === 'function' && isUpcoming(g.id)) ? countdownHtml(g.releaseDate, { big: true }) : '';

  return `
    <div class="bp-hero-bg">${art(g, 'wide')}</div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner">
      <div class="bp-hero-cover">${art(g, 'cover')}</div>
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${esc(eyebrow)}${cd ? ` ${cd}` : ''}</div>
        ${bpLogoHtml(g)}
        <div class="bp-meta">${meta}${consoleBadges(g)}</div>
        ${blurb ? `<p class="bp-blurb">${esc(blurb)}</p>` : ''}
        <div class="bp-actions" data-actions="${esc(g.id)}">${actionHtml(g.id)}</div>
      </div>
    </div>`;
}

function bpHeroNews(n) {
  const src = n.source || n.author || n.feed || 'News';
  const bg = n.imageLarge || n.image;
  return `
    <div class="bp-hero-bg${bg ? '' : ' bp-hero-flat'}">
      ${bg ? `<img class="bp-news-bg" src="${esc(bg)}" alt="" draggable="false">` : ''}
    </div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner bp-hero-solo">
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${esc(src)}${n.date || n.published ? ` <i class="bp-sep"></i> ${esc(bpDate(n.date || n.published))}` : ''}</div>
        <h1 class="bp-h1-news">${esc(n.title || 'Untitled')}</h1>
        ${(n.summary || n.desc || n.description) ? `<p class="bp-blurb">${esc(n.summary || n.desc || n.description)}</p>` : ''}
        <div class="bp-actions">
          <button class="btn primary glow" data-bp-act="news-open" data-idx="${BP.index}">${icon('external', 15)} Read the full story</button>
        </div>
      </div>
    </div>`;
}

function bpHeroDownload(e) {
  const g = byId(e.id) || { title: e.id };
  const d = e.dl;
  const pct = d ? Math.floor(d.pct) : 100;
  const state = d ? (d.paused ? 'Paused' : `${d.speed.toFixed(1)} MB/s`) : 'Finished';
  return `
    <div class="bp-hero-bg">${g.cover || g.steamAppId ? art(g, 'wide') : '<div class="bp-hero-flat"></div>'}</div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner">
      <div class="bp-hero-cover">${art(g, 'cover')}</div>
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${d ? esc(d.kind === 'update' ? 'Updating' : 'Installing') : 'Download finished'}</div>
        ${bpLogoHtml(g)}
        <div class="bp-meta"><span>${esc(state)}</span></div>
        <div class="bp-progress"><div class="bar"><div style="width:${pct}%"></div></div><b>${pct}%</b></div>
        <div class="bp-actions">
          ${d ? `<button class="btn secondary" data-act="${d.paused ? 'resume' : 'pause'}" data-id="${esc(e.id)}">${icon(d.paused ? 'play' : 'pause', 15)} ${d.paused ? 'Resume' : 'Pause'}</button>
                 <button class="btn secondary" data-act="cancel" data-id="${esc(e.id)}">${icon('close', 15)} Cancel</button>`
              : `<button class="btn primary glow" data-act="play" data-id="${esc(e.id)}">${icon('play', 15)} Launch</button>`}
        </div>
      </div>
    </div>`;
}

function bpHeroSteam(e) {
  const it = e.it;
  const g = e.game;
  const meta = [
    it.priceLabel ? `<span class="bp-price">${esc(it.priceLabel)}</span>` : '',
    it.listPrice ? `<span class="bp-was">${esc(it.listPrice)}</span>` : '',
    it.discountPct ? `<span class="bp-off">-${it.discountPct}%</span>` : '',
    it.metascore ? `<span>Metascore ${esc(it.metascore)}</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  return `
    <div class="bp-hero-bg">${art(g, 'wide')}</div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner">
      <div class="bp-hero-cover">${art(g, 'cover')}</div>
      <div class="bp-hero-info">
        <div class="bp-eyebrow">Steam store</div>
        ${bpLogoHtml(e.game, it.name)}
        <div class="bp-meta">${meta}</div>
        <div class="bp-actions">
          <button class="btn primary glow" data-live-info="${esc(it.appId)}">${icon('info', 15)} Details</button>
          ${it.url ? `<button class="btn secondary" data-live-buy="${esc(it.url)}">${icon('external', 15)} Steam page</button>` : ''}
        </div>
      </div>
    </div>`;
}

function bpHeroItch(e) {
  const it = e.it;
  const g = e.game;
  const free = !it.price || it.price === 'Free';
  const plats = typeof itchPlatforms === 'function' ? itchPlatforms(it) : [];
  return `
    <div class="bp-hero-bg">${art(g, 'wide')}</div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner">
      <div class="bp-hero-cover">${art(g, 'cover')}</div>
      <div class="bp-hero-info">
        <div class="bp-eyebrow">itch.io${it.author ? ` <i class="bp-sep"></i> ${esc(it.author)}` : ''}</div>
        ${bpLogoHtml(e.game, it.title)}
        <div class="bp-meta">
          <span class="bp-price">${esc(free ? 'Free' : it.price)}</span>
          ${plats.length ? `<span>${icon('hardDrive', 13)} ${esc(plats.join(' \u00b7 '))}</span>` : ''}
        </div>
        ${it.blurb ? `<p class="bp-blurb">${esc(it.blurb)}</p>` : ''}
        <div class="bp-actions">
          <button class="btn primary glow" data-bp-itch="${esc(it.id)}">${icon('download', 15)} Get</button>
          ${it.url ? `<button class="btn secondary" data-itch-web="${esc(it.url)}">${icon('external', 15)} itch.io page</button>` : ''}
        </div>
      </div>
    </div>`;
}

function bpHeroNexus(e) {
  const it = e.it;
  const g = e.game;
  const providers = (typeof ltProviders === 'function' ? ltProviders(it) : []) || [];
  const gb = (typeof ltSizeGb === 'function') ? ltSizeGb(it) : 0;
  const installed = typeof isInstalled === 'function' && isInstalled(g.id);
  const queued = typeof DL !== 'undefined' && !!DL[g.id];

  const meta = [
    gb > 0.05 ? `<span>${icon('hardDrive', 13)} ${gb.toFixed(1)} GB</span>` : '',
    providers.length ? `<span>${icon('cloud', 13)} ${esc(providers.slice(0, 3).join(' \u00b7 '))}</span>` : '',
    it.version ? `<span>${esc(it.version)}</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  // The dialog is the only place that knows about mirrors and extraction, so the
  // hero only ever opens it (or launches an install that already exists).
  const actions = installed
    ? `<button class="btn primary glow" data-bp-play="${esc(g.id)}">${icon('play', 15)} Play</button>
       <button class="btn secondary" data-bp-nexus="${esc(it.id)}">${icon('info', 15)} Details</button>`
    : `<button class="btn primary glow" data-bp-nexus="${esc(it.id)}">${icon('download', 15)} ${queued ? 'Downloading\u2026' : 'Install'}</button>`;

  return `
    <div class="bp-hero-bg">${art(g, 'wide')}</div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner">
      <div class="bp-hero-cover">${art(g, 'cover')}</div>
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${icon('zap', 12)} Nexus${it.uploader ? ` <i class="bp-sep"></i> ${esc(it.uploader)}` : ''}</div>
        ${bpLogoHtml(g, it.title)}
        <div class="bp-meta">${meta}</div>
        <div class="bp-actions">${actions}</div>
      </div>
    </div>`;
}

function bpRenderHero() {
  const hero = document.getElementById('bp-hero');
  if (!hero) return;
  const e = BP.entries[BP.index];
  if (!e) { hero.innerHTML = bpEmptyHero(); return; }
  let g = null;
  if (e.kind === 'game') { hero.innerHTML = bpHeroGame(e.game); g = e.game; }
  else if (e.kind === 'steam') { hero.innerHTML = bpHeroSteam(e); g = e.game; }
  else if (e.kind === 'itch') { hero.innerHTML = bpHeroItch(e); g = e.game; }
  else if (e.kind === 'nexus') { hero.innerHTML = bpHeroNexus(e); g = e.game; }
  else if (e.kind === 'news') { hero.innerHTML = bpHeroNews(e.news); }
  else { hero.innerHTML = bpHeroDownload(e); g = byId(e.id); }
  bpResolveLogos(hero, g);
}

// ---------------------------------------------------------------------------
// Shelf
// ---------------------------------------------------------------------------
function bpTileHtml(e, i) {
  const sel = i === BP.index ? ' sel' : '';

  if (e.kind === 'game') {
    const g = e.game;
    const soon = typeof isUpcoming === 'function' && isUpcoming(g.id);
    const tag = soon ? `<em class="bp-tag soon">${icon('hourglass', 11)} Soon</em>`
      : isInstalled(g.id) ? `<em class="bp-tag ok">${icon('checkCircle', 11)} Ready</em>`
      : isOwned(g.id) ? `<em class="bp-tag">${icon('download', 11)} Install</em>`
      : `<em class="bp-tag dim">${icon('lock', 11)} Not owned</em>`;
    return `<button class="bp-tile${sel}" data-bp="tile" data-idx="${i}" title="${esc(g.title)}">
      <span class="bp-tile-art">${art(g, 'cover')}${tag}</span>
      <span class="bp-tile-name">${esc(g.title)}</span>
      <span class="bp-tile-sub">${consoleBadges(g)}</span>
    </button>`;
  }

  if (e.kind === 'news') {
    const n = e.news;
    const img = n.image || n.imageLarge;
    return `<button class="bp-tile news${sel}" data-bp="tile" data-idx="${i}">
      <span class="bp-tile-art news${img ? ' has-img' : ''}">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" draggable="false">`
               : `<span class="bp-news-mark">${icon('news', 24)}</span>`}
      </span>
      <span class="bp-tile-name">${esc(n.title || 'Untitled')}</span>
      <span class="bp-tile-sub">${esc(n.source || n.author || '')}</span>
    </button>`;
  }

  if (e.kind === 'steam') {
    const g = e.game;
    return `<button class="bp-tile${sel}" data-bp="tile" data-idx="${i}" title="${esc(g.title)}">
      <span class="bp-tile-art">${art(g, 'cover')}<em class="bp-tag dim">${icon('globe', 11)} Steam</em></span>
      <span class="bp-tile-name">${esc(g.title)}</span>
      <span class="bp-tile-sub"><span class="bp-price">${esc(e.it.priceLabel || '')}</span></span>
    </button>`;
  }

  if (e.kind === 'itch') {
    const g = e.game;
    const free = !e.it.price || e.it.price === 'Free';
    return `<button class="bp-tile${sel}" data-bp="tile" data-idx="${i}" title="${esc(g.title)}">
      <span class="bp-tile-art">${art(g, 'cover')}<em class="bp-tag dim">${icon('flame', 11)} itch.io</em></span>
      <span class="bp-tile-name">${esc(g.title)}</span>
      <span class="bp-tile-sub"><span class="bp-price">${esc(free ? 'Free' : e.it.price)}</span></span>
    </button>`;
  }

  if (e.kind === 'nexus') {
    const g = e.game;
    const providers = (typeof ltProviders === 'function' ? ltProviders(e.it) : []) || [];
    const gb = (typeof ltSizeGb === 'function') ? ltSizeGb(e.it) : 0;
    const installed = typeof isInstalled === 'function' && isInstalled(g.id);
    const sub = installed ? 'Installed'
      : providers.length ? providers.slice(0, 2).join(' \u00b7 ')
      : gb > 0.05 ? `${gb.toFixed(1)} GB` : '';
    return `<button class="bp-tile${sel}" data-bp="tile" data-idx="${i}" title="${esc(g.title)}">
      <span class="bp-tile-art">${art(g, 'cover')}<em class="bp-tag ${installed ? 'ok' : 'dim'}">${icon(installed ? 'checkCircle' : 'zap', 11)} Nexus</em></span>
      <span class="bp-tile-name">${esc(g.title)}</span>
      <span class="bp-tile-sub">${esc(sub)}</span>
    </button>`;
  }

  const g = byId(e.id) || { title: e.id };
  const pct = e.dl ? Math.floor(e.dl.pct) : 100;
  const stateIco = e.dl ? (e.dl.paused ? 'pause' : 'download') : 'checkCircle';
  return `<button class="bp-tile dl${sel}" data-bp="tile" data-idx="${i}">
    <span class="bp-tile-art">
      ${g.cover || g.steamAppId ? art(g, 'cover') : ''}
      <span class="bp-dl-scrim">${icon(stateIco, 26)}</span>
      <span class="bp-tile-bar"><i style="width:${pct}%"></i></span>
    </span>
    <span class="bp-tile-name">${esc(g.title)}</span>
  </button>`;
}

function bpRenderShelf() {
  const shelf = document.getElementById('bp-shelf');
  if (!shelf) return;

  if (BP.entries.length) {
    shelf.innerHTML = BP.entries.map((e, i) => bpTileHtml(e, i)).join('');
    // Each tile carries its own slot in the launch stagger. Setting it here
    // covers every tile kind without threading the index through each branch.
    [...shelf.children].forEach((el, i) => el.style.setProperty('--i', String(i)));
  } else {
    const label = (BP_TABS.find((t) => t.key === BP.tab) || {}).label || 'this section';
    const q = (BP.searchQuery || '').trim();
    const source = BP.tab === 'store' ? 'steam' : BP.tab === 'itch' ? 'itch' : null;
    const live = source && q.length >= 2 ? source : null;

    // Say which of the three things is actually happening, so a storefront that
    // is still answering (or rate-limiting us) is never mistaken for "no match".
    let note;
    if (live && BP.liveBusy[live]) note = `Searching ${esc(label)}\u2026`;
    else if (live && BP.liveError[live]) note = esc(BP.liveError[live]);
    else note = `Nothing to show in ${esc(label)}.`;
    shelf.innerHTML = `<div class="bp-shelf-empty">${icon('info', 18)} ${note}</div>`;
  }

  const head = document.getElementById('bp-shelf-title');
  if (head) head.textContent = (BP_TABS.find((t) => t.key === BP.tab) || {}).label || '';
  const count = document.getElementById('bp-shelf-count');
  if (count) count.textContent = bpCount(BP.entries.length);
  bpMarkSelected();
}

function bpMarkSelected() {
  const tiles = document.querySelectorAll('#bp-shelf .bp-tile');
  tiles.forEach((t, i) => t.classList.toggle('sel', i === BP.index));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
BP.select = function (index) {
  if (!BP.entries.length) return;
  const i = Math.max(0, Math.min(BP.entries.length - 1, index));
  if (i === BP.index) return;
  BP.index = i;
  bpMarkSelected();
  bpRenderHero();
};

/** Called by the focus engine whenever the ring lands on one of our tiles. */
BP.followFocus = function (el) {
  if (!el || !el.classList || !el.classList.contains('bp-tile')) return;
  const i = Number(el.dataset.idx);
  if (!isFinite(i) || i === BP.index) return;
  BP.index = i;
  bpMarkSelected();
  bpRenderHero();
};

/** Puts the ring on the tile that is currently selected (or the first one). */
BP.focusTile = function () {
  const tiles = document.querySelectorAll('#bp-shelf .bp-tile');
  if (!tiles.length) return;
  const el = tiles[BP.index] || tiles[0];
  if (el) Focus.set(el, { src: 'bp' });
};

BP.focusRing = function () {
  BP.focusTile();
};

// ---------------------------------------------------------------------------
// Full rebuild
// ---------------------------------------------------------------------------
function bpBuild() {
  BP.entries = bpEntries(BP.tab);
  if (BP.index >= BP.entries.length) BP.index = Math.max(0, BP.entries.length - 1);
  bpRenderTabs();
  bpRenderShelf();
  bpRenderHero();
  bpRenderStatus();
  bpRenderFoot();
}

/** Re-renders without disturbing the ring — used for live progress updates. */
BP.refresh = function () {
  if (!BP.openFlag) return;
  const hadRing = !!(Focus.el && Focus.el.classList && Focus.el.classList.contains('bp-tile'));
  BP.entries = bpEntries(BP.tab);
  if (BP.index >= BP.entries.length) BP.index = Math.max(0, BP.entries.length - 1);
  bpRenderTabs();
  bpRenderShelf();
  bpRenderHero();
  bpRenderStatus();
  if (hadRing) BP.focusTile();
};

BP.refreshHints = function () {
  bpRenderFoot();
  bpRenderStatus();
};

/** Big Picture's news shelf reads State.news; fetch it if it is still empty. */
function bpEnsureNews() {
  if (BP.tab !== 'news') return;
  if (((State.news && State.news.items) || []).length) return;
  if (typeof fetchNewsIntoState !== 'function') return;
  fetchNewsIntoState(false).then((res) => {
    if (res && res.ok && BP.isOpen() && BP.tab === 'news') { bpBuild(); BP.focusTile(); }
  }).catch(() => { /* the hero already explains there is nothing to show */ });
}

/**
 * Big Picture's itch.io shelf reads the itch.io catalogue the itch view keeps in
 * `itchItems`. Load the featured feed the first time the section is opened, so
 * a user who has never visited the itch.io tab still sees something to browse.
 */
function bpEnsureItch() {
  if (BP.tab !== 'itch') return;
  if (typeof itchItems !== 'undefined' && itchItems.length) return;
  if (typeof itchLoad !== 'function') return;
  itchLoad({ reset: true }).then(() => {
    if (BP.isOpen() && BP.tab === 'itch') { bpBuild(); BP.focusTile(); }
  }).catch(() => { /* the shelf explains there is nothing to show */ });
}

/**
 * Big Picture's Nexus shelf reads the catalogue the Nexus view keeps in
 * `ltItems`. Load it the first time the section is opened, so a user who has
 * never visited the Nexus tab still sees something to browse.
 */
function bpEnsureNexus() {
  if (BP.tab !== 'nexus') return;
  if (typeof ltItems !== 'undefined' && ltItems.length) return;
  if (typeof ltLoad !== 'function') return;
  Promise.resolve(ltLoad('')).then(() => {
    if (BP.isOpen() && BP.tab === 'nexus') { bpBuild(); BP.focusTile(); }
  }).catch(() => { /* the shelf explains there is nothing to show */ });
}

BP.setTab = function (key) {
  if (!key || key === BP.tab) return;
  BP.tab = key;
  BP.index = 0;
  BP.searchQuery = '';
  bpResetLive();
  clearTimeout(BP.nexusTimer);
  const bpSearch = document.getElementById('bp-search-input');
  if (bpSearch) bpSearch.value = '';
  bpBuild();
  BP.focusTile();
  bpEnsureNews();
  bpEnsureItch();
  bpEnsureNexus();
};

BP.cycleTab = function (delta) {
  const i = Math.max(0, BP_TABS.findIndex((t) => t.key === BP.tab));
  const next = BP_TABS[(i + delta + BP_TABS.length) % BP_TABS.length];
  BP.setTab(next.key);
};

// ---------------------------------------------------------------------------
// Power / menu overlay
// ---------------------------------------------------------------------------
BP.overlayOpen = function () {
  const m = document.getElementById('bp-power-menu');
  return !!m && !m.classList.contains('hidden');
};

function bpOverlayRow(act, ico, label, note, cls = '') {
  return `<button class="bp-prow${cls}" data-bp-act="${act}">
    <span class="bp-prow-ico">${icon(ico, 19)}</span>
    <span class="bp-prow-text"><strong>${esc(label)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</span>
  </button>`;
}

BP.renderOverlay = function () {
  const menu = document.getElementById('bp-power-menu');
  if (!menu) return;
  const name = (State.profile && State.profile.name) || 'Player';

  menu.innerHTML = `
    <div class="bp-power-card" role="dialog" aria-modal="true">
      <header class="bp-power-head">
        <span class="bp-power-logo">${icon('flame', 20)}</span>
        <div><strong>Apex Launcher</strong><small>Signed in as ${esc(name)}</small></div>
      </header>
      <div class="bp-power-rows">
        ${bpOverlayRow('resume', 'left', 'Resume', 'Back to Big Picture')}
        ${bpOverlayRow('fullscreen', BP.fs ? 'fullscreenExit' : 'fullscreen',
          BP.fs ? 'Leave full screen' : 'Full screen', 'Toggles F11')}
        ${bpOverlayRow('sound', SFX.isMuted() ? 'volumeOff' : 'volume',
          SFX.isMuted() ? 'Turn UI sounds on' : 'Turn UI sounds off', 'Select, back, panels')}
        <div class="bp-power-sep"></div>
        ${bpOverlayRow('exit', 'min', 'Exit Big Picture', 'Return to the desktop layout')}
        ${bpOverlayRow('settings', 'settings', 'Settings', 'Sound, display, overlay, screenshots')}
        <div class="bp-power-sep"></div>
        ${bpOverlayRow('quit', 'power', 'Quit Apex Launcher', 'Closes the launcher', ' danger')}
      </div>
    </div>`;
};

BP.openOverlay = function () {
  const menu = document.getElementById('bp-power-menu');
  if (!menu || BP.overlayOpen()) return;
  BP.renderOverlay();
  menu.classList.remove('hidden');
  SFX.play('open');
  const first = menu.querySelector('.bp-prow');
  if (first) Focus.set(first, { src: 'bp' });
};

BP.closeOverlay = function () {
  const menu = document.getElementById('bp-power-menu');
  if (!menu || !BP.overlayOpen()) return;
  menu.classList.add('hidden');
  SFX.play('close');
  BP.focusTile();
};

// ---------------------------------------------------------------------------
// Settings, inside Big Picture
// ---------------------------------------------------------------------------
// A 10-foot settings screen: every control is a button, so the d-pad can reach
// and change it without a mouse. Deep or text-heavy configuration stays in the
// desktop Settings view, which is one row away at the bottom.
BP.settingsOpen = function () {
  const sheet = document.getElementById('bp-settings');
  return !!sheet && !sheet.classList.contains('hidden');
};

function bpOverlayCfg() {
  State.settings.overlay = State.settings.overlay || {};
  return State.settings.overlay;
}

function bpShotCfg() {
  State.settings.screenshot = State.settings.screenshot || {};
  return State.settings.screenshot;
}

function bpSetRow(ico, label, note, ctl) {
  return `<div class="bps-row">
    <span class="bps-ico">${icon(ico, 18)}</span>
    <div class="bps-text"><strong>${esc(label)}</strong><small>${esc(note)}</small></div>
    <div class="bps-ctl">${ctl || ''}</div>
  </div>`;
}

function bpSetToggle(key, on) {
  return `<button class="bps-btn ${on ? 'on' : ''}" data-bpset="${key}" aria-pressed="${on}">${on ? 'On' : 'Off'}</button>`;
}

BP.renderSettings = function () {
  const sheet = document.getElementById('bp-settings');
  if (!sheet) return;

  const s = State.settings;
  const ov = s.overlay || {};
  const sc = s.screenshot || {};
  const vol = Math.max(0, Math.min(100, Math.round(Number(s.uiVolume ?? 60))));
  const sounds = s.uiSounds !== false;
  const overOn = ov.enabled !== false;
  const shotsOn = sc.enabled !== false;
  const animate = bpAnimateOn();
  const pad = (typeof GP !== 'undefined' && GP.first) ? GP.first() : null;

  sheet.innerHTML = `
    <div class="bp-power-card bps-card" role="dialog" aria-modal="true" aria-label="Big Picture settings">
      <header class="bp-power-head">
        <span class="bp-power-logo">${icon('settings', 20)}</span>
        <div><strong>Big Picture settings</strong><small>Every row here works with a controller</small></div>
      </header>
      <div class="bps-list">
        <p class="bps-group">Sound</p>
        ${bpSetRow(sounds ? 'volume' : 'volumeOff', 'Interface sounds',
          'Clicks for moving, selecting and backing out',
          bpSetToggle('uiSounds', sounds))}
        ${bpSetRow('volume', 'Volume', 'How loud the cues are',
          `<button class="bps-btn step" data-bpset="uiVolume" data-step="-10" aria-label="Lower the volume">\u2212</button>
           <span class="bps-val">${vol}%</span>
           <button class="bps-btn step" data-bpset="uiVolume" data-step="10" aria-label="Raise the volume">+</button>`)}

        <p class="bps-group">Display</p>
        ${bpSetRow(BP.fs ? 'fullscreenExit' : 'fullscreen', 'Full screen',
          'Take the whole screen, or share it with the desktop',
          bpSetToggle('bigPictureFullscreen', BP.fs))}
        ${bpSetRow('sparkles', 'Launch animation',
          'The curtain, the rising hero and the shelf walking in',
          bpSetToggle('bpAnimate', animate))}

        <p class="bps-group">While you play</p>
        ${bpSetRow('activity', 'Performance overlay',
          `Real CPU, GPU and RAM over the game \u00b7 ${String(ov.key || 'F8')}`,
          bpSetToggle('overlayOn', overOn))}
        ${bpSetRow('camera', 'Screenshots',
          `Full-screen PNGs saved to your gallery \u00b7 ${String(sc.key || 'F2')}`,
          bpSetToggle('shotsOn', shotsOn))}

        <p class="bps-group">Controller</p>
        ${bpSetRow('gamepad', pad ? pad.name : 'No controller connected',
          pad ? `${pad.label} \u00b7 ring moves, A selects, B goes back`
              : 'Press a button on a pad and it is picked up straight away', '')}

        <p class="bps-group">More</p>
        <button class="bps-wide" data-bpset-act="desktop">
          ${icon('settings', 17)}
          <span>Open desktop settings<small>Appearance, downloads, controller, achievements, Steam</small></span>
        </button>
        <button class="bps-wide" data-bpset-act="done">
          ${icon('check', 17)}<span>Done</span>
        </button>
      </div>
    </div>`;
};

BP.openSettings = function () {
  const sheet = document.getElementById('bp-settings');
  if (!sheet) return;
  const menu = document.getElementById('bp-power-menu');
  if (menu) menu.classList.add('hidden');
  BP.renderSettings();
  sheet.classList.remove('hidden');
  SFX.play('open');
  const first = sheet.querySelector('.bps-btn, .bps-wide');
  if (first) Focus.set(first, { src: 'bp' });
};

BP.closeSettings = function (opts = {}) {
  const sheet = document.getElementById('bp-settings');
  if (!sheet || !BP.settingsOpen()) return;
  sheet.classList.add('hidden');
  if (!opts.silent) {
    SFX.play('close');
    BP.focusTile();
  }
};

/** Flips or nudges one setting, then puts the ring back on the same control. */
function bpApplySetting(key, step, el) {
  const s = State.settings;

  if (key === 'uiVolume') {
    s.uiVolume = Math.max(0, Math.min(100, Math.round(Number(s.uiVolume ?? 60)) + (Number(step) || 0)));
  } else if (key === 'uiSounds') {
    s.uiSounds = s.uiSounds === false;
  } else if (key === 'bpAnimate') {
    s.bpAnimate = s.bpAnimate === false;
  } else if (key === 'bigPictureFullscreen') {
    const next = !BP.fs;
    s.bigPictureFullscreen = next;
    try { window.api.toggleFullscreen(next); } catch { /* the OS will keep the window as it is */ }
  } else if (key === 'overlayOn') {
    const ov = bpOverlayCfg();
    ov.enabled = ov.enabled === false;
    window.api.applyHotkeys().catch(() => { /* the old shortcuts stay bound */ });
  } else if (key === 'shotsOn') {
    const sc = bpShotCfg();
    sc.enabled = sc.enabled === false;
    window.api.applyHotkeys().catch(() => { /* the old shortcuts stay bound */ });
  } else {
    return;
  }

  persist();
  SFX.play('toggle');

  // Re-rendering is how the value label stays honest, but it destroys the button
  // the ring was on - so the same control is found again by key and step.
  BP.renderSettings();
  const sel = (el && el.dataset.step != null)
    ? `#bp-settings [data-bpset="${key}"][data-step="${el.dataset.step}"]`
    : `#bp-settings [data-bpset="${key}"]`;
  const again = document.querySelector(sel);
  if (again) Focus.set(again, { src: 'bp' });
}

function bpSettingsAct(act) {
  if (act === 'done') { SFX.play('back'); BP.closeSettings(); return; }
  if (act === 'desktop') {
    SFX.play('select');
    BP.closeSettings({ silent: true });
    BP.exit();
    gotoView('settings');
  }
}

// ---------------------------------------------------------------------------
// Enter / exit
// ---------------------------------------------------------------------------
BP.setFullscreen = function (on) {
  BP.fs = !!on;
  bpRenderStatus();
  if (BP.overlayOpen()) BP.renderOverlay();
};

/**
 * The launch animation: a black curtain lifts while the chrome drops, the hero
 * rises and the shelf tiles walk in one after another.
 *
 * The class is removed first and a reflow forced, otherwise re-opening the mode
 * would not restart an animation that had already run. It is cleaned up on a
 * timer so nothing is left animating behind the layer (the shelf can be
 * re-rendered dozens of times while it is open).
 */
let bpInTimer = null;

/** Is the mode-change animation wanted right now? */
function bpAnimateOn() {
  if (State.settings.bpAnimate === false) return false;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch { /* no matchMedia: assume motion is fine */ }
  return true;
}

function bpPlayEntry(root) {
  if (!root) return;
  clearTimeout(bpInTimer);
  root.classList.remove('bp-in');
  void root.offsetWidth;          // force a reflow so the animation replays
  if (!bpAnimateOn()) return;
  root.classList.add('bp-in');
  bpInTimer = setTimeout(() => root.classList.remove('bp-in'), 1400);
}

BP.enter = function () {
  if (BP.openFlag) return;
  const root = bpRoot();
  if (!root) return;

  BP.openFlag = true;
  document.body.classList.add('big-picture');
  root.classList.remove('hidden');
  root.setAttribute('aria-hidden', 'false');

  SFX.unlock();
  SFX.play('enter');

  // Big Picture is a 10-foot interface, so it really wants the whole screen.
  // The window is restored to the way it was on the way out.
  if (State.settings.bigPictureFullscreen !== false && !BP.fs) {
    try { window.api.toggleFullscreen(true); BP.weFullscreened = true; } catch { /* ignore */ }
  }

  bpBuild();
  bpPlayEntry(root);
  BP.focusTile();
  bpEnsureNews();
  bpEnsureItch();
  bpEnsureNexus();

  // Wire the shelf search box (once) so every section can be searched.
  const bpSearch = document.getElementById('bp-search-input');
  if (bpSearch && !bpSearch._wired) {
    bpSearch._wired = true;
    bpSearch.addEventListener('input', () => {
      BP.searchQuery = bpSearch.value;
      BP.index = 0;
      bpQueueLive();          // Store -> Steam, itch.io -> itch.io (debounced)
      bpBuild();
      BP.focusTile();
    });
    bpSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        bpSearch.value = '';
        BP.searchQuery = '';
        BP.index = 0;
        bpResetLive();
        bpBuild();
        BP.focusTile();
      }
    });
  }
  BP.searchQuery = '';
  bpResetLive();
  if (bpSearch) bpSearch.value = '';
  BP.clockTimer = setInterval(() => { if (BP.openFlag) bpRenderStatus(); }, 15000);

  // Anything queued while Big Picture is open keeps its progress bar honest.
  clearInterval(BP.refreshTimer);
  BP.refreshTimer = setInterval(() => {
    if (BP.openFlag && BP.tab === 'downloads') BP.refresh();
  }, 1000);

  toast('Big Picture mode \u00b7 press M / Start for the menu', 'info');
};

BP.exit = function () {
  if (!BP.openFlag) return;
  if (BP.overlayOpen()) {
    const menu = document.getElementById('bp-power-menu');
    if (menu) menu.classList.add('hidden');
  }
  BP.closeSettings({ silent: true });

  BP.openFlag = false;
  document.body.classList.remove('big-picture');

  // The state change is immediate - callers and the test suite depend on
  // `isOpen()` being false the moment this returns. The layer fades itself out
  // on its own: #bigpic.hidden animates opacity and only flips visibility once
  // the transition has finished (bigpicture.css), so nothing is delayed here.
  const root = bpRoot();
  if (root) {
    root.classList.remove('bp-in');
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  clearInterval(BP.clockTimer);
  clearInterval(BP.refreshTimer);
  BP.clockTimer = null;
  BP.refreshTimer = null;

  Focus.clear();
  document.body.classList.remove('gp-nav');

  if (BP.weFullscreened) {
    try { window.api.toggleFullscreen(false); } catch { /* ignore */ }
    BP.weFullscreened = false;
  }
  SFX.play('exit');
};

BP.toggle = function () {
  if (BP.openFlag) BP.exit();
  else BP.enter();
};

// ---------------------------------------------------------------------------
// Pointer + keyboard wiring inside the layer
// ---------------------------------------------------------------------------
(function wireBigPicture() {
  const root = bpRoot();
  if (!root) return;

  // A single click selects; the hero owns the real actions, so nothing is ever
  // launched by a stray click on a tile.
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-act]')) return;      // hero actions are handled by app.js

    const tab = e.target.closest('[data-bp="tab"]');
    if (tab) { SFX.play('tab'); BP.setTab(tab.dataset.tab); return; }

    const tile = e.target.closest('[data-bp="tile"]');
    if (tile) { SFX.play('move'); BP.select(Number(tile.dataset.idx)); return; }

    // The itch.io hero's "Get" button opens the itch.io dialog, which renders
    // above Big Picture (the modal layer sits at a higher z-index).
    const itch = e.target.closest('[data-bp-itch]');
    if (itch) {
      SFX.play('select');
      const it = bpFindItch(itch.dataset.bpItch);
      if (it) itchOpenDialog(it);
      return;
    }

    // The Nexus hero works the same way: the Nexus dialog owns mirrors, size and
    // extraction, so Big Picture never tries to duplicate that logic.
    const nexus = e.target.closest('[data-bp-nexus]');
    if (nexus) {
      SFX.play('select');
      const it = bpFindNexus(nexus.dataset.bpNexus);
      if (it) ltOpenDialog(it);
      else toast('That Nexus entry is not on the shelf any more', 'warn');
      return;
    }

    const play = e.target.closest('[data-bp-play]');
    if (play) {
      SFX.play('select');
      bpLaunchFx();
      launchGame(play.dataset.bpPlay);
      return;
    }

    // The in-Big-Picture settings sheet: every control is a button, so a click
    // and a d-pad press take exactly the same path.
    const setBtn = e.target.closest('[data-bpset]');
    if (setBtn) {
      bpApplySetting(setBtn.dataset.bpset, setBtn.dataset.step, setBtn);
      return;
    }

    const setAct = e.target.closest('[data-bpset-act]');
    if (setAct) { bpSettingsAct(setAct.dataset.bpsetAct); return; }

    const act = e.target.closest('[data-bp-act]');
    if (act) { bpOverlayAct(act.dataset.bpAct); return; }
  });

  root.addEventListener('dblclick', (e) => {
    const tile = e.target.closest('[data-bp="tile"]');
    if (!tile) return;
    SFX.play('select');
    bpActivateIndex(Number(tile.dataset.idx));
  });

  document.getElementById('bp-power').addEventListener('click', () => {
    SFX.play('select');
    BP.openOverlay();
  });

  document.getElementById('bp-sound').addEventListener('click', () => {
    const muted = SFX.toggleMute();
    if (!muted) SFX.play('toggle');
    bpRenderStatus();
    if (BP.overlayOpen()) BP.renderOverlay();
  });

  document.getElementById('bp-fs').addEventListener('click', () => {
    SFX.play('toggle');
    try { window.api.toggleFullscreen(); } catch { /* ignore */ }
  });

  // The overlay swallows clicks on its own backdrop.
  document.getElementById('bp-power-menu').addEventListener('click', (e) => {
    if (e.target.id === 'bp-power-menu') BP.closeOverlay();
  });
})();

let bpLaunchTimer = null;

/** A short power-on flash when a game is actually started from Big Picture. */
function bpLaunchFx() {
  const root = bpRoot();
  if (!root || !bpAnimateOn()) return;
  root.classList.remove('bp-launching');
  void root.offsetWidth;
  root.classList.add('bp-launching');
  clearTimeout(bpLaunchTimer);
  bpLaunchTimer = setTimeout(() => root.classList.remove('bp-launching'), 700);
}

/** Performs the primary action of one shelf entry (used by double-click). */
function bpActivateIndex(i) {
  const e = BP.entries[i];
  if (!e) return;
  if (e.kind === 'steam') { openStorePreview(e.it.appId); return; }
  if (e.kind === 'itch') { itchOpenDialog(e.it); return; }
  if (e.kind === 'nexus') { ltOpenDialog(e.it); return; }
  if (e.kind === 'game') {
    const st = statusOf(e.id);
    if (st === 'play' || st === 'running') { bpLaunchFx(); launchGame(e.id); }
    else if (st === 'notinstalled') openInstallDialog(e.id, 'install');
    else if (st === 'downloading') openDownloadModal(e.id);
    else if (typeof isUpcoming === 'function' && isUpcoming(e.id)) {
      if (isPreordered(e.id)) openPreorderInfo(e.id); else addPreorder(e.id);
    } else openDetail(e.id);
  } else if (e.kind === 'news') {
    bpOpenNews(e.news);
  } else {
    openDownloadModal(e.id);
  }
}

/** The live itch.io item behind a shelf entry, for the hero's "Get" button. */
function bpFindItch(id) {
  const e = BP.entries.find((x) => x.kind === 'itch' && x.id === id);
  return e ? e.it : null;
}

/** The Nexus catalogue item behind a shelf entry, for its hero button. */
function bpFindNexus(id) {
  const e = BP.entries.find((x) => x.kind === 'nexus' && x.id === id);
  return e ? e.it : null;
}

function bpOpenNews(n) {
  const url = n.url || n.link;
  if (!url) { toast('No link for that story', 'warn'); return; }
  window.api.openExternal(url).then((ok) => {
    toast(ok ? 'Opening the story in your browser' : 'Could not open the link', ok ? 'check' : 'warn');
  }).catch(() => toast('Could not open the link', 'warn'));
}

/** The power overlay's rows. */
function bpOverlayAct(act) {
  switch (act) {
    case 'resume':
      SFX.play('back');
      BP.closeOverlay();
      return;
    case 'fullscreen':
      SFX.play('toggle');
      try { window.api.toggleFullscreen(); } catch { /* ignore */ }
      return;
    case 'sound': {
      const muted = SFX.toggleMute();
      if (!muted) SFX.play('toggle');
      BP.renderOverlay();
      bpRenderStatus();
      return;
    }
    case 'exit':
      SFX.play('back');
      BP.exit();
      return;
    case 'settings':
      SFX.play('select');
      BP.openSettings();
      return;
    case 'quit':
      SFX.play('exit');
      window.api.quit();
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Keyboard inside Big Picture
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (!BP.openFlag) return;
  if (e.ctrlKey || e.altKey) return;

  const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };

  // Keys typed into the shelf search box belong to the field: arrows move the
  // caret, Backspace edits, Escape clears (handled on the input itself). None
  // of them may navigate the shelf or leave Big Picture.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape') consume();   // keep the global handler out of it
    return;
  }

  switch (e.key) {
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      consume();
      SFX.play('move');
      Focus.move(e.key.replace('Arrow', '').toLowerCase(), 'key');
      return;
    case 'Enter':
      consume();
      SFX.play('select');
      if (Focus.el && Focus.el.classList.contains('bp-tile')) BP.followFocus(Focus.el);
      if (Focus.el && Focus.el.classList.contains('bp-tile')) bpActivateIndex(Number(Focus.el.dataset.idx));
      else Focus.activate();
      return;
    case 'Tab':
      consume();
      if (BP.settingsOpen()) return;   // the settings sheet owns the input
      SFX.play('tab');
      BP.cycleTab(e.shiftKey ? -1 : 1);
      return;
    case 'Escape':
      // Escape deliberately does NOT leave Big Picture any more: it only unwinds
      // the settings sheet or the power overlay. The event is still swallowed so
      // the global handler in app.js cannot exit on its behalf either.
      consume();
      if (BP.settingsOpen()) { SFX.play('back'); BP.closeSettings(); }
      else if (BP.overlayOpen()) { SFX.play('back'); BP.closeOverlay(); }
      return;
    case 'm': case 'M':
      // Keyboard stand-in for the pad's Start button, so a keyboard user can
      // still reach the power menu (and its Settings row).
      consume();
      if (BP.settingsOpen()) { SFX.play('back'); BP.closeSettings(); return; }
      SFX.play('select');
      BP.openOverlay();
      return;
    default:
      return;
  }
});
