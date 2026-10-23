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
  { key: 'emulators', label: 'Emulators', ico: 'gamepad' },
  { key: 'downloads', label: 'Downloads', ico: 'download' },
  { key: 'news', label: 'News', ico: 'news' },
  { key: 'gallery', label: 'Gallery', ico: 'camera' },
  { key: 'tools', label: 'Tools', ico: 'shield' },
  // The last two are not shelves: there is nothing to browse. They render as a
  // single readable page in the hero's slot, which is why they are flagged.
  { key: 'profile', label: 'Profile', ico: 'user', info: true },
  { key: 'contact', label: 'Contact', ico: 'messageSquare', info: true }
];

/** True for a section that renders a page instead of a shelf of tiles. */
function bpIsInfo(key) {
  return !!((BP_TABS.find((t) => t.key === (key || BP.tab)) || {}).info);
}

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
  // The category chooser's selection, kept per section so leaving the Library
  // for Emulators and coming back does not silently change what is on show.
  cat: { library: 'all', emulators: 'all' },

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

/**
 * The plain-text name of an entry, whatever kind it is.
 *
 * The shelf search, the empty states and the "section" labels all want one
 * string out of six different shapes, and a missing case here shows up as a
 * section that mysteriously cannot be searched.
 */
function bpEntryTitle(e) {
  if (!e) return '';
  if (e.emulator) return e.emulator.name || '';
  if (e.rom) return e.rom.title || e.rom.name || '';
  if (e.shot) return e.shot.game || e.shot.name || '';
  if (e.it) return e.it.name || '';
  const g = e.game || (e.id && byId(e.id));
  return (g && g.title) || (e.news && e.news.title) || '';
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
  } else if (tab === 'emulators') {
    out = bpEmulatorItems();
    // The console-family chooser above the shelf. ROMs are grouped by their
    // system's family; an emulator carries its own group from the catalogue.
    const cat = BP.cat.emulators || 'all';
    if (cat !== 'all') {
      out = out.filter((e) => {
        const group = e.kind === 'emulator'
          ? (e.emulator && e.emulator.group)
          : (typeof emuSystem === 'function' && e.rom ? emuSystem(e.rom.system).group : null);
        return group === cat;
      });
    }
  } else if (tab === 'gallery') {
    const shots = (galleryShots && galleryShots.shots) || [];
    for (const s of shots) out.push({ kind: 'shot', key: s.name, id: s.name, shot: s });
  } else if (tab === 'tools') {
    for (const it of bpToolItems()) out.push({ kind: 'tool', key: `${it.kind}:${it.appId}`, id: String(it.appId), it });
  } else if (bpIsInfo(tab)) {
    out = [];
  } else {
    // The Library's chooser cuts by storefront. The Store section is a single
    // storefront already and has no such row, so the filter stays off there.
    const cat = tab === 'library' ? (BP.cat.library || 'all') : 'all';
    const games = tab === 'store' ? storeGames() : [...installedGames(), ...preorderedGames()]
      .filter((g) => cat === 'all' || (typeof platformTag === 'function' && platformTag(g) === cat));
    const seen = new Set();
    for (const g of games) {
      if (!g || seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ kind: 'game', key: g.id, id: g.id, game: g });
    }
  }

  const q = (BP.searchQuery || '').trim().toLowerCase();
  if (q) {
    out = out.filter((e) => String(bpEntryTitle(e)).toLowerCase().includes(q));
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
  // Eleven sections do not fit under a projector, so the bar scrolls. Keep the
  // current one in view when the section changes from a controller or a key.
  const on = wrap.querySelector('.bp-tab.on');
  if (on && on.scrollIntoView) {
    try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  }
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
    news: ['news', 'No news yet', 'Head to the News page to pull the latest headlines.'],
    emulators: ['gamepad', 'No ROMs found', 'Add a folder of ROMs on the Emulators page and Apex will sort them by console here.'],
    gallery: ['camera', 'No screenshots yet', 'Press F2 while playing anything and it lands here, in one place.'],
    tools: ['shield', 'Nothing to show', 'The Tools catalogue could not be reached. Check your connection and try again.']
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

// ---------------------------------------------------------------------------
// Heroes for the shelf kinds that are not a storefront listing
// ---------------------------------------------------------------------------
function bpHeroRom(e) {
  const rom = e.rom;
  const target = (typeof emuFor === 'function') ? emuFor(rom.system) : null;
  const sys = (typeof emuSystem === 'function') ? emuSystem(rom.system) : { label: rom.system, full: rom.system, group: '' };
  const ext = (String(rom.name || '').match(/\.[^.]+$/) || [''])[0].slice(1).toUpperCase();
  const size = (typeof emuSize === 'function') ? emuSize(rom.size) : '';

  const meta = [
    sys.full ? `<span>${esc(sys.full)}</span>` : '',
    size ? `<span>${icon('hardDrive', 13)} ${esc(size)}</span>` : '',
    target ? `<span>${icon('gamepad', 13)} ${esc(target.name)}</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  return `
    <div class="bp-hero-bg bp-hero-flat"></div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner">
      <div class="bp-hero-cover plate"><span>${esc(ext || 'ROM')}</span></div>
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${icon('gamepad', 12)} ${esc(sys.group || 'Emulator')}${sys.label ? ` <i class="bp-sep"></i> ${esc(sys.label)}` : ''}</div>
        <h1>${esc(rom.title || rom.name)}</h1>
        <div class="bp-meta">${meta}</div>
        ${rom.dir ? `<p class="bp-blurb">${esc(rom.dir)}</p>` : ''}
        <div class="bp-actions">
          <button class="btn primary glow" data-bp-rom="${esc(rom.system)}" data-path="${esc(rom.path)}"${target ? '' : ' disabled'}>
            ${icon('play', 15)} ${target ? `Play in ${esc(target.name)}` : 'No emulator for this console'}
          </button>
          <button class="btn secondary" data-bp-reveal="${esc(rom.path)}">${icon('folder', 15)} Show the file</button>
        </div>
      </div>
    </div>`;
}

function bpHeroEmulator(e) {
  const it = e.emulator;
  const upd = e.update || null;
  const systems = it.systems || [];
  const sys = systems.slice(0, 4).map((k) => emuSystem(k).label).join(', ') + (systems.length > 4 ? ` +${systems.length - 4}` : '');
  const size = (typeof emuMb === 'function') ? emuMb(it.mb) : '';

  const meta = [
    sys ? `<span>${icon('gamepad', 13)} ${esc(sys)}</span>` : '',
    it.installed && it.version ? `<span>${icon('cpu', 13)} ${esc(it.version)}</span>` : '',
    it.installed && !it.version ? `<span>${icon('cpu', 13)} Installed</span>` : '',
    !it.installed && size ? `<span>${icon('download', 13)} ${esc(size)}</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  // A page button only where there is a page: an entry can be listed with nothing
  // to fetch and nowhere safe to send anyone, and a button that opens nothing is
  // worse than no button at all.
  const pageBtn = (label) => (it.page
    ? `<button class="btn secondary" data-bp-emupage="${esc(it.page)}">${icon('external', 15)} ${label}</button>`
    : '');

  // "Later" leaves the newer build on the shelf, but it should not keep the
  // headline: once the question has been answered, playing is the main verb and
  // the update is the second button.
  const waved = it.installed && typeof emuSkipUpdate === 'function' && emuSkipUpdate(it.id);
  const actions = it.installed
    ? `${upd ? `<button class="btn ${waved ? 'secondary' : 'primary glow'}" data-bp-emuget="${esc(it.id)}">${icon('refresh', 15)} ${waved ? 'Update' : 'Update now'}</button>` : ''}
       <button class="btn ${upd && !waved ? 'secondary' : 'primary glow'}" data-bp-emurun="${esc(it.id)}">${icon('play', 15)} Launch</button>
       ${pageBtn('Project page')}`
    : `${it.auto
        ? `<button class="btn primary glow" data-bp-emuget="${esc(it.id)}">${icon('download', 15)} Download${size ? ` ${esc(size)}` : ''}</button>`
        : ''}
       ${pageBtn('Open the download page')}`;

  const note = upd
    ? (upd.version
      ? emuStage('A newer build is out: {tag} \u2014 you have {have}.', { tag: upd.latest, have: upd.version })
      : emuStage('A newer build is out: {tag}.', { tag: upd.latest }))
    : (it.blurb || '');

  return `
    <div class="bp-hero-bg bp-hero-flat"></div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner bp-hero-solo">
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${icon(upd ? 'refresh' : 'cpu', 12)} Emulator${it.group ? ` <i class="bp-sep"></i> ${esc(it.group)}` : ''}${upd ? ' <i class="bp-sep"></i> Update ready' : ''}</div>
        <h1 class="bp-h1-news">${esc(it.name)}</h1>
        <div class="bp-meta">${meta}</div>
        <p class="bp-blurb">${esc(note)}</p>
        <div class="bp-actions">${actions}</div>
      </div>
    </div>`;
}

function bpHeroShot(e) {
  const s = e.shot;
  const dims = (s.width && s.height) ? `${s.width} \u00d7 ${s.height}` : '';
  const size = (s.bytes && typeof emuSize === 'function') ? emuSize(s.bytes) : '';
  const meta = [
    s.at ? `<span>${esc(bpDate(s.at))}</span>` : '',
    dims ? `<span>${esc(dims)}</span>` : '',
    size ? `<span>${icon('hardDrive', 13)} ${esc(size)}</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  return `
    <div class="bp-hero-bg bp-hero-flat shot" data-shot-bg="${esc(s.thumb || '')}"></div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner bp-hero-solo">
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${icon('camera', 12)} Screenshot${s.game ? ` <i class="bp-sep"></i> ${esc(s.game)}` : ''}</div>
        <h1 class="bp-h1-news">${esc(s.game || s.name || 'Screenshot')}</h1>
        <div class="bp-meta">${meta}</div>
        <div class="bp-actions">
          <button class="btn primary glow" data-act="shot-open" data-shot="${esc(s.name)}">${icon('image', 15)} Open the full picture</button>
          <button class="btn secondary" data-act="shot-folder">${icon('folder', 15)} Screenshot folder</button>
        </div>
      </div>
    </div>`;
}

function bpHeroTool(e) {
  const it = e.it;
  const bypass = it.kind === 'bypass';
  const required = it.required || [];
  const errors = it.errors || [];

  const meta = [
    `<span>App ${esc(it.appId)}</span>`,
    it.publisher ? `<span>${esc(it.publisher)}</span>` : '',
    required.length ? `<span>${icon('box', 13)} ${required.length} file${required.length === 1 ? '' : 's'} needed</span>` : ''
  ].filter(Boolean).join('<i class="bp-sep"></i>');

  return `
    <div class="bp-hero-bg${it.image ? '' : ' bp-hero-flat'}">
      ${it.image ? `<img class="bp-news-bg" src="${esc(it.image)}" alt="" draggable="false">` : ''}
    </div>
    <div class="bp-hero-veil"></div>
    <div class="bp-hero-inner bp-hero-solo">
      <div class="bp-hero-info">
        <div class="bp-eyebrow">${icon(bypass ? 'shield' : 'globe', 12)} ${esc(bypass ? 'Bypass catalogue' : 'OnlineFix catalogue')}</div>
        <h1 class="bp-h1-news">${esc(it.name)}</h1>
        <div class="bp-meta">${meta}</div>
        ${it.comments ? `<p class="bp-blurb">${esc(it.comments)}</p>` : ''}
        ${errors.length ? `<p class="bp-blurb">${icon('warning', 13)} ${esc(errors[0])}${errors.length > 1 ? ` and ${errors.length - 1} more note${errors.length - 1 === 1 ? '' : 's'}` : ''}</p>` : ''}
        <div class="bp-actions">
          <button class="btn primary glow" data-bp-tool="${esc(it.appId)}" data-kind="${esc(it.kind)}">${icon('info', 15)} Open the fix</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// The two page sections: Profile and Contact
// ---------------------------------------------------------------------------
/** A read-only stat block for the Profile page, in the Big Picture idiom. */
function bpInfoStat(ico, label, value) {
  return `<div class="bp-istat">
    <span class="bp-istat-ico">${icon(ico, 18)}</span>
    <div><strong>${esc(value)}</strong><small>${esc(label)}</small></div>
  </div>`;
}

function bpInfoProfile() {
  const p = State.profile || {};
  const api = (State.settings && State.settings.api) || {};
  const s = (typeof profileStats === 'function') ? profileStats() : null;
  const name = String(p.name || '').trim() || 'Unnamed player';
  const avatar = (typeof avatarMarkup === 'function')
    ? avatarMarkup(84) : `<span class="avatar-img empty">${icon('user', 34)}</span>`;

  const stats = s ? [
    bpInfoStat('library', 'Games installed', String(s.installed)),
    bpInfoStat('trophy', 'Achievements', String(Object.keys(State.achievements || {}).length)),
    bpInfoStat('clock', 'Total play time', fmtPlaytime(s.totalMs)),
    bpInfoStat('camera', 'Screenshots', String(s.screenshots))
  ].join('') : '';

  const top = s && s.top && s.top.game
    ? `<p class="bp-info-note">${icon('trophy', 13)} Most played: <b>${esc(s.top.game.title)}</b> \u00b7 ${esc(fmtPlaytime(s.top.ms))}</p>`
    : '';

  return `
    <div class="bp-info">
      <header class="bp-info-head">
        <span class="bp-info-avatar">${avatar}</span>
        <div>
          <h1>${esc(name)}</h1>
          <p class="bp-info-sub">${api.signedIn && api.email
            ? `Signed in as <b>${esc(api.email)}</b>`
            : 'Local profile \u00b7 no account needed'}</p>
          ${p.bio ? `<p class="bp-info-bio">${esc(p.bio)}</p>` : ''}
        </div>
      </header>
      <div class="bp-istats">${stats}</div>
      ${top}
      <div class="bp-info-actions">
        <button class="btn primary glow" data-bp-info="edit">${icon('edit', 15)} Edit this profile</button>
        <button class="btn secondary" data-bp-info="gallery">${icon('camera', 15)} Screenshots</button>
        ${api.signedIn ? `<button class="btn secondary" data-bp-info="settings">${icon('settings', 15)} Settings</button>` : ''}
      </div>
    </div>`;
}

function bpInfoContact() {
  const channels = (typeof CONTACT_CHANNELS !== 'undefined' && Array.isArray(CONTACT_CHANNELS)) ? CONTACT_CHANNELS : [];
  return `
    <div class="bp-info">
      <header class="bp-info-head">
        <span class="bp-info-avatar mark">${icon('messageSquare', 30)}</span>
        <div>
          <h1>Contact</h1>
          <p class="bp-info-sub">Built and maintained by <b>kudasai</b>. Two ways in, both checked.</p>
          <p class="bp-info-bio">Bug reports, requests, a fix that will not apply, or just to say the thing you
            came here to say. Screenshots and long messages travel better on Telegram.</p>
        </div>
      </header>
      <div class="bp-channels">
        ${channels.map((c) => `
          <article class="bp-channel">
            <span class="bp-channel-mark${c.id === 'discord' ? ' discord' : ' telegram'}">
              <svg viewBox="0 0 24 24" aria-hidden="true">${(typeof CONTACT_MARKS !== 'undefined' && CONTACT_MARKS[c.id]) || ''}</svg>
            </span>
            <div class="bp-channel-text">
              <strong>${esc(c.label)}</strong>
              <span class="bp-channel-handle">${esc(c.handle)}</span>
              <small>${esc(c.blurb || c.hint || '')}</small>
            </div>
            <div class="bp-channel-actions">
              <button class="btn primary" data-bp-copy="${esc(c.handle)}">${icon('link', 15)} Copy</button>
              <button class="btn secondary" data-bp-open="${esc(c.url)}">${icon('external', 15)} Open</button>
            </div>
          </article>`).join('')}
      </div>
      <p class="bp-info-note">${icon('info', 13)} Apex keeps no analytics and no telemetry. The only things it ever
        sends are your account and, if you turn it on, your settings backup.</p>
    </div>`;
}

function bpRenderInfo() {
  const hero = document.getElementById('bp-hero');
  if (!hero) return;
  hero.innerHTML = BP.tab === 'contact' ? bpInfoContact() : bpInfoProfile();
  bpI18n();
}

/** Reads the hero's screenshot at full thumb size, once the panel is on screen. */
function bpHydrateHeroShot(e) {
  const bg = document.querySelector('#bp-hero .bp-hero-bg[data-shot-bg]');
  if (!bg || typeof window.api.readImage !== 'function') return;
  const file = bg.dataset.shotBg;
  if (!file) return;
  Promise.resolve(window.api.readImage(file)).then((url) => {
    if (!url || !bg.isConnected) return;
    bg.innerHTML = `<img class="bp-news-bg shot" src="${esc(url)}" alt="" draggable="false">`;
  }).catch(() => { /* the flat gradient stays */ });
}

function bpRenderHero() {
  const hero = document.getElementById('bp-hero');
  if (!hero) return;

  // Profile and Contact take the hero's slot whole: there is nothing to browse
  // under them, so the hero is allowed to grow into the freed space.
  if (bpIsInfo(BP.tab)) {
    hero.classList.add('bp-hero-page');
    bpRenderInfo();
    return;
  }
  hero.classList.remove('bp-hero-page');

  const e = BP.entries[BP.index];
  if (!e) { hero.innerHTML = bpEmptyHero(); return; }
  let g = null;
  if (e.kind === 'game') { hero.innerHTML = bpHeroGame(e.game); g = e.game; }
  else if (e.kind === 'steam') { hero.innerHTML = bpHeroSteam(e); g = e.game; }
  else if (e.kind === 'itch') { hero.innerHTML = bpHeroItch(e); g = e.game; }
  else if (e.kind === 'nexus') { hero.innerHTML = bpHeroNexus(e); g = e.game; }
  else if (e.kind === 'rom') { hero.innerHTML = bpHeroRom(e); }
  else if (e.kind === 'emulator') { hero.innerHTML = bpHeroEmulator(e); }
  else if (e.kind === 'shot') { hero.innerHTML = bpHeroShot(e); bpHydrateHeroShot(e); }
  else if (e.kind === 'tool') { hero.innerHTML = bpHeroTool(e); }
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

  if (e.kind === 'emulator') {
    const it = e.emulator;
    const upd = e.update || null;
    const job = (typeof emu !== 'undefined' && emu.installs) ? emu.installs[it.id] : null;
    const systems = it.systems || [];
    const sys = systems.slice(0, 2).map((k) => emuSystem(k).label).join(', ') + (systems.length > 2 ? ` +${systems.length - 2}` : '');

    let tag;
    if (job) {
      const pct = Math.max(0, Math.min(100, Math.round(job.pct || 0)));
      tag = `<em class="bp-tag ${job.phase === 'extract' ? '' : 'ok'}">${icon(job.phase === 'extract' ? 'hourglass' : 'download', 11)} ${pct}%</em>`;
    } else if (upd) {
      tag = `<em class="bp-tag ok">${icon('refresh', 11)} Update</em>`;
    } else if (it.installed) {
      tag = `<em class="bp-tag ok">${icon('checkCircle', 11)} Ready</em>`;
    } else if (it.auto) {
      tag = `<em class="bp-tag dim">${icon('download', 11)} Get</em>`;
    } else if (it.page) {
      tag = `<em class="bp-tag dim">${icon('external', 11)} Page</em>`;
    } else {
      tag = '';
    }

    const sub = job ? (job.phase === 'extract' ? 'Unpacking' : 'Downloading')
      : upd ? (upd.version ? `Have ${upd.version}` : 'A newer build is out')
        : it.installed ? (it.version || 'Installed')
          : sys || 'Emulator';

    return `<button class="bp-tile plate${sel}" data-bp="tile" data-idx="${i}" title="${esc(it.name)}">
      <span class="bp-tile-art plate">
        <span class="bp-plate-ext">${icon('cpu', 26)}</span>
        ${tag}
      </span>
      <span class="bp-tile-name">${esc(it.name)}</span>
      <span class="bp-tile-sub">${esc(sub)}</span>
    </button>`;
  }

  if (e.kind === 'rom') {
    const rom = e.rom;
    const target = (typeof emuFor === 'function') ? emuFor(rom.system) : null;
    const sys = (typeof emuSystem === 'function') ? emuSystem(rom.system) : { label: rom.system };
    const ext = (String(rom.name || '').match(/\.[^.]+$/) || [''])[0].slice(1).toUpperCase();
    return `<button class="bp-tile plate${sel}" data-bp="tile" data-idx="${i}" title="${esc(rom.title || rom.name)}">
      <span class="bp-tile-art plate">
        <span class="bp-plate-ext">${esc(ext || 'ROM')}</span>
        <em class="bp-tag ${target ? 'ok' : 'dim'}">${icon(target ? 'gamepad' : 'warning', 11)} ${esc(sys.label || 'Unknown')}</em>
      </span>
      <span class="bp-tile-name">${esc(rom.title || rom.name)}</span>
      <span class="bp-tile-sub">${esc(target ? target.name : 'No emulator set')}</span>
    </button>`;
  }

  if (e.kind === 'shot') {
    const s = e.shot;
    const dims = (s.width && s.height) ? `${s.width}\u00d7${s.height}` : '';
    return `<button class="bp-tile shot${sel}" data-bp="tile" data-idx="${i}" data-thumb="${esc(s.thumb || '')}" title="${esc(bpEntryTitle(e))}">
      <span class="bp-tile-art shot"><span class="bp-shot-mark">${icon('image', 24)}</span></span>
      <span class="bp-tile-name">${esc(s.game || s.name || 'Screenshot')}</span>
      <span class="bp-tile-sub">${esc(bpDate(s.at))}${dims ? ` \u00b7 ${esc(dims)}` : ''}</span>
    </button>`;
  }

  if (e.kind === 'tool') {
    const it = e.it;
    const bypass = it.kind === 'bypass';
    const req = (it.required || []).length;
    const sub = bypass
      ? [it.publisher || '', req ? `${req} file${req === 1 ? '' : 's'}` : ''].filter(Boolean).join(' \u00b7 ') || `App ${it.appId}`
      : `App ${it.appId}`;
    return `<button class="bp-tile plate tool${sel}" data-bp="tile" data-idx="${i}" title="${esc(it.name)}">
      <span class="bp-tile-art plate">
        <span class="bp-plate-ext">${icon(bypass ? 'shield' : 'globe', 26)}</span>
        <em class="bp-tag ${bypass ? 'ok' : 'dim'}">${bypass ? 'Bypass' : 'OnlineFix'}</em>
      </span>
      <span class="bp-tile-name">${esc(it.name)}</span>
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

/**
 * The chooser's contents for whichever section is on screen.
 *
 * Two sections have a second axis worth cutting along: the Library by the
 * storefront a game came from, and Emulators by console family. Both are built
 * from what is actually present, so a storefront with nothing behind it never
 * appears, and a section with a single category gets no row at all.
 *
 * Everything here is deliberately unfiltered: the counts have to describe the
 * whole section, not the slice the chooser has already narrowed it to.
 */
function bpCatList() {
  if (BP.tab === 'library') {
    const counts = new Map();
    for (const g of [...installedGames(), ...preorderedGames()]) {
      const key = typeof platformTag === 'function' ? platformTag(g) : null;
      if (key && PLATFORM_META[key]) counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!counts.size) return [];
    const out = [{ key: 'all', label: t('All'), count: [...counts.values()].reduce((n, v) => n + v, 0) }];
    const sorted = [...counts.entries()]
      .sort((a, b) => PLATFORM_META[a[0]].label.localeCompare(PLATFORM_META[b[0]].label));
    for (const [key, count] of sorted) {
      out.push({ key, label: PLATFORM_META[key].label, ico: PLATFORM_META[key].ico, count });
    }
    return out;
  }

  if (BP.tab === 'emulators') {
    if (typeof emuCatalogView !== 'function') return [];
    const items = bpEmulatorItems();
    const counts = new Map();
    for (const e of items) {
      const group = e.kind === 'emulator'
        ? (e.emulator && e.emulator.group)
        : (typeof emuSystem === 'function' && e.rom ? emuSystem(e.rom.system).group : null);
      if (group) counts.set(group, (counts.get(group) || 0) + 1);
    }
    if (!counts.size) return [];
    const out = [{ key: 'all', label: t('All consoles'), count: items.length }];
    for (const g of EMU_GROUPS) if (counts.has(g)) out.push({ key: g, label: g, count: counts.get(g) });
    return out;
  }

  return [];
}

/** Draws the chooser row, or takes it out of the layout when there is nothing to choose. */
function bpRenderCats() {
  const host = document.getElementById('bp-cats');
  if (!host) return;
  const cats = bpIsInfo(BP.tab) ? [] : bpCatList();
  if (cats.length < 2) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const on = BP.cat[BP.tab] || 'all';
  const label = BP.tab === 'library' ? t('Stores') : t('Consoles');
  host.innerHTML = `<span class="bp-cats-label">${icon('filter', 13)}<span>${esc(label)}</span></span>`
    + cats.map((c) => `<button class="bp-cat${c.key === on ? ' on' : ''}" data-bp="cat" data-cat="${esc(c.key)}">
      ${c.ico ? icon(c.ico, 14) : ''}<span>${esc(c.label)}</span><em>${c.count}</em></button>`).join('');
}

/**
 * Applies a chooser chip and keeps the ring on that chip: the row is one
 * left/right run, so moving along it and pressing again is the whole gesture.
 */
BP.setCat = function (key) {
  if (!key || (BP.cat[BP.tab] || 'all') === key) return;
  BP.cat[BP.tab] = key;
  BP.index = 0;
  bpBuild();
  const chips = [...document.querySelectorAll('#bp-cats [data-cat]')];
  const chip = chips.find((b) => b.dataset.cat === key);
  if (chip) Focus.set(chip, { src: 'bp', sound: false });
  else BP.focusTile();
};

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
  if (bpIsInfo(BP.tab)) {
    const first = document.querySelector('#bp-hero .bp-info-actions .btn, #bp-hero .bp-channel-actions .btn');
    if (first) Focus.set(first, { src: 'bp' });
    return;
  }
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
/**
 * Big Picture's own text, translated after each rebuild.
 *
 * The mode is redrawn piece by piece - tabs, hero, shelf, legend, the power
 * menu, the settings sheet - rather than through one entry point, and the shelf
 * is rebuilt again on every download tick, so each of those ends with this
 * rather than the desktop views' single pass in `render()`.
 */
function bpI18n() {
  if (typeof applyI18n !== 'function') return;
  applyI18n(document.getElementById('bigpic') || document.body);
}

function bpBuild() {
  BP.entries = bpEntries(BP.tab);
  if (BP.index >= BP.entries.length) BP.index = Math.max(0, BP.entries.length - 1);
  bpRenderTabs();
  bpRenderShelf();
  bpRenderCats();
  bpRenderHero();
  bpApplySectionShape();
  bpRenderStatus();
  bpRenderFoot();
  bpI18n();
}

/** Page sections have no shelf, so the shelf block is taken out of the layout. */
function bpApplySectionShape() {
  const wrap = document.getElementById('bp-shelfwrap');
  if (wrap) wrap.hidden = bpIsInfo(BP.tab);
}

/** Re-renders without disturbing the ring — used for live progress updates. */
BP.refresh = function () {
  if (!BP.openFlag) return;
  const hadRing = !!(Focus.el && Focus.el.classList && Focus.el.classList.contains('bp-tile'));
  BP.entries = bpEntries(BP.tab);
  if (BP.index >= BP.entries.length) BP.index = Math.max(0, BP.entries.length - 1);
  bpRenderTabs();
  bpRenderShelf();
  bpRenderCats();
  bpRenderHero();
  bpApplySectionShape();
  bpRenderStatus();
  if (hadRing) BP.focusTile();
  bpI18n();
};

BP.refreshHints = function () {
  bpRenderFoot();
  bpRenderStatus();
  bpI18n();
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

/**
 * The Tools catalogue as shelf entries.
 *
 * Bypass and OnlineFix are two halves of one catalogue and a title can be in
 * both, so they are flattened with the bypass entry winning: it is the one that
 * carries the compatibility notes and the required pieces. Nothing is fetched
 * here - the shelf calls bpEnsureTools() the first time the section is opened.
 */
function bpToolItems() {
  const out = [];
  const seen = new Set();
  const push = (kind, bag) => {
    for (const it of (bag && bag.items) || []) {
      const id = String((it && it.appId) || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...it, kind });
    }
  };
  if (typeof fxBypass !== 'undefined') push('bypass', fxBypass);
  if (typeof fxOnlinefix !== 'undefined') push('onlinefix', fxOnlinefix);
  return out;
}

/**
 * The Emulators section's shelf.
 *
 * It leads with what the user can act on: the emulators Apex downloaded - each
 * one either ready to start or offering a newer build - and then the ROMs
 * already on disk. The rest of the catalogue follows, so a machine with no ROM
 * folders configured yet still has something to browse and something to press,
 * instead of an empty shelf that reads like the section is broken.
 */
function bpEmulatorItems() {
  const out = [];
  if (typeof emuCatalogView !== 'function') return out;
  const shelf = emuCatalogView();
  const updates = (typeof emu !== 'undefined' && emu.updates) ? emu.updates : {};
  const owned = new Set();

  for (const e of shelf) {
    if (!e.installed) continue;
    owned.add(e.id);
    out.push({ kind: 'emulator', key: `e:${e.id}`, id: e.id, emulator: e, installed: true, update: updates[e.id] || null });
  }

  const roms = (typeof emu !== 'undefined' && emu.scan && Array.isArray(emu.scan.roms)) ? emu.scan.roms : [];
  for (const rom of roms) out.push({ kind: 'rom', key: `r:${rom.path}`, id: rom.path, rom });

  for (const e of shelf) {
    if (owned.has(e.id)) continue;
    out.push({ kind: 'emulator', key: `e:${e.id}`, id: e.id, emulator: e, installed: false, update: null });
  }
  return out;
}

/** The emulator behind a shelf entry, for a hero button. */
function bpFindEmulator(id) {
  const e = BP.entries.find((x) => x.kind === 'emulator' && x.id === id);
  return e ? e.emulator : null;
}

/**
 * Starts an installed emulator with no game in it, from Big Picture. The launch
 * itself lives in the Emulators view's own state, so both surfaces share it.
 */
function bpEmuRun(id) {
  SFX.play('select');
  if (typeof emuStart === 'function') { emuStart(id); return; }
  toast('The emulator would not start.', 'warn');
}

/** Downloads, or updates, one catalogue entry from Big Picture. */
function bpEmuGet(id) {
  SFX.play('select');
  if (typeof emuGet !== 'function') return;
  const upd = (typeof emu !== 'undefined' && emu.updates) ? emu.updates[id] : null;
  const name = (bpFindEmulator(id) || {}).name || 'The emulator';
  toast(typeof emuStage === 'function'
    ? emuStage(upd ? 'Updating {name}' : 'Downloading {name}', { name })
    : `${upd ? 'Updating' : 'Downloading'} ${name}`, 'info');
  emuGet(id);
}

/** What double-clicking an emulator tile does: the tile's own headline action. */
function bpEmulatorAct(id) {
  const upd = (typeof emu !== 'undefined' && emu.updates) ? emu.updates[id] : null;
  // An update that was waved away with "Later" stays on the shelf, so the
  // headline action goes back to playing it instead of downloading again.
  const waved = typeof emuSkipUpdate === 'function' && emuSkipUpdate(id);
  if (upd && !waved) { bpEmuGet(id); return; }
  const e = bpFindEmulator(id);
  if (!e) return;
  if (e.installed) { bpEmuRun(id); return; }
  if (e.auto) { bpEmuGet(id); return; }
  // Nothing of Apex's to install and perhaps no page either: play the press and
  // let the hero's description do the talking rather than opening nothing.
  SFX.play('select');
  if (e.page) {
    try { window.api.openExternal(e.page); } catch { /* nothing to do */ }
  }
}

/**
 * Keeps the Emulators shelf honest while an emulator downloads, whichever
 * surface started it. Progress arrives several times a second, so the shelf is
 * only rebuilt when it would actually look different.
 */
let bpEmuPaintAt = 0;
function bpEmuChanged(id) {
  if (typeof BP === 'undefined' || !BP.openFlag || BP.tab !== 'emulators') return;
  const busy = !!(typeof emu !== 'undefined' && emu.installs && emu.installs[id]);
  const now = Date.now();
  if (busy && now - bpEmuPaintAt < 400) return;
  bpEmuPaintAt = now;
  BP.refresh();
}

/**
 * Big Picture's Emulators shelf is the ROM scan the Emulators view already knows
 * how to run, plus the catalogue behind it. Nothing is rescanned once a scan
 * exists, so moving between sections never walks the disk again; the view's own
 * refresh button is still the way to ask for a fresh look.
 */
function bpEnsureEmulators() {
  if (BP.tab !== 'emulators') return;
  if (typeof emu === 'undefined' || typeof emuRefresh !== 'function') return;
  if (emu.scan && emu.systems && emu.map && emu.catalog) return;
  emuLoadState();
  Promise.resolve(emuRefresh(null, { detect: true })).then(() => {
    if (BP.isOpen() && BP.tab === 'emulators') { bpBuild(); BP.focusTile(); }
  }).catch(() => { /* the shelf explains there is nothing to show */ });
}

/**
 * Big Picture's Gallery shelf reads the same screenshot list the Gallery view
 * keeps in `galleryShots`, and writes it back, so visiting either one warms the
 * other.
 */
function bpEnsureGallery() {
  if (BP.tab !== 'gallery') return;
  if (typeof galleryShots !== 'undefined' && galleryShots) { bpHydrateShotTiles(); return; }
  Promise.resolve(window.api.shotsList()).then((res) => {
    galleryShots = res || { shots: [] };
    if (BP.isOpen() && BP.tab === 'gallery') { bpBuild(); BP.focusTile(); bpHydrateShotTiles(); }
  }).catch(() => {
    galleryShots = { shots: [] };
    if (BP.isOpen() && BP.tab === 'gallery') { bpBuild(); BP.focusTile(); }
  });
}

/** Big Picture's Tools shelf reads the catalogue the Tools view loads. */
function bpEnsureTools() {
  if (BP.tab !== 'tools') return;
  if (typeof fxLoadCatalog !== 'function') return;
  if (fxBypass && fxOnlinefix) return;
  Promise.resolve()
    .then(() => fxLoadCatalog('bypass'))
    .then(() => fxLoadCatalog('onlinefix'))
    .then(() => {
      if (BP.isOpen() && BP.tab === 'tools') { bpBuild(); BP.focusTile(); }
    })
    .catch(() => { /* the shelf explains there is nothing to show */ });
}

/** Reads the first screenful of screenshot thumbnails, one file at a time. */
function bpHydrateShotTiles() {
  const tiles = document.querySelectorAll('#bp-shelf .bp-tile.shot');
  if (!tiles.length || typeof window.api.readImage !== 'function') return;
  const first = Math.min(tiles.length, 12);
  for (let i = 0; i < first; i += 1) {
    const tile = tiles[i];
    const file = tile.dataset.thumb;
    if (!file) continue;
    const slot = tile.querySelector('.bp-tile-art');
    Promise.resolve(window.api.readImage(file)).then((url) => {
      if (!url || !slot || !slot.isConnected) return;
      slot.innerHTML = `<img src="${esc(url)}" alt="" draggable="false">`;
    }).catch(() => { /* the placeholder mark stays */ });
  }
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
  bpEnsureEmulators();
  bpEnsureGallery();
  bpEnsureTools();
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
        <span class="bp-power-logo">${icon('apexMark', 20)}</span>
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
  bpI18n();
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
  bpI18n();
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
  bpEnsureEmulators();
  bpEnsureGallery();
  bpEnsureTools();

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

    const cat = e.target.closest('[data-bp="cat"]');
    if (cat) { SFX.play('tab'); BP.setCat(cat.dataset.cat); return; }

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

    // A ROM: the same launch the Emulators view performs, with the same manual
    // overrides, so the two surfaces can never disagree about which binary a
    // console belongs to.
    const rom = e.target.closest('[data-bp-rom]');
    if (rom) { SFX.play('select'); bpLaunchRom(rom.dataset.bpRom, rom.dataset.path); return; }

    // The Emulators shelf: starting one, taking the newer build it is offering,
    // and opening the project's own page all go through the same functions the
    // Emulators view uses.
    const emuRun = e.target.closest('[data-bp-emurun]');
    if (emuRun) { bpEmuRun(emuRun.dataset.bpEmurun); return; }

    const emuGet = e.target.closest('[data-bp-emuget]');
    if (emuGet) { bpEmuGet(emuGet.dataset.bpEmuget); return; }

    const emuPage = e.target.closest('[data-bp-emupage]');
    if (emuPage) {
      SFX.play('select');
      try { window.api.openExternal(emuPage.dataset.bpEmupage); } catch { /* nothing to do */ }
      return;
    }

    const reveal = e.target.closest('[data-bp-reveal]');
    if (reveal) {
      SFX.play('select');
      try { window.api.openPath(reveal.dataset.bpReveal); } catch { /* nothing to do */ }
      return;
    }

    // The Tools hero opens the same info dialog the Tools page does, which is
    // the only place that knows where the fix files come from.
    const tool = e.target.closest('[data-bp-tool]');
    if (tool) {
      SFX.play('select');
      const it = bpToolItems().find((x) =>
        String(x.appId) === String(tool.dataset.bpTool) && x.kind === tool.dataset.kind);
      if (it && typeof fxOpenInfo === 'function') fxOpenInfo(it, it.kind);
      else toast('That entry is not in the catalogue any more', 'warn');
      return;
    }

    const infoAct = e.target.closest('[data-bp-info]');
    if (infoAct) { bpInfoAct(infoAct.dataset.bpInfo); return; }

    const copy = e.target.closest('[data-bp-copy]');
    if (copy) {
      SFX.play('select');
      const text = copy.dataset.bpCopy;
      Promise.resolve(copyHandle(text)).then((ok) => {
        toast(ok ? `${text} copied` : `Copy it by hand: ${text}`, ok ? 'check' : 'warn');
      }).catch(() => toast(`Copy it by hand: ${text}`, 'warn'));
      return;
    }

    const open = e.target.closest('[data-bp-open]');
    if (open) {
      SFX.play('select');
      try { window.api.openExternal(open.dataset.bpOpen); } catch { /* nothing to do */ }
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

/** Launches a ROM in its emulator, exactly as the Emulators page does. */
async function bpLaunchRom(system, path) {
  if (!system || !path) return;
  if (typeof emu === 'undefined' || typeof window.api.emuLaunch !== 'function') return;
  bpLaunchFx();
  const res = await window.api.emuLaunch(system, path, { overrides: emu.exes });
  if (!res || !res.ok) {
    toast((res && res.error) || 'The emulator would not start.', 'warn');
    return;
  }
  toast(`${res.title} \u2192 ${res.emulator}`, 'check');
}

/** The buttons on the Profile and Contact pages. */
function bpInfoAct(what) {
  SFX.play('select');
  if (what === 'edit') {
    if (typeof openProfileEditor === 'function') openProfileEditor();
    return;
  }
  if (what === 'gallery') { BP.setTab('gallery'); return; }
  if (what === 'settings') {
    // Settings is a full page, not an overlay, so leave Big Picture the way the
    // Resume button does.
    BP.exit();
    if (typeof gotoView === 'function') gotoView('settings');
    return;
  }
}

/** Opens one screenshot in the OS viewer, the same path the Gallery uses. */
async function bpOpenShot(name) {
  if (!name || typeof shotFullPath !== 'function') return;
  const full = await shotFullPath(name);
  if (!full) { toast('That screenshot is no longer on disk', 'warn'); return; }
  try { await window.api.openPath(full); } catch { /* nothing to do */ }
}

/** Performs the primary action of one shelf entry (used by double-click). */
function bpActivateIndex(i) {
  const e = BP.entries[i];
  if (!e) return;
  if (e.kind === 'steam') { openStorePreview(e.it.appId); return; }
  if (e.kind === 'itch') { itchOpenDialog(e.it); return; }
  if (e.kind === 'nexus') { ltOpenDialog(e.it); return; }
  if (e.kind === 'rom') { bpLaunchRom(e.rom.system, e.rom.path); return; }
  if (e.kind === 'emulator') { bpEmulatorAct(e.id); return; }
  if (e.kind === 'tool') {
    if (typeof fxOpenInfo === 'function') fxOpenInfo(e.it, e.it.kind);
    return;
  }
  if (e.kind === 'shot') { bpOpenShot(e.shot.name); return; }
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
