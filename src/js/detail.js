'use strict';

/**
 * Steam-style Game Details page.
 *
 * Clicking any Library (or Store) card opens this full-page view: a cinematic
 * hero with the game's stylized logo, a glowing PLAY action bar with live play
 * time, and a body of activity / achievement / community panels plus a
 * "Friends Who Play" sidebar.
 *
 * Everything that is not real data (achievements, friends, community notes) is
 * generated deterministically from the game id, so a given game always shows
 * the same demo content instead of flickering on every render.
 */

let detailId = null;
let detailTimer = null;
let detailBarSig = null;

// ---------------------------------------------------------------------------
// Deterministic demo content
// ---------------------------------------------------------------------------
function hashStr(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

const PEOPLE = ['NovaReign', 'Kx7', 'Pixl', 'Marrow', 'Vex', 'Sonder', 'Rune_', 'T0ast',
  'Ferrous', 'Glass', 'Halcyon', 'Wisp', 'Quartz', 'Ledger', 'Aria', 'Bo'];

const ACH_POOL = ['First Steps', 'Getting Started', 'Explorer', 'Mastermind', 'Untouchable',
  'Completionist', 'Speedrunner', 'Collector', 'Perfectionist', 'Legend', 'Survivor',
  'Pathfinder', 'Treasure Hunter', 'Night Owl', 'Marathon', 'Sharpshooter', 'Architect',
  'Diplomat', 'Ghost', 'Iron Will', 'Lone Wolf', 'Trailblazer', 'Deep Dive', 'Kingmaker'];

const NOTE_TEXT = [
  'Anyone up for a run tonight? Mic on, EU servers.',
  'The {tag} build is way stronger than I thought.',
  'Finished the main story in 40 hours. Absolutely worth it.',
  'Best {genre} I have played in years. The atmosphere is unmatched.',
  'Pro tip: turn off motion blur before you start.',
  'Shot this in 4K, the art direction is unreal.',
  'Still finding new things after 200 hours.',
  'Co-op with friends is where this really shines.'
];

const NOTE_TAG = ['Guide', 'Screenshot', 'Discussion', 'Clip', 'Review', 'Modding'];

function achievementsOf(g) {
  const rng = rngFrom(hashStr(`ach:${g.id}`));
  const total = 24 + Math.floor(rng() * 56);
  const unlocked = isInstalled(g.id) ? Math.floor(total * (0.12 + rng() * 0.6)) : 0;

  const recent = [];
  const used = new Set();
  for (let i = 0; i < 4; i++) {
    let name = pick(rng, ACH_POOL);
    let guard = 0;
    while (used.has(name) && guard++ < 12) name = pick(rng, ACH_POOL);
    used.add(name);
    recent.push({
      name,
      rarity: (0.3 + rng() * 38).toFixed(1),
      when: Date.now() - (1 + Math.floor(rng() * 40)) * 86400000
    });
  }
  return { total, unlocked, recent, pct: total ? Math.round((unlocked / total) * 100) : 0 };
}

function friendsOf(g) {
  const rng = rngFrom(hashStr(`friends:${g.id}`));
  const pool = [...PEOPLE];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const n = 2 + Math.floor(rng() * 4);
  return pool.slice(0, n).map((name) => ({
    name,
    status: pick(rng, ['In game', 'Online', 'Online', 'Away', 'Offline']),
    hours: Math.round(3 + rng() * 380)
  }));
}

function notesOf(g) {
  const rng = rngFrom(hashStr(`notes:${g.id}`));
  const n = 2 + Math.floor(rng() * 2);
  return Array.from({ length: n }, () => ({
    author: pick(rng, PEOPLE),
    tag: pick(rng, NOTE_TAG),
    text: pick(rng, NOTE_TEXT)
      .replace('{tag}', pick(rng, g.tags && g.tags.length ? g.tags : ['meta']))
      .replace('{genre}', g.genre || 'game'),
    when: Date.now() - (1 + Math.floor(rng() * 72)) * 3600000,
    up: Math.floor(rng() * 240)
  }));
}

function activityOf(g) {
  const rng = rngFrom(hashStr(`act:${g.id}`));
  const n = 3 + Math.floor(rng() * 3);
  return Array.from({ length: n }, (_, i) => {
    const kind = Math.floor(rng() * 3);
    const hrs = (0.5 + rng() * 6).toFixed(1);
    return {
      ico: kind === 0 ? 'trophy' : kind === 1 ? 'sparkles' : 'clockPlay',
      who: pick(rng, PEOPLE),
      html: kind === 0
        ? `unlocked <b>${esc(pick(rng, ACH_POOL))}</b> in this game`
        : kind === 1
          ? 'added a new screenshot to their activity'
          : `played for <b>${hrs} hrs</b> this week`,
      when: Date.now() - (i * (2 + Math.floor(rng() * 9)) + 1) * 3600000
    };
  });
}

// ---------------------------------------------------------------------------
// Small formatted helpers
// ---------------------------------------------------------------------------
function lastPlayedText(id) {
  const ts = State.stats && State.stats.lastPlayed && State.stats.lastPlayed[id];
  if (!ts) return 'Never';
  return typeof timeAgo === 'function' ? timeAgo(ts) : new Date(ts).toLocaleDateString();
}

function sourceLabel(id) {
  const t = localLink(id);
  if (!t) return '\u2014';
  const map = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG Galaxy', ubisoft: 'Ubisoft Connect', ea: 'EA App', battlenet: 'Battle.net', xbox: 'Xbox', exe: 'Local executable', uri: 'Launcher link' };
  return map[t.type] || 'Linked';
}

/**
 * The hero's title slot.
 *
 * The hero never leads with a plain text title when a real wordmark can be had:
 * a game that declares a logo renders it straight away, and a game that does
 * not gets an empty slot that `loadHeroLogo` fills once the main process finds
 * one. The typed <h1> stays in the DOM as the accessible fallback and is hidden
 * by CSS the moment the image decodes - so the header is never a bare text
 * title, and never a broken image either.
 */
function logoHtml(g) {
  const title = esc(g.title);
  const theme = g.artKey ? ` data-theme="${esc(g.artKey)}"` : '';
  const src = g.logo || (State.logoAuto && State.logoAuto[g.id]) || '';
  return `<div class="dt-logo-wrap"${theme}>
      <h1 class="dt-logo-text">${title}</h1>
      <img class="dt-logo" data-logo-id="${esc(g.id)}"${src ? ` src="${esc(src)}"` : ''} alt="${title}" draggable="false">
    </div>`;
}

/**
 * Asks for a transparent wordmark when this game has none yet. Fire and
 * forget: `ensureLogos` writes the result onto `State.logoAuto` and repaints
 * whatever is already on screen.
 */
function loadHeroLogo(g) {
  if (!g) return;
  if (g.logo || (State.logoAuto && State.logoAuto[g.id])) return;
  if (typeof ensureLogos === 'function') ensureLogos([g]);
}

/** Cached images fire `load` before the listener above can see them. */
function syncLogos(root) {
  root.querySelectorAll('.dt-logo, .bp-logo').forEach((img) => {
    if (img.complete && img.naturalWidth > 0) {
      const wrap = img.closest('.dt-logo-wrap, .bp-logo-wrap');
      if (wrap) wrap.classList.add('has-logo');
    }
  });
}

// ---------------------------------------------------------------------------
// Hero + action bar
// ---------------------------------------------------------------------------
function heroHtml(g) {
  const meta = [
    ['user', g.developer],
    ['calendar', g.release],
    ['star', g.rating || '\u2014'],
    ['tag', g.genre],
    ['hardDrive', fmtSize(g.size)]
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');

  const own = ownershipOf(g.id);
  // Ownership is meaningless before a game is out, and a "Not owned" pill next
  // to a "Pre-ordered" button reads as a contradiction — so it is hidden.
  const unreleased = typeof isUpcoming === 'function' && isUpcoming(g.id);
  return `<section class="dt-hero">
    ${art(g, 'hero')}
    <div class="dt-hero-shade"></div>
    <div class="dt-hero-inner">
      <button class="dt-back" data-act="back">${icon('left', 16)} Back to Library</button>
      <div class="dt-hero-lower">
        <div class="dt-hero-left">
          ${logoHtml(g)}
          <div class="dt-chips">
            ${platformBadge(g, 'dt-plat')}
            ${meta.map(([i, v]) => `<span class="dt-chip">${icon(i, 13)} ${esc(v)}</span>`).join('')}
          </div>
          ${consoleBadges(g)}
        </div>
        <div class="dt-hero-right">
          ${unreleased ? '' : `<span class="dt-own ${own.kind}">${icon(own.kind === 'unowned' ? 'lock' : 'checkCircle', 13)} ${own.label}</span>`}
        </div>
      </div>
    </div>
  </section>`;
}

function barInner(id) {
  const st = statusOf(id);
  const fav = !!State.favorites[id];

  const unreleased = typeof isUpcoming === 'function' && isUpcoming(id);

  let primary;
  if (unreleased) {
    // Announced but not out: there is nothing to download or launch yet, so the
    // bar carries the pre-order controls instead — the same markup the cards
    // use, so the button state can never drift between views.
    primary = `<div class="dt-preorder">${actionHtml(id)}</div>`;
  } else if (st === 'downloading') {
    primary = `<button class="dt-play busy" disabled>${icon('download', 18)} ${Math.floor(DL[id].pct)}%</button>`;
  } else if (st === 'running') {
    primary = `<button class="dt-play running" data-act="stop" data-id="${id}">${icon('stop', 18)} STOP</button>`;
  } else if (st === 'update') {
    primary = `<button class="dt-play" data-act="update" data-id="${id}">${icon('refresh', 18)} UPDATE</button>`;
  } else if (st === 'play') {
    primary = `<button class="dt-play" data-act="play" data-id="${id}">${icon('play', 18)} PLAY</button>`;
  } else if (st === 'notinstalled') {
    primary = `<button class="dt-play install" data-act="install" data-id="${id}">${icon('download', 18)} INSTALL</button>`;
  } else {
    primary = steamStoreUrl(id)
      ? `<button class="dt-play buy" data-act="steam-page" data-id="${id}" title="Open this game's Steam store page">${icon('cart', 18)} GET ON STEAM</button>`
      : `<button class="dt-play locked" disabled title="Not owned on this account">${icon('lock', 18)} NOT OWNED</button>`;
  }

  const canPlay = st === 'play' || st === 'update' || st === 'running';
  const more = unreleased ? '' : `<div class="dropdown dt-more">
    <button class="dt-arrow" data-act="menu" title="Options">${icon('chevron', 15)}</button>
    <div class="menu right">
      <a data-act="play" data-id="${id}">${icon('play', 15)} Launch now</a>
      ${canPlay ? `<a data-act="locate" data-id="${id}">${icon('folder', 15)} Locate executable&hellip;</a>` : ''}
      <a data-act="scan-one" data-id="${id}">${icon('search', 15)} Scan for install</a>
      ${steamStoreUrl(id) ? `<a data-act="steam-page" data-id="${id}">${icon('external', 15)} View on Steam</a>` : ''}
      <a data-act="folder" data-id="${id}">${icon('external', 15)} Browse local files</a>
      <a data-act="verify" data-id="${id}">${icon('shield', 15)} Verify files</a>
      <a data-act="props" data-id="${id}">${icon('image', 15)} Properties &amp; art</a>
      ${isInstalled(id) ? `<a data-act="unlink" data-id="${id}" class="danger">${icon('close', 15)} Unlink${localLink(id) ? '' : ' (nothing linked)'}</a>` : ''}
    </div>
  </div>`;

  const settings = `<div class="dropdown">
    <button class="icon-btn" data-act="menu" title="Manage">${icon('settings', 17)}</button>
    <div class="menu right">
      <a data-act="fav" data-id="${id}">${icon('heart', 15)} ${fav ? 'Remove favorite' : 'Add to favorites'}</a>
      <a data-act="toast" data-msg="Cloud saves are a demo in this build">${icon('cloud', 15)} Cloud saves</a>
      <a data-act="toast" data-msg="Controller configuration is a demo in this build">${icon('gamepad', 15)} Controller</a>
      ${isInstalled(id) ? `<a data-act="uninstall-open" data-id="${id}" class="danger">${icon('trash', 15)} Uninstall\u2026</a>` : ''}
    </div>
  </div>`;

  return `<div class="dt-barbar">
    <div class="dt-playwrap">${primary}${more}</div>
    <div class="dt-stats">
      <div class="dt-stat"><small>Play time</small><strong id="dt-playtime">${fmtPlaytime(playtimeOf(id))}</strong></div>
      <div class="dt-stat"><small>Last played</small><strong id="dt-lastplayed">${lastPlayedText(id)}</strong></div>
      <div class="dt-stat"><small>Status</small><strong id="dt-live" class="${SESSIONS[id] ? 'on' : ''}">${SESSIONS[id] ? 'Playing now' : 'Not running'}</strong></div>
    </div>
    <div class="dt-bar-actions">
      <button class="icon-btn ${fav ? 'on' : ''}" data-act="fav" data-id="${id}" title="Favorite">${icon('heart', 17)}</button>
      ${settings}
    </div>
  </div>`;
}

function paintDetailStats() {
  const id = detailId;
  if (!id) return;
  const pt = document.getElementById('dt-playtime');
  if (pt) pt.textContent = fmtPlaytime(playtimeOf(id));
  const lp = document.getElementById('dt-lastplayed');
  if (lp) lp.textContent = lastPlayedText(id);
  const live = document.getElementById('dt-live');
  if (live) {
    if (SESSIONS[id]) {
      const secs = Math.floor((Date.now() - SESSIONS[id]) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      live.textContent = `Playing now \u00b7 ${mm}:${ss}`;
      live.classList.add('on');
    } else {
      live.textContent = 'Not running';
      live.classList.remove('on');
    }
  }
}

/** Re-renders the action bar only when its state actually changed. */
function refreshDetailBar() {
  const id = detailId;
  if (!id) return;
  const wrap = document.getElementById('dt-bar');
  if (wrap) {
    const onList = typeof isPreordered === 'function' && isPreordered(id);
    const sig = `${statusOf(id)}|${State.favorites[id] ? 1 : 0}|${localLink(id) ? 1 : 0}|${onList ? 'po' : ''}`;
    if (wrap.dataset.sig !== sig) {
      wrap.dataset.sig = sig;
      wrap.innerHTML = barInner(id);
      hydrateIcons(wrap);
    }
  }
  if (typeof paintDetailStats === 'function') paintDetailStats();
}

// ---------------------------------------------------------------------------
// Body panels
// ---------------------------------------------------------------------------
const panelHead = (ico, title, note = '') =>
  `<div class="dt-panel-head"><h3>${icon(ico, 17)} ${title}</h3>${note ? `<span class="dt-headnote">${note}</span>` : ''}</div>`;

function activityPanel(rows) {
  return `<section class="dt-panel">
    ${panelHead('activity', 'Recent activity')}
    <div class="dt-feed">
      ${rows.map((r, i) => `<div class="dt-feed-row">
        <span class="dt-avatar" style="--a:${(hashStr(r.who) % 360)}">${esc(r.who[0])}</span>
        <div class="dt-feed-text"><strong>${esc(r.who)}</strong> ${r.html}</div>
        <span class="dt-feed-when" data-ago="${r.when}">${timeAgo(r.when)}</span>
      </div>`).join('')}
    </div>
  </section>`;
}

function achPanel(g, ach) {
  return `<section class="dt-panel">
    ${panelHead('trophy', 'Achievements', `${ach.unlocked} of ${ach.total}`)}
    <div class="dt-ach-top">
      <div class="dt-ach-ring" style="--p:${ach.pct}">
        <strong>${ach.pct}%</strong><small>complete</small>
      </div>
      <div class="dt-ach-recent">
        <div class="bar"><div style="width:${ach.pct}%"></div></div>
        <small class="dt-dim">${ach.unlocked} unlocked \u00b7 ${ach.total - ach.unlocked} remaining</small>
        <div class="dt-ach-list">
          ${ach.recent.map((a) => `<div class="dt-ach-row ${ach.unlocked ? '' : 'locked'}">
            <span class="dt-ach-ico">${icon(ach.unlocked ? 'trophy' : 'lock', 14)}</span>
            <span class="dt-ach-name">${esc(a.name)}</span>
            <span class="dt-ach-rarity">${a.rarity}% of players</span>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

function notesPanel(notes) {
  return `<section class="dt-panel">
    ${panelHead('messageSquare', 'Community notes', 'Community hub')}
    <div class="dt-notes">
      ${notes.map((n) => `<article class="dt-note">
        <header>
          <span class="dt-avatar sm" style="--a:${(hashStr(n.author) % 360)}">${esc(n.author[0])}</span>
          <strong>${esc(n.author)}</strong>
          <span class="dt-note-tag">${esc(n.tag)}</span>
          <span class="dt-feed-when">${timeAgo(n.when)}</span>
        </header>
        <p>${esc(n.text)}</p>
        <footer>
          <span>${icon('arrowUpRight', 13)} ${n.up} helpful</span>
          <span>${icon('messageSquare', 13)} Reply</span>
        </footer>
      </article>`).join('')}
    </div>
  </section>`;
}

function friendsPanel(friends) {
  const inGame = friends.filter((f) => f.status === 'In game').length;
  return `<section class="dt-panel">
    ${panelHead('users', 'Friends who play', `${inGame} in game`)}
    <div class="dt-friends">
      ${friends.map((f) => `<div class="dt-friend">
        <span class="dt-avatar" style="--a:${(hashStr(f.name) % 360)}">${esc(f.name[0])}</span>
        <div class="dt-friend-info"><strong>${esc(f.name)}</strong><small>${esc(f.hours)} hrs on record</small></div>
        <span class="dt-dot ${f.status === 'In game' ? 'on' : f.status === 'Online' ? 'mid' : ''}" title="${esc(f.status)}"></span>
      </div>`).join('')}
    </div>
  </section>`;
}

function lockPanel(g) {
  return `<section class="dt-panel dt-lock">
    ${panelHead('lock', 'Ownership not verified')}
    <p>This account does not own <b>${esc(g.title)}</b> in the Steam library or the
    Epic Games manifests on this PC, so Apex Launcher will not download it.</p>
    <p class="dt-dim">Buy or claim the game in its store client, then run
    <b>Rescan</b> and it will become installable here.</p>
    <div class="dt-lock-actions">
      <button class="btn secondary" data-act="scan-all">${icon('search', 15)} Rescan libraries</button>
    </div>
  </section>`;
}

/** "PC · PlayStation 5 · Xbox Series X|S" for the details table. */
function platformList(g) {
  const names = ((g && g.consoles) || [])
    .map((c) => (typeof CONSOLE_META !== 'undefined' && CONSOLE_META[c] ? CONSOLE_META[c].full : c))
    .filter(Boolean);
  return names.length ? `PC \u00b7 ${names.join(' \u00b7 ')}` : 'PC';
}

function infoPanel(g) {
  const rows = [
    ['gamepad', 'Developer', g.developer],
    ['tag', 'Genre', g.genre],
    ['calendar', 'Released', String(g.release)],
    ['hardDrive', 'Size', fmtSize(g.size)],
    ['box', 'Platforms', platformList(g)],
    ['cpu', 'Source', sourceLabel(g.id)],
    ['folder', 'Install folder', localLink(g.id) && localLink(g.id).path ? localLink(g.id).path : State.settings.installPath || '\u2014']
  ];
  return `<section class="dt-panel">
    ${panelHead('info', 'Game details')}
    <dl class="dt-info">
      ${rows.map(([i, k, v]) => `<div><dt>${icon(i, 13)} ${k}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('')}
    </dl>
  </section>`;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
function renderDetail(el) {
  clearInterval(slideTimer);
  const g = byId(detailId);
  if (!g) { backToLibrary(); return; }

  el.innerHTML = `
    <div class="detail">
      ${heroHtml(g)}
      <div class="dt-bar" id="dt-bar" data-sig=""></div>
      <div class="dt-body">
        <div class="dt-main">
          ${verifyLine(g.id)}
          ${activityPanel(activityOf(g))}
          ${achPanel(g, achievementsOf(g))}
          ${notesPanel(notesOf(g))}
        </div>
        <aside class="dt-side">
          ${friendsPanel(friendsOf(g))}
          ${isOwned(g.id) || (typeof isUpcoming === 'function' && isUpcoming(g.id)) ? '' : lockPanel(g)}
          ${infoPanel(g)}
        </aside>
      </div>
    </div>`;

  hydrateIcons(el);
  syncLogos(el);
  // No wordmark on the catalogue entry? Ask for one and let it repaint.
  loadHeroLogo(g);
  refreshDetailBar();
  paintDetailStats();
  startDetailTicker();
  el.scrollTop = 0;
}

function startDetailTicker() {
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    if (typeof current === 'undefined' || current !== 'detail') { clearInterval(detailTimer); return; }
    paintDetailStats();
  }, 1000);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function openDetail(id) {
  if (!byId(id)) return;
  detailId = id;
  detailBarSig = null;
  current = 'detail';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === 'library'));
  render(true);
  content.scrollTop = 0;
}

function backToLibrary() {
  clearInterval(detailTimer);
  detailId = null;
  const tab = document.querySelector('.tab[data-view="library"]');
  if (tab) tab.click();
  else { current = 'library'; render(true); }
}
