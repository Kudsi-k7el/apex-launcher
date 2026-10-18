'use strict';

/**
 * Shared renderer helpers: artwork, toasts, status/resolution logic and the
 * reusable action-button markup used by every view.
 */

const running = {}; // id -> true while a game is "running"

const grad = (c) => `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
const TOAST_ICON = { info: 'info', check: 'checkCircle', warn: 'warning', download: 'download' };

function toast(msg, type = 'info') {
  if (State.settings.notifications === false) return;
  const t = document.getElementById('toast');
  t.innerHTML = `${icon(TOAST_ICON[type] || 'info', 16)}<span>${esc(msg)}</span>`;
  t.dataset.type = type;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------------
// Artwork (remote art with an intelligent typographic fallback banner)
// ---------------------------------------------------------------------------
/**
 * Steam publishes several sizes of the same image on its CDN, but newer AppIDs
 * often only carry some of them (a `header.jpg` 404 is common for anything
 * added recently). Listing them all means a title can still show real art.
 */
function steamArtChain(appId, kind = 'cover') {
  const id = String(appId || '').replace(/[^0-9]/g, '');
  if (!id) return [];
  const cdn = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
  const portrait = `${cdn}${id}/library_600x900.jpg`;
  const header = `${cdn}${id}/header.jpg`;
  const hero = `${cdn}${id}/library_hero.jpg`;
  const cap616 = `${cdn}${id}/capsule_616x353.jpg`;
  const cap231 = `${cdn}${id}/capsule_231x87.jpg`;
  // A portrait slot wants the portrait cover first; a wide slot (the detected
  // game list, the live search row, a header) wants the landscape art first.
  return kind === 'cover'
    ? [portrait, header, hero, cap616, cap231]
    : [header, hero, cap616, portrait, cap231];
}

/**
 * The ordered list of image URLs to try for one art slot.
 *
 * Order matters: the user's own picture, then art fetched from the web, then
 * the game's declared art for this slot, the portrait cover, the store search
 * thumbnail, and finally every Steam CDN size. The renderer walks the list, so
 * one broken URL no longer means a placeholder card.
 */
function artCandidates(g, kind = 'cover') {
  if (!g) return [];
  const out = [];
  const push = (url) => {
    if (typeof url === 'string' && url && !out.includes(url)) out.push(url);
  };

  push(State.art && State.art[g.id]);                     // user's custom art
  const known = (typeof knownArt === 'function') ? knownArt(g) : null;
  if (known) { push(known[kind]); push(known.cover); }
  push((State.artAuto && State.artAuto[g.id]) || null);   // art resolved from the web
  push(g[kind]);
  push(g.cover);
  if (kind !== 'wide') push(g.wide);
  if (kind !== 'hero') push(g.hero);
  push(g.tinyImage);                                      // live store search thumb
  if (g.steamAppId) steamArtChain(g.steamAppId, kind).forEach(push);
  return out;
}

function art(g, kind = 'cover') {
  const srcs = artCandidates(g, kind);
  const alts = srcs.slice(1);
  // `contain` is for titles whose art is a wordmark rather than a full-bleed
  // key visual: it is centred over the banner instead of being cropped.
  const fit = g.artContain ? ' contain' : '';
  return `<div class="art" data-art-id="${esc(g.id)}" style="${bannerStyle(g)}">
    ${bannerMarkup(g, kind)}
    ${srcs.length
      ? `<img class="${fit.trim()}" src="${esc(srcs[0])}"${alts.length ? ` data-alt="${esc(alts.join('|'))}"` : ''} alt="${esc(g.title)}" loading="lazy" draggable="false">`
      : ''}
  </div>`;
}

// Remote art can 404 (or be offline). When an <img> fails we try the next URL
// on its `data-alt` list; once the list is empty we drop the image so the
// generated typographic banner underneath shows through. Game logos are the
// opposite: the text wordmark shows first and the image replaces it only once
// it has actually decoded.
window.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;

  // Art Apex resolved online is the last resort. If even that fails, drop it
  // and let the generated banner show rather than retrying for ever.
  if (img.dataset && img.dataset.artAuto) { img.remove(); return; }

  const alts = img.dataset && img.dataset.alt ? img.dataset.alt.split('|') : [];
  if (alts.length) {
    const next = alts.shift();
    img.dataset.alt = alts.join('|');
    img.src = next;
    return;
  }

  // Every URL in this card's own chain failed — fall back to whatever Apex
  // managed to look up online for this title, if anything.
  const box = img.closest ? img.closest('.art[data-art-id]') : null;
  const id = box && box.dataset.artId;
  img.remove();
  if (id && typeof paintResolvedArt === 'function') paintResolvedArt(id);
}, true);

window.addEventListener('load', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG' || !t.classList) return;
  if (!t.classList.contains('dt-logo') && !t.classList.contains('bp-logo')) return;
  const wrap = t.closest('.dt-logo-wrap, .bp-logo-wrap');
  if (wrap) wrap.classList.add('has-logo');
}, true);

// ---------------------------------------------------------------------------
// Artwork looked up online
// ---------------------------------------------------------------------------
// A few titles genuinely ship no artwork of their own: the user's own custom
// entries, and games that live only on Epic/Riot's stores. For those Apex asks
// the main process for a banner once (see coverart.js), remembers it in
// `State.artAuto` and drops it straight into whatever is on screen. The user's
// own picture always wins, and no title is ever looked up twice in a session.
const artAsked = new Set();

/** True when a game declares artwork of its own (so it needs no lookup). */
function declaredArt(g) {
  return !!(g.cover || g.wide || g.hero || g.tinyImage
    || (typeof knownArt === 'function' && knownArt(g)));
}

function needsArt(g) {
  return !!g && !declaredArt(g) && !(State.art && State.art[g.id]);
}

function artSpec(g) {
  return {
    id: g.id,
    name: g.title,
    appId: g.steamAppId || null,
    url: g.officialUrl || null,
    wiki: g.wiki || null
  };
}

/** Inserts freshly resolved art into any card already on screen. */
function paintResolvedArt(id) {
  const url = State.artAuto && State.artAuto[id];
  if (!url) return;
  document.querySelectorAll(`.art[data-art-id="${id}"]`).forEach((box) => {
    if (box.querySelector('img')) return; // it already has real art
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    // Marked so a failure here ends the chain instead of looping back into it.
    img.dataset.artAuto = '1';
    box.appendChild(img);
  });
}

/**
 * Looks up banner art for any of `games` that has none.
 * Resolves at most four at a time so a large custom library cannot flood the
 * network, and reports how many titles it managed to dress.
 */
async function ensureArt(games) {
  if (!window.api || !window.api.resolveArt) return 0;
  State.artAuto = State.artAuto || {};

  const queue = (games || []).filter((g) => g && !artAsked.has(g.id) && needsArt(g));
  queue.forEach((g) => artAsked.add(g.id));
  if (!queue.length) return 0;

  let found = 0;
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const g = queue.shift();
      if (!g) return;
      let res = null;
      try { res = await window.api.resolveArt(artSpec(g)); } catch { res = null; }
      if (res && res.ok && res.url) {
        State.artAuto[g.id] = res.url;
        found++;
        paintResolvedArt(g.id);
      }
    }
  });
  await Promise.all(workers);

  if (found) await persist();
  return found;
}

// ---------------------------------------------------------------------------
// Transparent hero wordmarks
// ---------------------------------------------------------------------------
// Same idea as the banner lookup above, one layer up: the detail hero shows a
// game's official transparent wordmark instead of printing its name as text.
// Titles that ship no logo of their own get one looked up once (see
// logoart.js), remembered in `State.logoAuto`, and dropped into the hero.
// A title with no wordmark anywhere just keeps its typed <h1>.
const logoAsked = new Set();

/** A catalogue entry that already carries a logo needs no lookup. */
function declaredLogo(g) {
  return !!(g && g.logo);
}

function needsLogo(g) {
  return !!g && !declaredLogo(g) && !(State.logoAuto && State.logoAuto[g.id]);
}

function logoSpec(g) {
  return {
    id: g.id,
    name: g.title,
    appId: g.steamAppId || null,
    logo: g.logo || null
  };
}

/** Fills the hero's logo slot wherever this game happens to be on screen. */
function paintResolvedLogo(id) {
  const url = State.logoAuto && State.logoAuto[id];
  if (!url) return;
  // The detail hero and the Big Picture hero both carry a logo slot, so this
  // matches on the shared data attribute rather than one view's class.
  document.querySelectorAll(`[data-logo-id="${id}"]`).forEach((img) => {
    if (img.getAttribute('src')) return; // it already has one
    img.src = url;
    // A cached image decodes before the load listener can see it.
    if (img.complete && img.naturalWidth > 0) {
      const wrap = img.closest('.dt-logo-wrap, .bp-logo-wrap');
      if (wrap) wrap.classList.add('has-logo');
    }
  });
}

/**
 * Looks up transparent wordmarks for any of `games` that lack one. Resolves at
 * most three at a time and reports how many titles it managed to dress.
 */
async function ensureLogos(games) {
  if (!window.api || !window.api.resolveLogo) return 0;
  State.logoAuto = State.logoAuto || {};

  const queue = (games || []).filter((g) => g && !logoAsked.has(g.id) && needsLogo(g));
  queue.forEach((g) => logoAsked.add(g.id));
  if (!queue.length) return 0;

  let found = 0;
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (;;) {
      const g = queue.shift();
      if (!g) return;
      let res = null;
      try { res = await window.api.resolveLogo(logoSpec(g)); } catch { res = null; }
      if (res && res.ok && res.url) {
        State.logoAuto[g.id] = res.url;
        found++;
        paintResolvedLogo(g.id);
      }
    }
  });
  await Promise.all(workers);

  if (found) await persist();
  return found;
}

// ---------------------------------------------------------------------------
// Status / ownership
// ---------------------------------------------------------------------------
// `installed` decides Library vs Store; `owned` decides whether the Store is
// allowed to offer the game at all. Nothing can be downloaded unless it was
// found in the local Steam licence list, an Epic manifest, or on disk.
function owned(id) { return isOwned(id); }

function statusOf(id) {
  if (DL[id]) return 'downloading';
  if (running[id]) return 'running';
  if (isInstalled(id)) return State.updates[id] ? 'update' : 'play';
  if (isOwned(id)) return 'notinstalled'; // owned here, just not downloaded
  return 'unowned';                       // not owned -> locked
}

const STATUS_LABEL = {
  downloading: 'Downloading', running: 'Running', unowned: 'Not Owned',
  notinstalled: 'Not installed', update: 'Update Available', play: 'Installed'
};

const priceTag = (g) => (isFree(g) ? 'Free to Play' : g.price);

// ---------------------------------------------------------------------------
// Console availability
// ---------------------------------------------------------------------------
/**
 * The two current-gen platform marks Apex knows how to draw. The data behind
 * them is the hand-curated CONSOLES table in data.js, so a badge only appears
 * when the console release genuinely exists.
 */
const CONSOLE_META = {
  ps5: { label: 'PS5', full: 'PlayStation 5' },
  xbox: { label: 'Xbox Series X|S', full: 'Xbox Series X|S' }
};

/** "Available on" pills for whichever consoles a title really is on. */
function consoleBadges(g) {
  const list = (g && g.consoles) || [];
  if (!list.length) return '';
  return `<span class="c-badges">${list.map((key) => {
    const m = CONSOLE_META[key];
    if (!m) return '';
    return `<span class="cpill ${key}" title="Available on ${esc(m.full)}">${icon(key, 13)}<b>${esc(m.label)}</b></span>`;
  }).join('')}</span>`;
}

// ---------------------------------------------------------------------------
// Release countdowns
// ---------------------------------------------------------------------------
/** Local midnight on an ISO day, as a timestamp (or null when unusable). */
function releaseAt(iso) {
  if (!iso) return null;
  const t = new Date(`${iso}T00:00:00`).getTime();
  return isNaN(t) ? null : t;
}

/** "34d 06:12:45" until release, "06:12:45" on the final day, else "Out now". */
function countdownText(iso) {
  const target = releaseAt(iso);
  if (target == null) return '';
  const left = Math.floor((target - Date.now()) / 1000);
  if (left <= 0) return 'Out now';
  const d = Math.floor(left / 86400);
  const h = String(Math.floor((left % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
  const s = String(left % 60).padStart(2, '0');
  return d > 0 ? `${d}d ${h}:${m}:${s}` : `${h}:${m}:${s}`;
}

/**
 * A live countdown chip. It carries the ISO date in `data-countdown`, and the
 * shared ticker updates the text once a second — so a countdown is never a
 * static snapshot, and no page has to re-render to keep it moving.
 */
function countdownHtml(iso, opts = {}) {
  if (releaseAt(iso) == null) return '';
  const txt = countdownText(iso);
  return `<span class="cd${opts.big ? ' big' : ''}${txt === 'Out now' ? ' out' : ''}" data-countdown="${esc(iso)}" title="Time until release day">${icon('hourglass', opts.big ? 14 : 12)}<b>${esc(txt)}</b></span>`;
}

let cdTimer = null;

function tickCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const txt = countdownText(el.dataset.countdown);
    const b = el.querySelector('b') || el;
    if (b.textContent !== txt) b.textContent = txt;
    el.classList.toggle('out', txt === 'Out now');
  });
}

/** One shared one-second ticker drives every countdown currently on screen. */
function startCountdowns() {
  if (cdTimer) return;
  tickCountdowns();
  cdTimer = setInterval(tickCountdowns, 1000);
}

// ---------------------------------------------------------------------------
// Local install links (real executables / launcher URIs)
// ---------------------------------------------------------------------------
const SOURCE_LABEL = { steam: 'Steam', epic: 'Epic', gog: 'GOG', ubisoft: 'Ubisoft', ea: 'EA App', battlenet: 'Battle.net', xbox: 'Xbox', exe: 'Local EXE', uri: 'Link', local: 'Local' };

function localLink(id) {
  const installs = State.local && State.local.installs;
  return (installs && installs[id]) || null;
}

/**
 * The target handed to the main process when launching: whatever this PC has
 * linked for the game (a store URI, a detected executable or a manual link),
 * tagged with the id/name so the process registry can track it.
 */
function launchTarget(id) {
  const g = byId(id) || {};
  const link = localLink(id);
  // The id/name travel with the target so the main process can register the
  // spawned process and stop it again from the renderer.
  return link ? { ...link, id, name: g.title } : null;
}

function sourceTag(id) {
  const t = localLink(id);
  if (!t) return '';
  const label = SOURCE_LABEL[t.type] || 'Linked';
  const ico = t.source === 'steam' || t.type === 'steam' ? 'gamepad'
    : t.type === 'uri' ? 'globe'
    : t.type === 'exe' ? 'cpu'
    : 'globe';
  const where = t.path || t.exe || t.name || '';
  return `<span class="src-tag" title="${esc(where)}">${icon(ico, 12)} ${label}</span>`;
}

function pill(id) {
  const st = statusOf(id);
  return `<span class="pill ${st}" data-status="${id}">${STATUS_LABEL[st]}</span>`;
}

// ---------------------------------------------------------------------------
// Platform badges
// ---------------------------------------------------------------------------
/**
 * Where a title actually comes from, as a small chip on its card.
 *
 * This is deliberately separate from `sourceTag` above: `sourceTag` says how
 * Apex will *launch* an installed game (a Steam URI, a linked EXE), while this
 * says which storefront *published* it. Catalogue titles carry a Steam AppID or
 * an Epic app name; anything brought in from itch.io carries an `itch` record;
 * a game the user added by hand is simply "Local".
 */
const PLATFORM_META = {
  steam: { label: 'Steam', ico: 'gamepad' },
  itch: { label: 'itch.io', ico: 'flame' },
  epic: { label: 'Epic', ico: 'globe' },
  gog: { label: 'GOG', ico: 'globe' },
  ubisoft: { label: 'Ubisoft', ico: 'globe' },
  ea: { label: 'EA App', ico: 'globe' },
  battlenet: { label: 'Battle.net', ico: 'globe' },
  xbox: { label: 'Microsoft', ico: 'box' },
  local: { label: 'Local', ico: 'hardDrive' },
  lightning: { label: 'Nexus', ico: 'zap' },
  apex: { label: 'Apex', ico: 'flame' }
};

/** The platform key for a game, or null when there is no positive signal. */
function platformTag(g) {
  if (!g) return null;
  if (g.platform && PLATFORM_META[g.platform]) return g.platform;
  if (g.itch || /^itch:/.test(g.id || '')) return 'itch';
  if (g.steamAppId) return 'steam';
  if (g.epicNames && g.epicNames.length) return 'epic';
  if (g.custom) return 'local';
  // No positive signal: draw nothing rather than guess a storefront.
  return null;
}

/** A small "where is this from" chip; empty when there is nothing to say. */
function platformBadge(g, extra = '') {
  const key = platformTag(g);
  const m = key && PLATFORM_META[key];
  if (!m) return '';
  return `<span class="plat plat-${key}${extra ? ` ${extra}` : ''}" title="Source: ${esc(m.label)}">${icon(m.ico, 12)}${esc(m.label)}</span>`;
}

// ---------------------------------------------------------------------------
// Quick-launch dock
// ---------------------------------------------------------------------------
/**
 * The pinned titles, as a one-click strip.
 *
 * "Pinned" is the existing favourite flag (`State.favorites`, toggled by the
 * heart on any card), so there is no second list to keep in sync. Playable
 * titles lead the row; anything pinned but not yet installed keeps its place
 * with the same action its card would offer.
 */
function favDock() {
  const ids = Object.keys(State.favorites || {}).filter((k) => State.favorites[k]);
  const games = ids.map(byId).filter(Boolean);
  if (!games.length) return '';

  const rank = (g) => (isInstalled(g.id) ? 0 : isOwned(g.id) ? 1 : 2);
  games.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));

  return `<section class="fav-dock" id="fav-dock">
    <div class="dock-head">
      <h2 class="section-title">${icon('heart', 18)} Pinned</h2>
      <span class="section-note">${games.length} favourite${games.length === 1 ? '' : 's'} \u00b7 one click to play</span>
    </div>
    <div class="dock-row">${games.map(favTile).join('')}</div>
  </section>`;
}

/** One pinned card: cover, name, source chip and the real action button. */
function favTile(g) {
  const idle = !isInstalled(g.id) && !isOwned(g.id);
  return `<article class="dock-card${idle ? ' is-idle' : ''}" data-card="${g.id}" title="${esc(g.title)}">
    <div class="dock-art">
      ${art(g, 'cover')}
      <button class="fav on" data-act="fav" data-id="${g.id}" title="Unpin from the dock">${icon('heart', 14)}</button>
      ${platformBadge(g, 'dock-plat')}
    </div>
    <div class="dock-name">${esc(g.title)}</div>
    <div class="dock-act" data-actions="${g.id}" data-actions-bare="1">${actionHtml(g.id, { compact: true, menu: false })}</div>
  </article>`;
}

/**
 * Re-renders the dock in place after a pin/unpin, so toggling the heart never
 * needs a full view rebuild (which would also reset the scroll position).
 * Pinning the first title drops the dock in above the toolbar.
 */
function refreshFavDock() {
  const html = favDock();
  const host = document.getElementById('fav-dock');

  if (host) {
    if (!html) { host.remove(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    host.replaceWith(tmp.firstElementChild);
    return;
  }

  if (!html) return;
  const anchor = document.querySelector('#content .page-intro')
    || document.querySelector('#content .page-title');
  if (anchor) anchor.insertAdjacentHTML('afterend', html);
}
// ---------------------------------------------------------------------------
// File verification (see verify.js in the main process)
// ---------------------------------------------------------------------------
/** The last real verification report for a game, if it has one. */
function verifyOf(id) {
  return (State.verify && State.verify[id]) || null;
}

/**
 * A small badge explaining the verification outcome. Only rendered when there
 * is something worth saying — a healthy install shows nothing.
 */
function verifyBadge(id) {
  const v = verifyOf(id);
  if (!v || v.ok) return '';
  const cls = v.state === 'incomplete' ? 'warn'
    : v.state === 'unverifiable' ? 'info'
    : 'bad';
  const ico = v.state === 'unverifiable' ? 'info' : 'warning';
  return `<span class="verify-badge ${cls}" title="${esc(v.reason)}">${icon(ico, 12)} ${esc(v.label)}</span>`;
}

/** Full verification detail line, for the details page. */
function verifyLine(id) {
  const v = verifyOf(id);
  if (!v) return '';
  const when = v.checkedAt ? ` \u00b7 checked ${new Date(v.checkedAt).toLocaleTimeString()}` : '';
  const size = v.bytes != null
    ? `${fmtBytes(v.bytes)}${v.expected ? ` of ${fmtBytes(v.expected)} expected` : ''}`
    : '';
  const okCls = v.ok ? 'ok' : v.state === 'incomplete' ? 'warn' : 'bad';
  return `<div class="verify-line ${okCls}">
    ${icon(v.ok ? 'shield' : 'warning', 15)}
    <div><strong>${esc(v.label)}</strong><small>${esc(v.reason)}${size ? ` \u00b7 ${size}` : ''}${when}</small></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------
function dlInline(id) {
  const d = DL[id];
  const st = stageText(d);
  return `<div class="dl-inline">
    <div class="bar"><div data-bar="${id}" style="width:${d.pct}%"></div></div>
    <div class="dl-inline-row">
      <small><span data-phase="${id}">${esc(st.phase)}</span> &middot; <span data-pct="${id}">${Math.floor(d.pct)}%</span><span data-detail="${id}">${st.detail ? ` &middot; ${esc(st.detail)}` : ''}</span></small>
      <span class="mini-actions">
        <button class="icon-btn sm" data-act="${d.paused ? 'resume' : 'pause'}" data-id="${id}" title="${d.paused ? 'Resume' : 'Pause'}">${icon(d.paused ? 'play' : 'pause', 13)}</button>
        <button class="icon-btn sm" data-act="cancel" data-id="${id}" title="Cancel">${icon('close', 13)}</button>
      </span>
    </div>
  </div>`;
}

function manageMenu(id) {
  const linked = !!localLink(id);
  return `<div class="dropdown">
    <button class="btn secondary icon-only" data-act="menu" title="Manage">${icon('chevron', 16)}</button>
    <div class="menu">
      <a data-act="play" data-id="${id}">${icon('play', 15)} Launch</a>
      <a data-act="locate" data-id="${id}">${icon('folder', 15)} Locate executable&hellip;</a>
      <a data-act="scan-one" data-id="${id}">${icon('search', 15)} Scan for install</a>
      ${steamStoreUrl(id) ? `<a data-act="steam-page" data-id="${id}">${icon('external', 15)} View on Steam</a>` : ''}
      ${linked ? `<a data-act="folder" data-id="${id}">${icon('external', 15)} Open install folder</a>
      <a data-act="unlink" data-id="${id}" class="danger">${icon('close', 15)} Unlink executable</a>` : ''}
      <a data-act="verify" data-id="${id}">${icon('shield', 15)} Verify files</a>
      <a data-act="props" data-id="${id}">${icon('image', 15)} Properties &amp; art&hellip;</a>
      <a data-act="uninstall-open" data-id="${id}" class="danger">${icon('trash', 15)} Uninstall\u2026</a>
    </div>
  </div>`;
}

/**
 * Primary + secondary control cluster for a game in any view.
 *
 * Ownership gate: a game is only ever offered a download when the account was
 * verified to own it (Steam licence / Epic manifest / local data folder). If it
 * is not owned the button stays locked as "Not Owned".
 */
function actionHtml(id, opts = {}) {
  const st = statusOf(id);
  const compact = opts.compact ? ' sm' : '';
  const withMenu = opts.menu !== false;

  // Announced-but-unreleased titles: nothing can be downloaded yet, so the
  // action adds the title to the Library (with a release countdown) and offers
  // the publisher's own page as the place the pre-order is actually placed.
  if (typeof isUpcoming === 'function' && isUpcoming(id)) {
    const onList = typeof isPreordered === 'function' && isPreordered(id);
    const url = preorderUrl(id);
    const page = url
      ? `<button class="btn secondary sm" data-act="preorder-open" data-id="${id}" title="Open the publisher's own pre-order page in your browser">${icon('external', 14)} Pre-order page</button>`
      : '';
    if (onList) {
      return `<button class="btn preordered${compact}" data-act="preorder-info" data-id="${id}" title="In your library \u2014 Apex shows the release countdown">${icon('checkCircle', 14)} Pre-ordered</button>${page}`;
    }
    return `<button class="btn preorder${compact}" data-act="preorder" data-id="${id}" title="Add this title to your library and follow its release countdown">${icon('bookmark', 14)} Add to library</button>${page}`;
  }

  if (st === 'downloading') return dlInline(id);
  if (st === 'running') {
    return `<button class="btn running${compact}" data-act="stop" data-id="${id}">${icon('stop', 14)} Stop</button>`;
  }

  if (st === 'unowned') {
    // Not on this account. Rather than a dead end we point the user at the
    // game's own store page; Apex never downloads titles you do not own.
    const url = steamStoreUrl(id);
    if (url) {
      return `<button class="btn buy${compact}" data-act="steam-page" data-id="${id}" title="Open this game's Steam store page">${icon('cart', 14)} Get on Steam</button>`;
    }
    return `<button class="btn locked${compact}" disabled title="Not owned on this account \u2014 buy or claim it in Steam/Epic first">${icon('lock', 14)} Not Owned</button>`;
  }

  // Store cards: owned here, not downloaded yet -> Install is allowed.
  if (st === 'notinstalled') {
    return `<button class="btn primary glow${compact}" data-act="install" data-id="${id}">${icon('download', 15)} Install</button>`;
  }

  const main = st === 'update'
    ? `<button class="btn warn glow${compact}" data-act="update" data-id="${id}">${icon('refresh', 15)} Update</button>`
    : `<button class="btn primary glow launch${compact}" data-act="play" data-id="${id}">${icon('play', 14)} Launch</button>`;

  // The quick-launch dock wants the one button and nothing else; every card
  // there still opens its details page on click, which carries the full menu.
  return withMenu ? main + manageMenu(id) : main;
}

/** Re-renders every action cluster and status pill currently on screen. */
function refreshActions() {
  document.querySelectorAll('[data-actions]').forEach((el) => {
    const bare = el.dataset.actionsBare === '1';
    el.innerHTML = actionHtml(el.dataset.actions, bare ? { compact: true, menu: false } : {});
  });
  document.querySelectorAll('[data-status]').forEach((el) => {
    const st = statusOf(el.dataset.status);
    el.className = `pill ${st}`;
    el.textContent = STATUS_LABEL[st];
  });
  if (typeof current !== 'undefined' && current === 'library' && typeof applyLibraryFilter === 'function') {
    applyLibraryFilter();
  }
  if (typeof current !== 'undefined' && current === 'detail' && typeof refreshDetailBar === 'function') {
    refreshDetailBar();
  }
}

// ---------------------------------------------------------------------------
// Play time tracking
// ---------------------------------------------------------------------------
const SESSIONS = {};   // id -> startedAt (ms) for games running right now
let sessionFlush = null; // periodic persist so a long session survives a crash

const storedPlaytime = (id) => (State.stats && State.stats.playtime && State.stats.playtime[id]) || 0;

/** Stored play time plus whatever the current live session has added. */
function playtimeOf(id) {
  return storedPlaytime(id) + (SESSIONS[id] ? Date.now() - SESSIONS[id] : 0);
}

function fmtPlaytime(ms) {
  if (!ms || ms < 1000) return 'Never played';
  const mins = ms / 60000;
  if (mins < 1) return `${Math.floor(ms / 1000)} sec`;
  if (mins < 60) return `${Math.floor(mins)} min`;
  return `${(mins / 60).toFixed(1)} hrs`;
}

function beginSession(id) {
  if (SESSIONS[id]) return;
  SESSIONS[id] = Date.now();
  running[id] = true;
  if (typeof presencePlaying === 'function') presencePlaying(id);
  if (!sessionFlush) {
    sessionFlush = setInterval(() => { flushSessions(); persist(); }, 30000);
  }
}

/** Adds the elapsed time of finished sessions to the persisted totals. */
function flushSessions(now = Date.now()) {
  State.stats = State.stats || {};
  State.stats.playtime = State.stats.playtime || {};
  State.stats.lastPlayed = State.stats.lastPlayed || {};
  for (const id of Object.keys(SESSIONS)) {
    const elapsed = now - SESSIONS[id];
    if (elapsed <= 0) continue;
    State.stats.playtime[id] = (State.stats.playtime[id] || 0) + elapsed;
    State.stats.lastPlayed[id] = now;
    SESSIONS[id] = now;
  }
}

function endSession(id) {
  if (SESSIONS[id]) {
    flushSessions();
    delete SESSIONS[id];
  }
  delete running[id];
  if (!Object.keys(SESSIONS).length && sessionFlush) {
    clearInterval(sessionFlush);
    sessionFlush = null;
  }
  if (typeof presenceStopped === 'function') presenceStopped();
  persist();
}

/** Closes every open session (used when the window is closing). */
function endAllSessions() {
  if (!Object.keys(SESSIONS).length) return;
  flushSessions();
  for (const id of Object.keys(SESSIONS)) delete SESSIONS[id];
  Object.keys(running).forEach((id) => delete running[id]);
  persist();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', endAllSessions);
}

// ---------------------------------------------------------------------------
// Dropdown menus
// ---------------------------------------------------------------------------
function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown')) closeMenus(); });

// ---------------------------------------------------------------------------
// ETA helper (seconds -> "1h 02m" / "3m 12s" / "45s")
// ---------------------------------------------------------------------------
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
