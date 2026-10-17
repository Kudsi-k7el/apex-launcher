'use strict';

/**
 * Achievements.
 * -------------------------------------------------------------------------
 * Two sources, one presentation:
 *
 *   - Apex's own. The definitions live in `achievements()` (profile.js) and are
 *     derived from what the user has really done. This module is what turns a
 *     definition flipping to "earned" into something the user actually sees: a
 *     Steam-style slide-in from the corner, queued so three unlocks in a row do
 *     not three-way-split the screen.
 *   - Steam's real ones, for Steam titles, using the user's own Web API key.
 *     Those are polled while the game is running and toasted the same way.
 *
 * Neither path ever invents an achievement. If it is not in the list and not
 * returned by Valve, it does not fire.
 */

// ---------------------------------------------------------------------------
// Steam-style toast
// ---------------------------------------------------------------------------
let achQueue = [];
let achShowing = false;

function achHost() {
  let host = document.getElementById('ach-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ach-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Queues one unlock notice.
 *
 * @param {{label:string, desc?:string, ico?:string, icon?:string, game?:string, source?:string, rare?:boolean}} a
 */
function notifyAchievement(a) {
  if (State.settings.achievements && State.settings.achievements.enabled === false) return;
  achQueue.push(a);
  if (!achShowing) achPump();
}

function achPump() {
  const a = achQueue.shift();
  if (!a) { achShowing = false; return; }
  achShowing = true;

  const el = document.createElement('div');
  el.className = 'ach-toast';
  const art = a.icon
    ? `<img class="ach-toast-art" src="${esc(a.icon)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="ach-toast-art ach-toast-art-fallback">${icon(a.ico || 'trophy', 22)}</span>`;
  el.innerHTML = `
    <span class="ach-toast-glow" aria-hidden="true"></span>
    ${art}
    <div class="ach-toast-text">
      <small>${a.source === 'steam' ? 'Steam achievement' : 'Achievement unlocked'}</small>
      <strong>${esc(a.label)}</strong>
      <span>${esc(a.game || a.desc || '')}</span>
    </div>
    <span class="ach-toast-mark">${icon('trophy', 15)}</span>`;

  achHost().appendChild(el);
  // Two frames: the browser has to have painted the off-screen state before the
  // transition class lands, or it snaps in with no animation.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  if (typeof SFX !== 'undefined' && SFX.play) { try { SFX.play('select'); } catch { /* silent */ } }

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.remove(); achPump(); }, 420);
  }, 4600);
}

// ---------------------------------------------------------------------------
// Apex's own achievements
// ---------------------------------------------------------------------------
/**
 * Awards anything newly earned and toasts it.
 *
 * The very first run after this feature ships is special: the user may already
 * qualify for half the list, and eleven toasts at once is not a reward. Existing
 * achievements are therefore recorded silently once, and only the genuinely new
 * ones are announced from then on.
 *
 * @param {string} [reason] - for the log; not shown to the user.
 * @returns {Promise<string[]>} the ids awarded by this call
 */
async function checkAchievements(reason) {
  if (State.settings.achievements && State.settings.achievements.enabled === false) return [];
  State.achievements = State.achievements || {};

  let list;
  try { list = achievements().list; } catch { return []; }
  const fresh = list.filter((a) => a.got && !State.achievements[a.id]);

  // "Already had launches but nothing recorded" can only mean the feature is new
  // to this install, so seed quietly and point at the profile instead.
  const firstRun = Object.keys(State.achievements).length === 0 && ((State.stats && State.stats.launches) || 0) > 0;
  if (firstRun && fresh.length) {
    for (const a of fresh) State.achievements[a.id] = Date.now();
    await persist();
    toast(`${fresh.length} achievement${fresh.length === 1 ? '' : 's'} already earned \u2014 see your profile`, 'check');
    return fresh.map((a) => a.id);
  }

  for (const a of fresh) {
    State.achievements[a.id] = Date.now();
    notifyAchievement({ label: a.label, desc: a.desc, ico: a.ico });
  }
  if (fresh.length) await persist();
  if (reason && fresh.length) { /* nothing to log to: kept for the caller's clarity */ }
  return fresh.map((a) => a.id);
}

// ---------------------------------------------------------------------------
// Steam's real achievements
// ---------------------------------------------------------------------------
let steamTimer = null;
let steamWatching = null;

/** The Steam app id behind a library entry, from the catalogue or a detected link. */
function steamAppIdFor(id) {
  const g = (typeof byId === 'function' && byId(id)) || {};
  if (g.steamAppId) return String(g.steamAppId);
  const link = (typeof localLink === 'function') ? localLink(id) : null;
  if (link && link.appId) return String(link.appId);
  return null;
}

function steamConfigured() {
  const s = (State.settings.achievements || {}).steam || {};
  return !!(s.apiKey && s.steamId);
}

/**
 * Fetches a game's Steam achievements, toasting anything newly unlocked.
 *
 * The first poll for an appId only *records* the current state: a fresh install
 * would otherwise announce sixty achievements the user earned years ago.
 *
 * @returns {Promise<object>} the raw result, for the detail page
 */
async function fetchSteamAchievements(id, opts = {}) {
  const appId = steamAppIdFor(id);
  if (!appId) return { ok: false, error: 'no-appid' };
  if (!steamConfigured()) return { ok: false, error: 'key' };

  let res;
  try { res = await window.api.steamAchievements(appId); } catch { res = { ok: false, error: 'offline' }; }
  if (!res || !res.ok) return res || { ok: false, error: 'offline' };

  State.steamSeen = State.steamSeen || {};
  const seen = State.steamSeen[appId];
  const isFirst = !seen;
  const rec = seen || (State.steamSeen[appId] = {});
  const gameTitle = (byId(id) || {}).title || res.gameName || 'Steam game';
  let changed = false;

  for (const row of res.rows) {
    if (!row.unlocked) continue;
    if (rec[row.apiName] != null) continue;
    rec[row.apiName] = row.unlocktime || Date.now();
    changed = true;
    if (!isFirst && opts.announce !== false) {
      notifyAchievement({
        label: row.name,
        desc: row.desc,
        icon: row.icon,
        game: gameTitle,
        source: 'steam'
      });
    }
  }

  if (changed) await persist();
  return res;
}

/**
 * Watches a running Steam game's achievements.
 *
 * A minute is a deliberate choice: Valve's endpoint is not a live feed, and this
 * is one small request per minute while a game is up - never while nothing is.
 */
function startSteamWatch(id) {
  stopSteamWatch();
  if (!steamConfigured() || !steamAppIdFor(id)) return false;
  steamWatching = id;
  fetchSteamAchievements(id).catch(() => {});
  steamTimer = setInterval(() => {
    if (!steamWatching || !running[steamWatching]) { stopSteamWatch(); return; }
    fetchSteamAchievements(steamWatching).catch(() => {});
  }, 60000);
  return true;
}

function stopSteamWatch() {
  if (steamTimer) clearInterval(steamTimer);
  steamTimer = null;
  steamWatching = null;
}

/**
 * How many of a game's Steam achievements are unlocked, without the full list -
 * used by the library card so it costs one request per card, not one per tile.
 */
async function steamProgressFor(id) {
  const res = await fetchSteamAchievements(id, { announce: false });
  if (!res || !res.ok) return null;
  return { unlocked: res.unlocked, total: res.total };
}
