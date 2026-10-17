'use strict';

/**
 * The sign-in gate (main process).
 * ---------------------------------------------------------------------------
 * Apex Launcher will not hand a game to an anonymous user. This module is where
 * that rule lives, and it lives in the main process on purpose: the renderer can
 * be reloaded, poked at from the devtools or replaced with a stub, so a check
 * that only ran there would be decoration rather than a gate. Every privileged
 * IPC channel asks `allow()` before it does anything (see the GATED list in
 * main.js).
 *
 * The session itself is a bearer token kept in the settings file and only ever
 * sent to the configured backend. `verify()` is the only thing that can turn the
 * gate green, and it always asks the server - a token sitting in a file proves
 * nothing about whether the account still exists.
 *
 * Three states matter to the UI:
 *
 *   signedIn     the server vouched for the token
 *   signedOut    no token, or the server rejected it
 *   unreachable  the server did not answer (the token is kept: this is a network
 *                problem, not a bad session)
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./net/api');

const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const LOOPBACK_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;
const REVERIFY_MS = 10 * 60 * 1000;

const state = {
  status: 'unknown',      // unknown | unconfigured | signedOut | signedIn | unreachable
  signedIn: false,
  user: null,
  error: '',
  offline: false,
  baseUrl: '',
  verifiedAt: 0,
  checking: false
};

let io = null;            // { load, save, onChanged, dataDir }
let firstCheck = null;    // in-flight promise for the initial verification
let recheckTimer = null;

// ---------------------------------------------------------------------------
// State plumbing
// ---------------------------------------------------------------------------
function settings() {
  const st = io ? io.load() : { settings: {} };
  st.settings = st.settings || {};
  st.settings.api = st.settings.api || {};
  st.settings.auth = st.settings.auth || {};
  return st;
}

function apiCfg() {
  return settings().settings.api;
}

function saveApi(patch) {
  const st = settings();
  st.settings.api = { ...st.settings.api, ...patch };
  if (io) io.save(st);
  return st.settings.api;
}

/** What the renderer is allowed to know. Never includes the token. */
function snapshot() {
  return {
    required: auth.required(),
    status: state.status,
    signedIn: state.signedIn,
    user: state.user,
    error: state.error,
    offline: state.offline,
    baseUrl: state.baseUrl,
    verifiedAt: state.verifiedAt,
    checking: state.checking,
    canStartServer: canStartServer()
  };
}

function emit() {
  if (io && io.onChanged) {
    try { io.onChanged(snapshot()); } catch { /* a closed window is not an error */ }
  }
}

function set(patch) {
  Object.assign(state, patch);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
/**
 * Asks the backend who this token belongs to.
 *
 * `offline` failures are treated differently from rejections: a server that is
 * merely down must not sign out somebody who is mid-session (that would be an
 * app that forgets your account when the wifi blips), but at launch there is
 * nothing to be lenient about, so the gate stays shut.
 */
async function verify() {
  const cfg = apiCfg();
  const baseUrl = String(cfg.baseUrl || '');
  const token = String(cfg.token || '');

  api.configure(baseUrl);
  api.setToken(token);

  set({ checking: true, baseUrl });
  emit();

  let next;
  if (!baseUrl) {
    next = { status: 'unconfigured', signedIn: false, user: null, offline: false,
      error: 'No server is set. Point Apex at your Apex backend to sign in.' };
  } else if (!token) {
    next = { status: 'signedOut', signedIn: false, user: null, offline: false, error: '' };
  } else {
    const res = await api.me();
    if (res.ok) {
      next = {
        status: 'signedIn', signedIn: true, user: res.user, error: '', offline: false,
        verifiedAt: Date.now()
      };
      saveApi({ email: (res.user && res.user.email) || cfg.email || '', name: (res.user && res.user.username) || '' });
    } else if (res.signedOut) {
      // The server actively refused it: this token is dead, so it goes.
      saveApi({ token: '', email: '', name: '' });
      next = { status: 'signedOut', signedIn: false, user: null, offline: false,
        error: res.status === 401 ? 'Your session expired. Sign in again.' : res.error };
    } else if (state.signedIn) {
      // Already verified in this run - stay in, but say we are out of touch.
      next = { offline: true, error: res.error };
    } else {
      next = { status: 'unreachable', signedIn: false, user: null, offline: true, error: res.error };
    }
  }

  set({ ...next, checking: false });
  emit();
  return snapshot();
}

function ensureFirstCheck() {
  if (!firstCheck) {
    firstCheck = verify().catch((err) => {
      set({ checking: false, status: 'unreachable', offline: true, error: String((err && err.message) || err) });
      emit();
      return snapshot();
    });
  }
  return firstCheck;
}

function startRecheck() {
  clearInterval(recheckTimer);
  recheckTimer = setInterval(() => { verify().catch(() => { /* next tick will try again */ }); }, REVERIFY_MS);
  recheckTimer.unref();
}

// ---------------------------------------------------------------------------
// Local server
// ---------------------------------------------------------------------------
/**
 * Where the bundled backend lives, in either shape this app runs in.
 *
 * From the repository `server/` sits next to main.js. From an installed build it
 * is unpacked beside the app as a resource (see extraResources in package.json),
 * because a Node script cannot be executed out of an asar archive. An empty
 * return means "there is nothing here to start", and the sign-in screen simply
 * asks for a server address instead.
 */
function serverFile() {
  const inRepo = path.join(__dirname, 'server', 'server.js');
  if (!/app\.asar/i.test(inRepo) && fs.existsSync(inRepo)) return inRepo;
  const packed = process.resourcesPath ? path.join(process.resourcesPath, 'server', 'server.js') : '';
  if (packed && fs.existsSync(packed)) return packed;
  return '';
}

/** Only a loopback backend, with a real file behind it, can be started here. */
function canStartServer() {
  if (!LOOPBACK_RE.test(String(apiCfg().baseUrl || ''))) return false;
  return !!serverFile();
}

/**
 * Launches the bundled backend with the machine's own Node.
 *
 * Used by the sign-in screen's "Start server" button, because the one thing a
 * self-hosted setup gets wrong is forgetting to start the other half. The child
 * is detached: it outlives the launcher, which is what you want from a service
 * (quitting Apex should not knock your website offline).
 *
 * Node is a hard requirement for this - the backend uses the built-in SQLite,
 * which Electron's older runtime does not have - so a missing `node` on PATH is
 * reported as a real answer rather than a silent failure.
 */
async function startServer() {
  const file = serverFile();
  const baseUrl = String(apiCfg().baseUrl || '');
  if (!file || !LOOPBACK_RE.test(baseUrl)) {
    return { ok: false, error: 'The bundled server is only available for a local address.' };
  }

  let port = '8787';
  let host = '127.0.0.1';
  try {
    const url = new URL(baseUrl);
    host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
    port = url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch { /* fall back to the defaults above */ }

  // Installed builds must not try to write a database inside Program Files.
  const db = io && io.dataDir
    ? path.join(io.dataDir, 'apex-server', 'apex.db')
    : path.join(path.dirname(file), 'data', 'apex.db');

  let failure = null;
  let child = null;
  try {
    child = spawn('node', [file, '--host', host, '--port', String(port), '--db', db], {
      cwd: path.dirname(file),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', (err) => { failure = err; });
    child.unref();
  } catch (err) {
    return { ok: false, error: `Could not start the server: ${(err && err.message) || err}` };
  }

  // A spawn failure arrives on the next tick, so give it one before answering.
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (failure) {
    return {
      ok: false,
      error: 'Could not start the server. Node.js has to be installed, or point Apex at a hosted server.'
    };
  }
  return { ok: true, pid: child.pid };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
const auth = {
  init(opts) {
    io = opts || null;
    state.baseUrl = String(settings().settings.api.baseUrl || '');
    startRecheck();
    // Kick the first check off immediately; the renderer awaits it through the
    // auth:state channel, so it never has to poll.
    ensureFirstCheck();
    return snapshot();
  },

  snapshot,

  /**
   * The gate itself. Read from the file every time rather than cached, so
   * "Reset settings", a hand-edited state file and the test harnesses all take
   * effect at once, and there is only one behaviour to reason about.
   */
  required() {
    return settings().settings.auth.required !== false;
  },

  /** Everything privileged funnels through here. */
  allow() {
    return !auth.required() || state.signedIn;
  },

  /** Turns the gate off for good (the sign-in screen's escape hatch). */
  relax() {
    const st = settings();
    st.settings.auth = { ...st.settings.auth, required: false };
    if (io) io.save(st);
    emit();
    return snapshot();
  },

  /** Re-locks the app. */
  require() {
    const st = settings();
    st.settings.auth = { ...st.settings.auth, required: true };
    if (io) io.save(st);
    emit();
    return snapshot();
  },

  async ready() {
    return ensureFirstCheck();
  },

  async recheck() {
    firstCheck = null;
    return ensureFirstCheck();
  },

  async configure(url) {
    const raw = String(url == null ? '' : url).trim();
    const clean = raw ? raw.replace(/\/+$/, '') : '';
    saveApi({ baseUrl: clean });
    api.configure(clean);
    set({ baseUrl: clean });
    return auth.recheck();
  },

  async signIn({ email, password } = {}) {
    const res = await api.login({ email, password });
    if (!res.ok) return { ok: false, error: res.error };
    saveApi({ token: res.token || '', email: (res.user && res.user.email) || email || '', name: (res.user && res.user.username) || '' });
    api.setToken(res.token || '');
    const snap = await verify();
    return { ok: snap.signedIn, error: snap.error, user: snap.user, state: snap };
  },

  async signUp({ username, email, password } = {}) {
    const res = await api.register({ username, email, password });
    if (!res.ok) return { ok: false, error: res.error };
    saveApi({ token: res.token || '', email: (res.user && res.user.email) || email || '', name: (res.user && res.user.username) || '' });
    api.setToken(res.token || '');
    const snap = await verify();
    return { ok: snap.signedIn, error: snap.error, user: snap.user, state: snap };
  },

  async signOut() {
    await api.logoutRemote();
    saveApi({ token: '', email: '', name: '' });
    set({ status: auth.required() ? 'signedOut' : state.status, signedIn: false, user: null, error: '', offline: false, verifiedAt: 0 });
    emit();
    return snapshot();
  },

  async changePassword(current, next) {
    const res = await api.changePassword(current, next);
    if (!res.ok) return res;
    saveApi({ token: res.token || '' });
    return { ok: true };
  },

  /** The message every gated channel answers with. */
  refuse() {
    return {
      ok: false,
      authRequired: true,
      error: 'Sign in to Apex Launcher first.'
    };
  },

  startServer,

  /** Called when the window comes back to the foreground. */
  touch() {
    if (auth.required() && !state.signedIn && !state.checking) {
      firstCheck = null;
      ensureFirstCheck();
    }
  }
};

module.exports = auth;
module.exports.DEFAULT_SERVER = DEFAULT_SERVER;
