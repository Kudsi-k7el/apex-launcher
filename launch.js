'use strict';

/**
 * Safe game launching (main process).
 *
 * Rules that keep this from being a foot-gun:
 *   - We never build a shell command string. Executables are started with
 *     `spawn(exe, argsArray)` and `shell: false`, so arguments can never be
 *     re-interpreted by cmd.exe.
 *   - Protocol handlers (steam://, com.epicgames.launcher://, ...) go through
 *     `shell.openExternal` and must match an allowlist.
 *   - Direct file launches are restricted to a set of executable extensions
 *     and the target must exist and be a regular file.
 */

const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const procs = require('./procs');

const ALLOWED_PROTOCOLS = new Set([
  'steam:',
  'com.epicgames.launcher:',
  'uplay:',
  'origin:',
  'origin2:',
  'link2ea:',
  'ea:',
  'battle.net:',
  'goggalaxy:',
  'unreal:',
  'rockstar:',
  'riotclient:',
  'ms-windows-store:',
  'msxbox:'
]);

const ALLOWED_EXT = new Set(['.exe', '.bat', '.cmd', '.lnk', '.url']);

function protocolOf(uri) {
  const i = String(uri).indexOf(':');
  return i === -1 ? '' : String(uri).slice(0, i + 1).toLowerCase();
}

function buildUri(target) {
  if (target.type === 'steam') {
    const id = String(target.appId || '').trim();
    if (!/^\d{1,12}$/.test(id)) return { error: 'Invalid Steam App ID' };
    return { uri: `steam://rungameid/${id}` };
  }
  if (target.type === 'epic' || target.type === 'uri') {
    if (!target.uri) return { error: 'Missing launch URI' };
    return { uri: String(target.uri) };
  }
  return { error: 'Unknown launch target' };
}

/**
 * @param {{ type:'steam'|'epic'|'uri'|'exe', appId?:string, uri?:string, exe?:string, args?:string[], cwd?:string }} target
 * @returns {Promise<{ok:boolean, method?:string, uri?:string, error?:string}>}
 */
async function launch(target) {
  if (!target || typeof target !== 'object') return { ok: false, error: 'No launch target' };

  if (target.type === 'exe') {
    const exe = String(target.exe || '');
    if (!exe || exe.includes('\0')) return { ok: false, error: 'Invalid executable path' };

    let stat;
    try { stat = fs.statSync(exe); } catch { return { ok: false, error: 'Executable not found' }; }
    if (!stat.isFile()) return { ok: false, error: 'Target is not a file' };

    const ext = path.extname(exe).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return { ok: false, error: `Blocked file type: ${ext || '(none)'}` };

    const args = Array.isArray(target.args) ? target.args.map(String) : [];
    const cwd = (target.cwd && fs.existsSync(target.cwd)) ? target.cwd : path.dirname(exe);

    if (ext === '.exe') {
      try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd, windowsHide: false });
        child.on('error', () => { /* surfaced by the exit path */ });
        child.unref();
        // Track it so the renderer's STOP button can actually end the game.
        const tracked = procs.register(target.id, child, {
          name: target.name || path.basename(exe, ext),
          exe
        });
        return { ok: true, method: 'spawn', pid: child.pid, tracked: !!tracked };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // .lnk / .bat / .cmd / .url -> let the OS resolve them
    const err = await shell.openPath(exe);
    return err ? { ok: false, error: err } : { ok: true, method: 'openPath', tracked: false };
  }

  const { uri, error } = buildUri(target);
  if (error) return { ok: false, error };

  const proto = protocolOf(uri);
  if (!ALLOWED_PROTOCOLS.has(proto)) return { ok: false, error: `Blocked protocol: ${proto || '(none)'}` };

  try {
    await shell.openExternal(uri);
    // A store client owns this process, so we cannot track it; STOP falls back
    // to killing the linked executable by name.
    return { ok: true, method: 'openExternal', uri, tracked: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The store-specific "download and install this now" deep link.
 *
 * Steam and Epic both expose a real installer trigger, so Apex hands the job to
 * the client that owns the content - that client downloads to the drive the
 * user picks there, with the account's real entitlement. Apex never fetches
 * game files itself.
 */
function installUri(target) {
  const platform = String((target && target.platform) || '').toLowerCase();

  if (platform === 'steam') {
    const id = String((target && target.appId) || '').trim();
    if (!/^\d{1,12}$/.test(id)) return { error: 'This game has no Steam App ID to install from' };
    return { uri: `steam://install/${id}` };
  }

  if (platform === 'epic') {
    const ns = String((target && target.namespace) || '').trim();
    const cat = String((target && target.catalogId) || '').trim();
    const app = String((target && target.appName) || '').trim();
    if (!ns || !cat) return { error: 'This game has no Epic app identifiers to install from' };
    const ids = app
      ? `${encodeURIComponent(ns)}%3A${encodeURIComponent(cat)}%3A${encodeURIComponent(app)}`
      : `${encodeURIComponent(ns)}%3A${encodeURIComponent(cat)}`;
    return { uri: `com.epicgames.launcher://apps/${ids}?action=install` };
  }

  return { error: `No installer is available for ${platform || 'this platform'}` };
}

/**
 * Opens the platform's own installer. The download really starts, but the
 * client does it - so it is not trackable as a child process here.
 *
 * @returns {Promise<{ok:boolean, method?:string, uri?:string, platform?:string, error?:string}>}
 */
async function install(target) {
  const { uri, error } = installUri(target);
  if (error) return { ok: false, error };

  const proto = protocolOf(uri);
  if (!ALLOWED_PROTOCOLS.has(proto)) return { ok: false, error: `Blocked protocol: ${proto || '(none)'}` };

  try {
    await shell.openExternal(uri);
    return { ok: true, method: 'openExternal', uri, platform: String(target.platform || '') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { launch, install, installUri, ALLOWED_PROTOCOLS, ALLOWED_EXT };
