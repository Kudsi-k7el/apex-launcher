'use strict';

/**
 * Steam Web API (achievements), main process.
 * -------------------------------------------------------------------------
 * Real Valve achievement data, using the user's *own* Web API key - there is no
 * bundled key and nothing is sent anywhere except to api.steampowered.com.
 *
 * Two endpoints matter:
 *   - `GetSchemaForGame`  what achievements a game has (names, descriptions,
 *                         icons). It never changes, so it is cached for the
 *                         lifetime of the process.
 *   - `GetPlayerAchievements` which of them this account has unlocked.
 *
 * This module is deliberately stateless: it fetches and returns. Deciding what
 * is *new* belongs to the renderer, which owns the persisted state, so a restart
 * cannot fire a hundred toasts for achievements earned months ago.
 *
 * Several failure modes are normal and are reported as plain reasons rather than
 * errors: a private profile, a game with no stats, a bad key.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.steampowered.com';
const TIMEOUT_MS = 12000;

let cfg = { key: '', steamId: '' };
/** appId -> schema rows; immutable per game, so cached for the session. */
const schemaCache = new Map();

function configure(next = {}) {
  cfg = {
    key: String(next.key || '').trim(),
    steamId: String(next.steamId || '').trim()
  };
  return status();
}

function status() {
  return {
    configured: !!(cfg.key && cfg.steamId),
    hasKey: !!cfg.key,
    steamId: cfg.steamId || null
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function getJson(pathname, params) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'key' };
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return { ok: false, error: aborted ? 'timeout' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Steam ID
// ---------------------------------------------------------------------------
/**
 * Finds the SteamID64 of the account Steam itself last used on this PC, so the
 * user does not have to dig a 17-digit number out of their profile URL.
 *
 * `loginusers.vdf` is a Valve KeyValues file: the account blocks are quoted ids
 * with `"MostRecent" "1"` on the one that matters.
 *
 * @returns {Promise<{ok:boolean, steamId?:string, error?:string}>}
 */
async function detectSteamId(roots) {
  for (const root of roots || []) {
    const file = path.join(root, 'config', 'loginusers.vdf');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }

    let best = null;
    const blocks = text.split(/"(\d{17})"\s*\{/);
    for (let i = 1; i < blocks.length; i += 2) {
      const id = blocks[i];
      const body = blocks[i + 1] || '';
      const recent = /"MostRecent"\s*"1"/i.test(body);
      const name = (body.match(/"PersonaName"\s*"([^"]*)"/i) || [])[1] || null;
      if (recent) return { ok: true, steamId: id, persona: name, source: file };
      if (!best) best = { id, name };
    }
    if (best) return { ok: true, steamId: best.id, persona: best.name, source: file };
  }
  return { ok: false, error: 'no-steam' };
}

/** Turns a vanity name or a full profile URL into a SteamID64. */
async function resolveSteamId(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  if (/^\d{17}$/.test(raw)) return { ok: true, steamId: raw };

  const vanity = (raw.match(/steamcommunity\.com\/id\/([^/?#]+)/i) || [])[1] || raw;
  const numeric = (raw.match(/steamcommunity\.com\/profiles\/(\d{17})/i) || [])[1];
  if (numeric) return { ok: true, steamId: numeric };
  if (!cfg.key) return { ok: false, error: 'key' };

  const res = await getJson('/ISteamUser/ResolveVanityURL/v1/', { key: cfg.key, vanityurl: vanity });
  const body = res.ok ? res.body && res.body.response : null;
  if (body && Number(body.success) === 1 && body.steamid) return { ok: true, steamId: String(body.steamid) };
  return { ok: false, error: 'not-found' };
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function normaliseSchemaRow(row) {
  return {
    apiName: String(row.name || ''),
    name: String(row.displayName || row.name || 'Achievement'),
    desc: String(row.description || ''),
    hidden: Number(row.hidden) === 1,
    icon: row.icon || null,
    grey: row.icongray || null
  };
}

/** The achievement list for a game (cached: it never changes). */
async function schema(appId) {
  const id = String(appId || '').trim();
  if (!/^\d{1,12}$/.test(id)) return { ok: false, error: 'bad-appid' };
  if (schemaCache.has(id)) return { ok: true, rows: schemaCache.get(id) };

  const res = await getJson('/ISteamUserStats/GetSchemaForGame/v2/', { key: cfg.key, appid: id, l: 'english' });
  if (!res.ok) return { ok: false, error: res.error };

  const game = (res.body && res.body.game) || {};
  const list = (game.availableGameStats && game.availableGameStats.achievements) || [];
  const rows = list.map(normaliseSchemaRow);
  schemaCache.set(id, rows);
  return { ok: true, rows, gameName: game.gameName || null };
}

/**
 * A game's achievements for this account, schema merged in and sorted so
 * unlocked ones come first.
 *
 * @returns {Promise<object>} `{ ok, appId, gameName, unlocked, total, rows:[{apiName,name,desc,icon,grey,hidden,unlocked,unlocktime}] }`
 */
async function achievements(appId, opts = {}) {
  const id = String(appId || '').trim();
  if (!/^\d{1,12}$/.test(id)) return { ok: false, error: 'bad-appid' };
  if (!cfg.key) return { ok: false, error: 'key' };
  if (!cfg.steamId) return { ok: false, error: 'steamid' };

  const res = await getJson('/ISteamUserStats/GetPlayerAchievements/v1/', {
    key: cfg.key, steamid: cfg.steamId, appid: id, l: 'english'
  });
  if (!res.ok) return { ok: false, error: res.error };

  const stats = (res.body && res.body.playerstats) || {};
  if (Number(stats.success) !== 1) {
    // Steam says why in `error`; the two that matter get their own reason so the
    // UI can tell the user something actionable.
    const msg = String(stats.error || '').toLowerCase();
    if (msg.includes('private')) return { ok: false, error: 'private' };
    if (msg.includes('no stats') || msg.includes('not found') || msg.includes('does not')) return { ok: false, error: 'nostats' };
    return { ok: false, error: 'unavailable', detail: stats.error || null };
  }

  const ignored = new Set((opts.ignore || []).map(String));
  const player = (stats.achievements || []).filter((a) => !ignored.has(String(a.apiname)));

  let rows = [];
  let gameName = stats.gameName || null;
  const schemaRes = await schema(id);
  if (schemaRes.ok) {
    gameName = gameName || schemaRes.gameName || null;
    const byName = new Map(schemaRes.rows.map((r) => [r.apiName, r]));
    rows = player.map((a) => {
      const meta = byName.get(String(a.apiname)) || {};
      return {
        apiName: String(a.apiname),
        name: meta.name || String(a.apiname),
        desc: meta.desc || '',
        icon: meta.icon || null,
        grey: meta.grey || null,
        hidden: !!meta.hidden,
        unlocked: Number(a.achieved) === 1,
        unlocktime: num(a.unlocktime) || null
      };
    });
  } else {
    // No schema (a very new game, or a language miss): the unlock state is still
    // real, so show it without descriptions rather than nothing.
    rows = player.map((a) => ({
      apiName: String(a.apiname),
      name: String(a.apiname),
      desc: '',
      icon: null,
      grey: null,
      hidden: false,
      unlocked: Number(a.achieved) === 1,
      unlocktime: num(a.unlocktime) || null
    }));
  }

  rows.sort((a, b) => {
    if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    if (a.unlocked && b.unlocked) return (b.unlocktime || 0) - (a.unlocktime || 0);
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    appId: id,
    gameName,
    rows,
    unlocked: rows.filter((r) => r.unlocked).length,
    total: rows.length,
    at: Date.now()
  };
}

/** How many achievements this account has, per game, without the detail. */
async function ownedGames() {
  if (!cfg.key || !cfg.steamId) return { ok: false, error: cfg.key ? 'steamid' : 'key' };
  const res = await getJson('/IPlayerService/GetOwnedGames/v1/', {
    key: cfg.key, steamid: cfg.steamId, include_appinfo: 0, include_played_free_games: 1
  });
  if (!res.ok) return { ok: false, error: res.error };
  const games = (res.body && res.body.response && res.body.response.games) || [];
  return { ok: true, count: games.length };
}

module.exports = { configure, status, detectSteamId, resolveSteamId, schema, achievements, ownedGames };
