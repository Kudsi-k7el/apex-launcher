'use strict';

/**
 * Discord Rich Presence (renderer side).
 *
 * The wording lives here; the socket, the handshake and the reconnect loop live
 * in discord.js in the main process. This module only ever decides *what* to
 * say — "Browsing the Store", "Playing Hollow Knight" — and pushes it across
 * the bridge, de-duplicating so a re-render never spams Discord.
 */

const PRESENCE_VIEWS = {
  store: 'Browsing the Store',
  library: 'In the Library',
  itch: 'Browsing itch.io',
  search: 'Searching for a game',
  detail: 'Reading a game page',
  downloads: 'Managing downloads',
  news: 'Reading the news',
  profile: 'On the Profile page',
  settings: 'In Settings'
};

// The Discord application asset shown in the corner of the card. Upload an
// image named "apex" under Rich Presence > Art Assets in the Discord app.
const PRESENCE_ASSET = 'apex';

let presenceLastKey = '';
let presencePlayingId = null;
let presenceStartedAt = 0;

/** True when the user has Rich Presence switched on in Settings. */
function presenceEnabled() {
  const d = (typeof State !== 'undefined' && State.settings && State.settings.discord) || null;
  return !!(d && d.enabled && d.clientId);
}

/** Pushes one activity, skipping it when nothing actually changed. */
function presencePush(activity) {
  if (!presenceEnabled()) return;
  if (!window.api || !window.api.presenceSet) return;

  const key = activity ? JSON.stringify(activity) : '';
  if (key === presenceLastKey) return;
  presenceLastKey = key;

  if (activity) window.api.presenceSet(activity);
  else window.api.presenceClear();
}

/** "Browsing Apex Launcher · <where>" for whatever the UI is showing. */
function presenceBrowsing() {
  if (presencePlayingId) return;   // a running game owns the presence
  const view = (typeof current !== 'undefined' && current) || 'store';
  presencePush({
    details: 'Browsing Apex Launcher',
    state: PRESENCE_VIEWS[view] || 'Browsing',
    largeImageKey: PRESENCE_ASSET,
    largeImageText: 'Apex Launcher'
  });
}

/** "Playing <title>" for as long as the session runs, with an elapsed timer. */
function presencePlaying(id) {
  const g = (typeof byId === 'function' && byId(id)) || null;
  const title = (g && g.title) || String(id || 'A game');

  // Keep the original start time when re-applying the same game.
  if (presencePlayingId !== id || !presenceStartedAt) presenceStartedAt = Date.now();
  presencePlayingId = id;

  presencePush({
    details: title,
    state: (g && g.genre) ? `Playing \u00b7 ${g.genre}` : 'In game',
    startTimestamp: presenceStartedAt,
    largeImageKey: PRESENCE_ASSET,
    largeImageText: 'Apex Launcher'
  });
}

/** A game stopped: fall back to whatever the UI is showing. */
function presenceStopped() {
  presencePlayingId = null;
  presenceStartedAt = 0;
  presenceLastKey = '';
  presenceBrowsing();
}

/** Re-applies the current state (used right after the Settings toggle flips). */
function presenceRefresh() {
  presenceLastKey = '';
  if (presencePlayingId) presencePlaying(presencePlayingId);
  else presenceBrowsing();
}
