'use strict';

/**
 * Unified search.
 *
 * One query, every source the launcher already knows about:
 *   - the titles in the user's own library
 *   - the curated Steam catalogue that powers the Store tab
 *   - the itch.io list the itch.io tab has loaded
 *   - live matches from the real Steam storefront and from itch.io
 *
 * Typing filters the already-loaded lists instantly (real time, no network);
 * once the query is long enough the live stores are queried too, debounced so
 * a fast typist never hammers either endpoint.
 *
 * It reuses the same card renderers as the Store and itch.io views
 * (`storeCard`, `liveCard`, `itchCard`) so a result looks identical wherever it
 * appears and every click still lands in the existing delegated handlers.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let uniQuery = '';              // live text in the title-bar box
let uniSteam = [];              // live Steam storefront results
let uniItch = [];               // live itch.io results
let uniBusy = { steam: false, itch: false };
let uniError = { steam: null, itch: null };
let uniTimer = null;
let uniFor = '';                // the query the live results belong to
let uniItchAll = [];            // every itch card painted right now (for clicks)

const UNI_MIN = 2;              // below this, only the local lists are filtered

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
/** One lower-cased haystack for a game or an itch item. */
function uniText(x) {
  return [x.title, x.developer, x.author, x.genre, x.release, ...(x.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Loose, case-insensitive match by title (and the usual metadata). */
function uniMatch(x, q) {
  return !q || uniText(x).includes(q);
}

// ---------------------------------------------------------------------------
// Local pools (no network)
// ---------------------------------------------------------------------------
/** The itch.io tab's currently loaded list, already in itch-item shape. */
function uniItchLoaded() {
  return Array.isArray(itchItems) ? itchItems.slice() : [];
}

/** A library game presented as an itch item, so `itchCard` can draw it. */
function uniGameToItch(g) {
  return {
    id: g.id,
    title: g.title,
    author: g.developer || (g.itch && g.itch.author) || 'itch.io',
    tags: (g.tags || []).filter((t) => !/^itch\.io$/i.test(t)),
    cover: g.cover || (g.itch && g.itch.cover) || null,
    price: g.price || 'Free',
    platforms: {},
    demo: false,
    url: (g.itch && g.itch.url) || null,
    blurb: g.blurb || null
  };
}

/** Library titles that came from itch.io, in itch-item shape. */
function uniItchLibrary() {
  return allGames()
    .filter((g) => g && (g.platform === 'itch' || g.itch || /^itch:/.test(g.id || '')))
    .map(uniGameToItch);
}

/**
 * Everything already on the machine that matches `q`, split by source:
 *   - `library` the installed titles
 *   - `steam`   the curated Store catalogue (Steam)
 *   - `itch`    the loaded itch.io list plus itch titles in the library
 */
function uniLocal(q) {
  const library = allGames().filter((g) => isInstalled(g.id) && uniMatch(g, q));
  const steam = storeGames().filter((g) => uniMatch(g, q));

  const itch = [];
  const seen = new Set();
  for (const it of [...uniItchLoaded(), ...uniItchLibrary()]) {
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    // Installed titles already show under "In your library".
    if (isInstalled(it.id)) continue;
    if (uniMatch(it, q)) itch.push(it);
  }
  return { library, steam, itch };
}

// ---------------------------------------------------------------------------
// Live storefront search (Steam + itch.io)
// ---------------------------------------------------------------------------
function uniReset() {
  uniSteam = [];
  uniItch = [];
  uniError = { steam: null, itch: null };
  uniBusy = { steam: false, itch: false };
  uniFor = '';
}

/** Debounced: fires the live Steam and itch.io lookups once typing settles. */
function queueUnified(q) {
  clearTimeout(uniTimer);
  const term = String(q || '').trim();
  if (term.length < UNI_MIN) { uniReset(); paintSearch(content); return; }

  uniFor = term;
  uniError = { steam: null, itch: null };
  uniBusy = { steam: true, itch: true };
  paintSearch(content);
  uniTimer = setTimeout(() => runUnified(term), 340);
}

async function runUnified(term) {
  const guard = (p) => p.catch((err) => ({ ok: false, error: String((err && err.message) || err) }));

  const steamP = window.api && window.api.storeSearch
    ? guard(window.api.storeSearch(term))
    : Promise.resolve({ ok: true, items: [] });
  const itchP = window.api && window.api.itchSearch
    ? guard(window.api.itchSearch(term))
    : Promise.resolve({ ok: true, items: [] });

  const [steamRes, itchRes] = await Promise.all([steamP, itchP]);

  // A newer keystroke has already superseded this request.
  if (uniFor !== term) return;

  uniBusy = { steam: false, itch: false };

  if (steamRes && steamRes.ok) { uniSteam = steamRes.items || []; uniError.steam = null; }
  else { uniSteam = []; uniError.steam = (steamRes && steamRes.error) || 'Search failed'; }

  if (itchRes && itchRes.ok) { uniItch = itchRes.items || []; uniError.itch = null; }
  else { uniItch = []; uniError.itch = (itchRes && itchRes.error) || 'Search failed'; }

  if (current === 'search') paintSearch(content);
}

/** Lets the itch.io click handler open a card the unified view painted. */
function uniItchFind(id) {
  return uniItchAll.find((it) => it.id === id) || null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function uniSection(ico, title, note, inner) {
  return `<section class="store-section">
    <div class="section-head">
      <h2 class="section-title">${icon(ico, 20)} ${title}</h2>
      ${note ? `<span class="section-note">${note}</span>` : ''}
    </div>
    ${inner}
  </section>`;
}

function uniStatus(ico, title, kind, text) {
  const glyph = kind === 'loading' ? 'refresh' : kind === 'warn' ? 'warning' : 'search';
  return uniSection(ico, title, '',
    `<div class="live-status${kind === 'warn' ? ' warn' : ''}">${icon(glyph, 15)} ${text}</div>`);
}

/** The Steam block: live results, else a busy/empty/error status. */
function uniSteamSection(live) {
  const q = esc(uniQuery.trim());
  if (uniBusy.steam) return uniStatus('globe', 'Steam store', 'loading', `Searching the Steam store for \u201c${q}\u201d\u2026`);
  if (uniError.steam) return uniStatus('globe', 'Steam store', 'warn', `Could not reach the Steam store (${esc(uniError.steam)}).`);
  if (live.length) {
    return uniSection('globe', 'Steam store',
      `${live.length} live result${live.length === 1 ? '' : 's'} \u00b7 real AppIDs &amp; prices`,
      `<div class="live-grid">${live.map(liveCard).join('')}</div>`);
  }
  if (uniQuery.trim().length >= UNI_MIN) return uniStatus('globe', 'Steam store', 'empty', `No Steam titles match \u201c${q}\u201d.`);
  return '';
}

/** The itch.io block: live + loaded results, else a busy/empty/error status. */
function uniItchSection(list) {
  const q = esc(uniQuery.trim());
  if (list.length) {
    return uniSection('flame', 'itch.io',
      `${list.length} title${list.length === 1 ? '' : 's'}`,
      `<div class="grid itch-grid">${list.map(itchCard).join('')}</div>`);
  }
  if (uniBusy.itch) return uniStatus('flame', 'itch.io', 'loading', `Searching itch.io for \u201c${q}\u201d\u2026`);
  if (uniError.itch) return uniStatus('flame', 'itch.io', 'warn', `Could not reach itch.io (${esc(uniError.itch)}).`);
  if (uniQuery.trim().length >= UNI_MIN) return uniStatus('flame', 'itch.io', 'empty', `No itch.io titles match \u201c${q}\u201d.`);
  return '';
}

/**
 * Re-renders just the results column. Called on every keystroke, so it never
 * touches the page chrome above it.
 */
function paintSearch(el) {
  const box = el.querySelector('#uni-results');
  if (!box) return;

  const q = uniQuery.trim().toLowerCase();
  uniItchAll = [];

  if (!q) {
    box.innerHTML = `
      <div class="empty show big">
        ${icon('search', 40)}
        <h3>Search every store at once</h3>
        <p>Type a title in the box at the top of the window. Apex looks through
        your library, the Steam catalogue and the itch.io list you have loaded \u2014
        then the live Steam and itch.io storefronts too.</p>
      </div>`;
    return;
  }

  const local = uniLocal(q);

  // itch cards from both the local pools and the live search, de-duplicated.
  const seenItch = new Set();
  for (const it of [...local.itch, ...uniItch]) {
    if (!it || seenItch.has(it.id)) continue;
    seenItch.add(it.id);
    uniItchAll.push(it);
  }

  // Live Steam rows that the curated catalogue is not already showing.
  const shownApps = new Set(local.steam.map((g) => String(g.steamAppId || '')).filter(Boolean));
  const liveSteam = uniSteam.filter((it) => !shownApps.has(String(it.appId)));

  const parts = [];

  if (local.library.length) {
    parts.push(uniSection('library', 'In your library',
      `${local.library.length} title${local.library.length === 1 ? '' : 's'}`,
      `<div class="grid">${local.library.map((g) => storeCard(g)).join('')}</div>`));
  }

  if (local.steam.length) {
    parts.push(uniSection('store', 'Steam catalogue',
      `${local.steam.length} title${local.steam.length === 1 ? '' : 's'} from the Apex catalogue`,
      `<div class="grid">${local.steam.map((g) => storeCard(g)).join('')}</div>`));
  }

  const steamBlock = uniSteamSection(liveSteam);
  if (steamBlock) parts.push(steamBlock);

  const itchBlock = uniItchSection(uniItchAll);
  if (itchBlock) parts.push(itchBlock);

  if (!parts.length) {
    const busy = uniBusy.steam || uniBusy.itch;
    box.innerHTML = `
      <div class="empty show big">
        ${icon('search', 40)}
        <h3>${busy ? 'Searching\u2026' : 'No matches'}</h3>
        <p>${busy
          ? 'Asking the Steam store and itch.io\u2026'
          : `Nothing in your library, the Steam catalogue or itch.io matched \u201c${esc(uniQuery.trim())}\u201d.`}</p>
      </div>`;
    return;
  }

  box.innerHTML = parts.join('');
}

/** The unified results page. Registered in VIEWS as `search`. */
function renderSearch(el) {
  // The Store's hero carousel shares this timer; it must not keep ticking here.
  clearInterval(slideTimer);

  const q = uniQuery.trim();
  el.innerHTML = `
    <h1 class="page-title">${icon('search', 24)} Search</h1>
    <div class="page-intro">
      <p>${q
        ? `Your library, the Steam store and itch.io, searched for <b>\u201c${esc(q)}\u201d</b>.`
        : 'One query across the Steam store, itch.io and your library. Type in the box at the top of the window.'}</p>
    </div>
    <div id="uni-results"></div>`;

  paintSearch(el);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function uniClear() {
  uniQuery = '';
  uniReset();
  const input = document.getElementById('global-search');
  if (input) input.value = '';
}

const uniInput = document.getElementById('global-search');
if (uniInput) {
  uniInput.addEventListener('input', () => {
    uniQuery = uniInput.value;
    // First keystroke opens the results view; after that only the column repaints.
    if (current !== 'search') gotoView('search');
    else paintSearch(content);
    queueUnified(uniQuery);
  });

  uniInput.addEventListener('keydown', (e) => {
    // Escape clears the query here instead of unwinding a whole view.
    if (e.key === 'Escape') { e.stopPropagation(); uniClear(); }
  });
}

// Leaving the results view (any sidebar tab) drops the query, so the title bar
// never shows a stale term over an unrelated page.
document.querySelectorAll('#sidebar .tab').forEach((t) => t.addEventListener('click', () => {
  if (uniQuery) uniClear();
}));
