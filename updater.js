'use strict';

/**
 * Forced, silent auto-update (see package.json "build.publish").
 *
 * The launcher updates itself without asking: it checks the release feed on
 * launch and every few hours, downloads the new build in the background, and
 * then restarts straight into the installer. There is no "update now?" dialog
 * anywhere in this file, by design.
 *
 * The one thing that *does* hold it back is work in flight. Restarting in the
 * middle of a 40 GB install would leave a half-written game on disk, and
 * restarting with a game running would take the overlay down with it. So a
 * downloaded update waits until nothing is underway and then installs itself -
 * still with nobody pressing anything.
 *
 * Feed: GitHub Releases (owner/repo live in package.json). A build made with
 * `npm run release` uploads the installer, its .blockmap and latest.yml, which
 * is the file this reads. Only `app.isPackaged` builds update; a dev run is a
 * no-op unless APEX_UPDATE_DEV=1 points it at a local feed for testing.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Let the window paint and the launch-time sign-in check settle before we spend
// bandwidth on an update.
const FIRST_CHECK_MS = 10 * 1000;
const RECHECK_MS = 3 * 60 * 60 * 1000;
// How often a pending (blocked-by-work) update retries to install itself.
const RETRY_MS = 20 * 1000;

/** @type {any} */
let autoUpdater = null;
/** @type {NodeJS.Timeout|null} */
let firstTimer = null;
/** @type {NodeJS.Timeout|null} */
let intervalTimer = null;
/** @type {NodeJS.Timeout|null} */
let retryTimer = null;

let started = false;
let pendingInstall = false;
let busyFn = () => false;
let sendFn = () => {};
let logFn = () => {};

let status = {
  state: 'idle',        // idle | unsupported | checking | current | available | downloading | downloaded | installing | error
  version: null,        // the version being offered / downloaded
  current: null,        // this build's version
  percent: 0,
  error: null,
  at: Date.now()
};

/** A tiny file logger, because electron-updater's default logger is console-only. */
function fileLogger(file) {
  const write = (level, args) => {
    try {
      const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a && a.stack) || String(a)).join(' ')}\n`;
      fs.appendFileSync(file, line);
      // Keep it from growing without bound on a machine that never updates.
      if (fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '');
    } catch { /* logging must never break updating */ }
  };
  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    debug: (...a) => write('debug', a)
  };
}

function set(patch) {
  status = { ...status, ...patch, at: Date.now() };
  broadcast();
}

function broadcast() {
  try {
    sendFn(status);
  } catch { /* the renderer may be gone */ }
  // Mirrored to every window (the overlay counts as one) so a status badge is
  // never stale on whichever surface the user is looking at.
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:status', status);
    }
  } catch { /* ignore */ }
}

/**
 * Is the launcher in the middle of something a restart would ruin?
 * `isBusy` is supplied by main.js and watches the download queue + install jobs.
 */
function isBusy() {
  try { return !!busyFn(); } catch { return false; }
}

/** The install-on-quit path, minus the part where we ask permission. */
function installNow(reason) {
  if (!autoUpdater) return { ok: false, error: 'Updater is not available' };
  if (status.state !== 'downloaded') return { ok: false, error: 'No update has been downloaded yet' };
  if (isBusy()) {
    pendingInstall = true;
    logFn(`${reason || 'Update'} ready; waiting for downloads to finish before restarting`);
    armRetry();
    return { ok: true, deferred: true };
  }
  // Testing hook: the harness drives everything short of the installer itself.
  if (String(process.env.APEX_UPDATE_NO_INSTALL || '') === '1') {
    pendingInstall = true;
    logFn(`${reason || 'Update'} ready (APEX_UPDATE_NO_INSTALL=1, not installing)`);
    return { ok: true, skipped: true };
  }
  pendingInstall = false;
  clearRetry();
  set({ state: 'installing' });
  logFn(`Installing ${status.version} and restarting`);
  // isSilent=true so the NSIS assisted installer runs without its own UI;
  // isForceRunAfter=true so the launcher comes back up afterwards.
  setTimeout(() => {
    try { autoUpdater.quitAndInstall(true, true); }
    catch (err) { set({ state: 'error', error: (err && err.message) || String(err) }); }
  }, 1200);
  return { ok: true };
}

function armRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    if (!pendingInstall) { clearRetry(); return; }
    if (!isBusy()) installNow('Update');
  }, RETRY_MS);
  if (retryTimer.unref) retryTimer.unref();
}

function clearRetry() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
}

/** A manual check - the Settings button. Never throws at the caller. */
async function check() {
  if (!autoUpdater) return status;
  if (status.state === 'installing') return status;
  try {
    set({ state: 'checking', error: null });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ state: 'error', error: (err && err.message) || String(err) });
  }
  return status;
}

function wire(updater) {
  updater.on('checking-for-update', () => set({ state: 'checking', error: null }));

  updater.on('update-available', (info) => {
    set({ state: 'available', version: (info && info.version) || null, percent: 0, error: null });
    logFn(`Update ${(info && info.version) || '?'} available; downloading in the background`);
  });

  updater.on('update-not-available', () => set({ state: 'current', version: null, percent: 0 }));

  updater.on('download-progress', (p) => {
    set({
      state: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))),
      error: null
    });
  });

  updater.on('update-downloaded', (info) => {
    set({
      state: 'downloaded',
      version: (info && info.version) || status.version,
      percent: 100,
      error: null
    });
    installNow('Update');
  });

  updater.on('error', (err) => {
    set({ state: 'error', error: (err && err.message) || String(err) });
  });
}

/**
 * @param {{isBusy?:() => boolean, log?: (msg:string) => void}} options
 */
function init(options = {}) {
  if (started) return status;
  started = true;

  busyFn = typeof options.isBusy === 'function' ? options.isBusy : busyFn;
  logFn = typeof options.log === 'function' ? options.log : logFn;
  status.current = app.getVersion();

  const forceDev = String(process.env.APEX_UPDATE_DEV || '') === '1';
  if (!app.isPackaged && !forceDev) {
    // A dev run has no app-update.yml and nothing to update into.
    status.state = 'unsupported';
    return status;
  }

  let mod = null;
  try {
    ({ autoUpdater: mod } = require('electron-updater'));
  } catch (err) {
    status.state = 'unsupported';
    status.error = 'electron-updater is not installed';
    logFn(`Updater unavailable: ${(err && err.message) || err}`);
    return status;
  }
  if (!mod) {
    status.state = 'unsupported';
    status.error = 'electron-updater is not installed';
    return status;
  }

  autoUpdater = mod;
  try {
    autoUpdater.logger = fileLogger(path.join(app.getPath('userData'), 'update.log'));
  } catch { /* a logger is optional */ }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  // A local/generic feed for testing or self-hosting. Unset in a normal build,
  // where the GitHub provider baked in at package time is used.
  const feed = String(process.env.APEX_UPDATE_URL || '').trim().replace(/\/+$/, '');
  if (feed) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed, channel: 'latest' });
      logFn(`Update feed overridden to ${feed}`);
    } catch (err) {
      logFn(`Could not override the update feed: ${(err && err.message) || err}`);
    }
  }
  if (forceDev) autoUpdater.forceDevUpdateConfig = true;

  wire(autoUpdater);

  status.state = 'idle';
  broadcast();

  firstTimer = setTimeout(() => { void check(); }, FIRST_CHECK_MS);
  if (firstTimer.unref) firstTimer.unref();
  intervalTimer = setInterval(() => { void check(); }, RECHECK_MS);
  if (intervalTimer.unref) intervalTimer.unref();

  return status;
}

function stop() {
  clearRetry();
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}

function currentStatus() {
  return { ...status };
}

module.exports = {
  init,
  stop,
  check,
  status: currentStatus,
  installNow,
  // Called by main.js after the queue settles, so a deferred update installs
  // the moment the launcher stops working on something.
  releaseIfIdle: () => {
    if (pendingInstall && !isBusy()) installNow('Update');
  },
  onStatus: (fn) => { sendFn = typeof fn === 'function' ? fn : (() => {}); }
};
