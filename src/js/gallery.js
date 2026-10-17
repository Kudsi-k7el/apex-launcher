'use strict';

/**
 * Achievements & Screenshot gallery.
 * -------------------------------------------------------------------------
 * One view, two shelves, because they answer the same question - "what have I
 * actually done in this launcher lately?":
 *
 *   - Achievements: Apex's own list (the same definitions the profile page
 *     renders, so the two can never disagree), plus whatever Steam knows about
 *     the Steam games in the library when the user has connected a key.
 *   - Screenshots: every PNG F2 has saved, newest first, with the ones that are
 *     too old to keep one click from gone.
 *
 * Thumbnails are read through the same `readImage` bridge the rest of the app
 * uses for artwork, because the renderer's CSP blocks `file:` URLs.
 */

let galleryTab = 'screenshots';
let galleryShots = null;
let galleryBusy = false;

const SHOT_PAGE = 60;   // thumbnails read per paint; the rest stay on disk

function fmtShotTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Achievements shelf
// ---------------------------------------------------------------------------
function achSteamGames() {
  return allGames().filter((g) => {
    if (!g.steamAppId) return false;
    return isInstalled(g.id) || isOwned(g.id) || playtimeOf(g.id) > 0;
  }).slice(0, 12);
}

function renderAchievementShelf() {
  const steamOn = steamConfigured();
  const cfg = (State.settings.achievements || {}).steam || {};
  return `
    <div class="gl-panel">
      <div class="gl-panel-head">
        <h3>${icon('trophy', 16)} Apex achievements</h3>
        <span class="gl-note">Earned by what you actually do in the launcher.</span>
      </div>
      ${renderAchievements()}
    </div>

    <div class="gl-panel">
      <div class="gl-panel-head">
        <h3>${icon('globe', 16)} Steam achievements</h3>
        ${steamOn
          ? `<button class="btn secondary sm" data-act="steam-refresh">${icon('refresh', 14)} Refresh</button>`
          : ''}
      </div>
      ${steamOn
        ? `<div class="gl-steam" id="gl-steam">${icon('refresh', 15)}<span>Reading your Steam achievements\u2026</span></div>`
        : `<div class="gl-steam off" id="gl-steam">
             ${icon('key', 15)}
             <div>
               <strong>Not connected</strong>
               <p>Add your own Steam Web API key and SteamID64 in
                  <a data-act="open-settings" data-tab="achievements">Settings</a> to see the real
                  achievements for your Steam games here${cfg.steamId ? ` (ID ${esc(cfg.steamId)} saved)` : ''}.</p>
             </div>
           </div>`}
    </div>`;
}

/** Fills the Steam panel once the page is on screen, so the view never blocks. */
async function hydrateSteamShelf() {
  const host = document.getElementById('gl-steam');
  if (!host || !steamConfigured()) return;

  const games = achSteamGames();
  if (!games.length) {
    host.innerHTML = `${icon('info', 15)}<span>No Steam titles in your library yet.</span>`;
    return;
  }

  const results = [];
  for (const g of games) {
    const res = await fetchSteamAchievements(g.id, { announce: false }).catch(() => null);
    results.push({ game: g, res });
  }

  host.classList.add('gl-steam-list');
  host.innerHTML = results.map(({ game, res }) => {
    const ok = res && res.ok;
    const pct = ok && res.total ? Math.round((res.unlocked / res.total) * 100) : 0;
    const body = !res
      ? 'Could not reach Steam.'
      : (res.error === 'private' ? 'Your Steam profile is private \u2014 achievements need it public.'
        : res.error === 'nostats' ? 'This game has no Steam achievements.'
          : res.error === 'key' ? 'Add a Steam API key in Settings.'
            : `Steam said: ${esc(res.error)}`);
    return `
      <div class="gl-steam-row">
        <div class="gl-steam-text">
          <strong>${esc(game.title)}</strong>
          ${ok
            ? `<div class="gl-bar"><div class="gl-fill" style="width:${pct}%"></div></div>
               <small>${res.unlocked} of ${res.total} unlocked</small>`
            : `<small>${body}</small>`}
        </div>
        ${ok ? `<a class="gl-open" data-act="detail" data-id="${esc(game.id)}">${icon('external', 14)} Open</a>` : ''}
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Screenshot shelf
// ---------------------------------------------------------------------------
function renderShotGrid(data) {
  const shots = (data && data.shots) || [];

  if (!shots.length) {
    return `<div class="empty show sm">
      ${icon('camera', 26)}
      <p>No screenshots yet.</p>
      <small>Press <kbd>${esc((State.settings.screenshot || {}).key || 'F2')}</kbd> while playing anything
        \u2014 Apex saves a full-quality PNG here, even with the launcher in the tray.</small>
      <button class="btn primary" data-act="shot-capture">${icon('camera', 15)} Take one now</button>
    </div>`;
  }

  const shown = shots.slice(0, SHOT_PAGE);
  const hidden = shots.length - shown.length;

  return `
    <div class="gl-shots">
      ${shown.map((s) => `
        <figure class="gl-shot" data-shot="${esc(s.name)}" data-thumb="${esc(s.thumb)}">
          <div class="gl-shot-art"><span class="gl-shot-spin">${icon('image', 20)}</span></div>
          <figcaption>
            <strong title="${esc(s.name)}">${esc(s.game || s.name.replace(/\.png$/i, ''))}</strong>
            <small>${esc(fmtShotTime(s.at))}${s.width ? ` \u00b7 ${s.width}\u00d7${s.height}` : ''}
              \u00b7 ${fmtBytes(s.bytes)}</small>
            <span class="gl-shot-acts">
              <button class="icon-btn sm" data-act="shot-open" data-shot="${esc(s.name)}" title="Open the full-size image">${icon('external', 14)}</button>
              <button class="icon-btn sm danger" data-act="shot-delete" data-shot="${esc(s.name)}" title="Delete this screenshot">${icon('trash', 14)}</button>
            </span>
          </figcaption>
        </figure>`).join('')}
    </div>
    ${hidden > 0 ? `<p class="gl-more">\u2026and ${hidden} more on disk.
      <a data-act="shot-folder">${icon('external', 13)} Open the folder</a></p>` : ''}`;
}

/** Reads the thumbnails one by one so a big gallery does not stall the paint. */
async function hydrateShotGrid() {
  const figures = [...document.querySelectorAll('.gl-shot[data-thumb]')];
  for (const fig of figures) {
    if (!fig.isConnected) return;   // the user navigated away mid-load
    const url = await window.api.readImage(fig.dataset.thumb).catch(() => null);
    const art = fig.querySelector('.gl-shot-art');
    if (!art) continue;
    art.innerHTML = url
      ? `<img src="${esc(url)}" alt="" loading="lazy">`
      : `<span class="gl-shot-spin">${icon('warning', 18)}</span>`;
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
async function renderGallery(el) {
  if (galleryBusy) return;
  galleryBusy = true;

  const shots = galleryShots || await window.api.shotsList().catch(() => null);
  galleryShots = shots;
  const count = shots && shots.shots ? shots.shots.length : 0;
  const total = shots ? fmtBytes(shots.bytes) : '\u2014';

  el.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Gallery</h1>
        <p class="page-sub">What you have earned, and what you have captured.</p>
      </div>
      <div class="page-actions">
        <button class="btn secondary" data-act="shot-folder">${icon('external', 15)} Screenshot folder</button>
        <button class="btn primary" data-act="shot-capture">${icon('camera', 15)} Screenshot (${esc((State.settings.screenshot || {}).key || 'F2')})</button>
      </div>
    </header>

    <div class="gl-tabs" role="tablist">
      <button class="gl-tab ${galleryTab === 'screenshots' ? 'on' : ''}" data-act="gallery-tab" data-tab="screenshots">
        ${icon('camera', 15)} Screenshots <em>${count}</em>
      </button>
      <button class="gl-tab ${galleryTab === 'achievements' ? 'on' : ''}" data-act="gallery-tab" data-tab="achievements">
        ${icon('trophy', 15)} Achievements <em>${achievements().earned}</em>
      </button>
    </div>

    <div class="gl-body">
      ${galleryTab === 'screenshots'
        ? `<div class="gl-panel">
             <div class="gl-panel-head">
               <h3>${icon('image', 16)} Screenshots</h3>
               <span class="gl-note">${count} saved \u00b7 ${total} on disk</span>
             </div>
             ${renderShotGrid(shots)}
           </div>`
        : renderAchievementShelf()}
    </div>`;

  hydrateIcons(el);
  galleryBusy = false;

  if (galleryTab === 'screenshots') hydrateShotGrid();
  else hydrateSteamShelf();
}
