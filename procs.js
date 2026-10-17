'use strict';

/**
 * Running-process registry (main process).
 *
 * Games are started detached so they survive Apex closing, which means there is
 * no live handle on the game once we let go of it. To make the renderer's STOP
 * button real we therefore keep the ChildProcess around and remember it per game
 * id, then terminate the whole tree on request.
 *
 * On Windows that is `taskkill /PID <pid> /T /F`. When we only know the image
 * name (a game started through a Steam/Epic URI, or a re-launch we did not spawn)
 * we fall back to `taskkill /IM <name.exe> /F`.
 *
 * Every call is an argv array with no shell, so a game title or path can never
 * be re-interpreted by cmd.exe.
 */

const { execFile } = require('child_process');
const path = require('path');

/** id -> { child, pid, name, image, exe, startedAt, stopping } */
const RUNNING = new Map();

let notify = () => {};
/** Called by the main process so it can forward exits to the renderer. */
function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

const basenameOf = (p) => { try { return path.basename(String(p || '')); } catch { return ''; } };

/**
 * Remembers a spawned child. The `exit` listener fires for both a natural quit
 * and a kill, so the UI always ends up back at "Launch".
 */
function register(id, child, meta = {}) {
  if (!id || !child) return null;

  const rec = {
    id,
    child,
    pid: child.pid,
    name: meta.name || String(id),
    image: meta.image || basenameOf(meta.exe) || null,
    exe: meta.exe || null,
    startedAt: Date.now(),
    stopping: false
  };
  RUNNING.set(id, rec);

  child.once('exit', (code, signal) => {
    const current = RUNNING.get(id);
    if (current && current.child === child) RUNNING.delete(id);
    notify({
      id: rec.id,
      name: rec.name,
      pid: rec.pid,
      code: code == null ? null : code,
      signal: signal || null,
      reason: rec.stopping ? 'stopped' : 'exited'
    });
  });
  child.once('error', () => { /* reported through the exit event / caller */ });

  return rec;
}

const isRunning = (id) => RUNNING.has(id);
const get = (id) => RUNNING.get(id) || null;

function list() {
  return [...RUNNING.values()].map((r) => ({
    id: r.id, pid: r.pid, name: r.name, image: r.image, startedAt: r.startedAt
  }));
}

function taskkill(args) {
  return new Promise((resolve) => {
    execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

/**
 * Terminates a running game.
 * @param {{id?:string, image?:string}|string} target
 * @returns {Promise<{ok:boolean, method?:string, error?:string, pid?:number}>}
 */
async function stop(target) {
  const t = (target && typeof target === 'object') ? target : { id: target };
  const rec = t.id ? RUNNING.get(t.id) : null;

  // Not tracked here (URI launch, or Apex was restarted since): best effort
  // using the executable name the renderer knows about.
  if (!rec) {
    const image = t.image ? basenameOf(t.image) : null;
    if (image && process.platform === 'win32' && /\.exe$/i.test(image)) {
      const ok = await taskkill(['/IM', image, '/F']);
      return ok ? { ok: true, method: 'image', image } : { ok: false, error: 'not-running' };
    }
    return { ok: false, error: 'not-running' };
  }

  rec.stopping = true;

  if (process.platform === 'win32' && rec.pid) {
    let ok = await taskkill(['/PID', String(rec.pid), '/T', '/F']);
    if (!ok && rec.image) ok = await taskkill(['/IM', rec.image, '/F']);
    if (ok) return { ok: true, method: 'tree', pid: rec.pid, image: rec.image };
  }

  // Fallback (non-Windows, or taskkill refused): signal the handle we hold.
  try {
    rec.child.kill('SIGKILL');
    return { ok: true, method: 'signal', pid: rec.pid };
  } catch (err) {
    RUNNING.delete(t.id);
    notify({ id: t.id, name: rec.name, pid: rec.pid, reason: 'stopped' });
    return { ok: false, error: err.message };
  }
}

module.exports = { register, stop, isRunning, list, get, setNotifier };
