'use strict';

/**
 * Backend API client (main process).
 *
 * Everything the launcher needs to talk to the Apex Launcher backend: signing
 * in, and pushing/pulling the user's profile so it follows them between
 * machines.
 *
 * The client is deliberately dumb about where it lives. The base URL comes
 * from Settings > Account, so pointing Apex at a different server — or at none
 * at all — is a setting and not a code change. When no base URL is configured
 * the client reports `configured: false` and every call fails with a readable
 * error instead of throwing at import time.
 *
 * Auth is a bearer token. It is held in memory here and mirrored into local
 * state by the IPC handlers, so it survives a restart but is only ever sent to
 * the configured backend — never to a storefront, a CDN or an analytics host.
 */

const DEFAULT_TIMEOUT = 15000;

let baseUrl = '';
let token = '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimBase(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * A server has to be HTTPS - the credentials cross it - but a *local* server is
 * the normal case for a self-hosted install, and nobody runs TLS on loopback.
 * So plain HTTP is allowed, and only for a loopback host.
 */
const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

function isUsable(url) {
  return /^https:\/\//i.test(url) || LOOPBACK_RE.test(url);
}

/**
 * One HTTP call. Always resolves to `{ ok, ... }` — never rejects — so a
 * renderer can `await` it without a try/catch and still show a real message.
 */
async function request(method, path, { body = null, auth = true, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!isUsable(baseUrl)) {
    return { ok: false, error: 'No backend server is set. Add one in Settings > Account.' };
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body == null ? null : JSON.stringify(body),
      signal: ctl.signal
    });

    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || `The backend responded with ${res.status}.`;
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, data: json == null ? {} : json };
  } catch (err) {
    const aborted = !!(err && err.name === 'AbortError');
    return {
      ok: false,
      error: aborted ? 'The backend took too long to answer.' : `Could not reach the backend: ${err.message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  /** Points the client at a backend. An empty URL disables it. */
  configure(rawUrl) {
    baseUrl = trimBase(rawUrl);
    return api.status();
  },

  /** Where the client stands, for the Settings and Profile surfaces. */
  status() {
    return {
      ok: true,
      configured: isUsable(baseUrl),
      baseUrl: isUsable(baseUrl) ? baseUrl : '',
      hasToken: !!token
    };
  },

  setToken(next) {
    token = String(next || '').trim();
    return api.status();
  },

  getToken() {
    return token;
  },

  /**
   * Creates an account. The backend is expected to answer with a token and the
   * user record; both are kept so the user is signed in straight away.
   */
  async register({ username, email, password } = {}) {
    const name = String(username || '').trim();
    const mail = String(email || '').trim();
    if (!name) return { ok: false, error: 'Pick a username first.' };
    if (!EMAIL_RE.test(mail)) return { ok: false, error: 'That email address does not look right.' };
    if (String(password || '').length < 6) {
      return { ok: false, error: 'Use at least 6 characters for the password.' };
    }

    const res = await request('POST', '/auth/register', {
      body: { username: name, email: mail, password },
      auth: false
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (res.data && res.data.token) token = String(res.data.token);
    return { ok: true, token: api.getToken(), user: res.data.user || { username: name, email: mail } };
  },

  async login({ email, password } = {}) {
    const mail = String(email || '').trim();
    if (!EMAIL_RE.test(mail)) return { ok: false, error: 'That email address does not look right.' };
    if (!password) return { ok: false, error: 'Enter your password.' };

    const res = await request('POST', '/auth/login', {
      body: { email: mail, password },
      auth: false
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (res.data && res.data.token) token = String(res.data.token);
    return { ok: true, token: api.getToken(), user: res.data.user || { email: mail } };
  },

  /** Drops the token locally. The account itself lives on the backend. */
  logout() {
    token = '';
    return { ok: true };
  },

  /**
   * Asks the backend to retire the session, then clears it locally. Best effort
   * on purpose: signing out must work with the server down.
   */
  async logoutRemote() {
    try { await request('POST', '/auth/logout'); } catch { /* the local clear is what matters */ }
    return api.logout();
  },

  /**
   * Who the current token belongs to. This is the call the launcher's sign-in
   * gate is built on, so it takes a shorter timeout than the default: a gate
   * that hangs for fifteen seconds reads as a broken app.
   */
  async me({ timeoutMs = 6000 } = {}) {
    if (!isUsable(baseUrl)) return { ok: false, error: 'No server is configured.', status: 0, unconfigured: true };
    if (!token) return { ok: false, error: 'Not signed in.', status: 401, signedOut: true };

    const res = await request('GET', '/auth/me', { timeoutMs });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: 'That session is no longer valid.', status: 401, signedOut: true };
      const offline = res.status === undefined;
      return { ok: false, error: res.error, status: res.status, offline };
    }
    return { ok: true, user: res.data.user, events: res.data.events || [] };
  },

  /** Is anything answering at the configured address? */
  async health({ timeoutMs = 4000 } = {}) {
    if (!isUsable(baseUrl)) return { ok: false, error: 'No server is configured.', unconfigured: true };
    const res = await request('GET', '/health', { auth: false, timeoutMs });
    return res.ok ? { ok: true, ...res.data } : { ok: false, error: res.error };
  },

  /** Changes the password and adopts the replacement token the server mints. */
  async changePassword(current, next) {
    const res = await request('POST', '/auth/password', { body: { current, next } });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    if (res.data && res.data.token) token = String(res.data.token);
    return { ok: true, token: api.getToken(), user: res.data && res.data.user };
  },

  /**
   * Pushes the local profile up. Only the fields a user is allowed to set are
   * sent — never the library, the install list or any credentials.
   */
  async syncProfile(payload = {}) {
    const clean = {
      name: String(payload.name || '').trim(),
      bio: String(payload.bio || '').trim(),
      avatar: payload.avatar || null,
      stats: {
        launches: Number(payload.stats && payload.stats.launches) || 0,
        playtimeMs: Number(payload.stats && payload.stats.playtimeMs) || 0
      },
      favorites: Array.isArray(payload.favorites) ? payload.favorites : [],
      syncedAt: Date.now()
    };
    const res = await request('PUT', '/profile', { body: clean });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, syncedAt: clean.syncedAt, data: res.data };
  },

  /** Pulls the profile the backend holds for this account. */
  async fetchProfile() {
    const res = await request('GET', '/profile');
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: res.data || {} };
  }
};

module.exports = api;
