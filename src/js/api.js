'use strict';

/**
 * Backend account + cloud sync (renderer side).
 *
 * A thin wrapper over the IPC bridge. The renderer never touches the network
 * directly, so the base URL and the bearer token stay in the main process where
 * they are out of the page's reach.
 *
 * Every call resolves to `{ ok, ... }` and never rejects, so a view can
 * `await Api.login(...)` inline and still show a real message on failure.
 */

const Api = {
  async status() {
    try { return await window.api.apiStatus(); } catch { return { ok: false, error: 'unavailable' }; }
  },

  /** Points the launcher at a backend. An empty URL disables cloud sync. */
  async configure(url) {
    try { return await window.api.apiConfigure(url); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  },

  async register(payload) {
    try { return await window.api.apiRegister(payload); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  },

  async login(payload) {
    try { return await window.api.apiLogin(payload); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  },

  async logout() {
    try { return await window.api.apiLogout(); } catch { return { ok: true }; }
  },

  async syncProfile(payload) {
    try { return await window.api.apiSyncProfile(payload); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  },

  async fetchProfile() {
    try { return await window.api.apiFetchProfile(); }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }
};

/**
 * The exact payload pushed to the backend. Kept in one place so the Profile
 * page and the Settings page can never disagree about what "the profile" is.
 *
 * Only identity and preference fields go up. The library, the install list and
 * every credential stay on this machine.
 */
function profilePayload() {
  const p = State.profile || {};
  const s = (typeof profileStats === 'function') ? profileStats() : {};
  return {
    name: p.name || '',
    bio: p.bio || '',
    avatar: p.avatarUrl || null,
    stats: {
      launches: Number(s.launches) || 0,
      playtimeMs: Number(s.totalMs) || 0
    },
    favorites: Object.keys(State.favorites || {}).filter((k) => State.favorites[k])
  };
}

/**
 * Signs in (or registers) and reports what happened. Shared by the Profile
 * account panel so the two cannot drift apart.
 *
 * @param {{email:string, password:string, username?:string}} creds
 * @param {boolean} isNew  true => register, false => login
 */
async function apiSignIn(creds, isNew) {
  const payload = isNew
    ? { username: creds.username, email: creds.email, password: creds.password }
    : { email: creds.email, password: creds.password };

  const res = isNew ? await Api.register(payload) : await Api.login(payload);
  if (!res.ok) return { ok: false, error: res.error || 'Sign-in failed.' };

  State.settings.api = {
    ...(State.settings.api || {}),
    signedIn: true,
    email: (res.user && res.user.email) || creds.email,
    name: (res.user && res.user.username) || creds.username || ''
  };
  await persist();
  return { ok: true, user: res.user || null };
}

/** Pushes the local profile up and stamps the time on it. */
async function apiPushProfile() {
  const res = await Api.syncProfile(profilePayload());
  if (!res.ok) return { ok: false, error: res.error || 'Sync failed.' };

  State.profile = { ...(State.profile || {}), cloudSyncAt: res.syncedAt || Date.now() };
  await persist();
  return { ok: true, at: res.syncedAt || State.profile.cloudSyncAt };
}

/** Pulls the backend's copy down, keeping whatever it holds for name/bio/avatar. */
async function apiPullProfile() {
  const res = await Api.fetchProfile();
  if (!res.ok) return { ok: false, error: res.error || 'Could not load the cloud profile.' };

  const d = res.data || {};
  State.profile = {
    ...(State.profile || {}),
    name: d.name || State.profile.name || '',
    bio: typeof d.bio === 'string' ? d.bio : (State.profile.bio || ''),
    avatarUrl: d.avatar || State.profile.avatarUrl || null,
    cloudSyncAt: d.syncedAt || Date.now()
  };
  await persist();
  return { ok: true };
}

/** Signs out. The token lives in the main process, so this only clears the UI. */
async function apiSignOut() {
  await Api.logout();
  State.settings.api = { ...(State.settings.api || {}), signedIn: false, email: '', name: '' };
  State.profile = { ...(State.profile || {}), cloudSyncAt: null };
  await persist();
  return { ok: true };
}
