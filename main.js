'use strict';

/**
 * Apex Launcher - main process
 * ---------------------------------
 * Owns the window, the system tray, persistent state on disk and the small
 * set of IPC channels the renderer is allowed to use.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const detect = require('./detect');
const drives = require('./drives');
const steamwatch = require('./steamwatch');
const gameLaunch = require('./launch');
const procs = require('./procs');
const verify = require('./verify');
const catalog = require('./catalog');
const news = require('./news');
const coverart = require('./coverart');
const logoart = require('./logoart');
const installs = require('./installs');
const uninstall = require('./uninstall');
const perf = require('./perf');
const shots = require('./shots');
const steamapi = require('./steamapi');
const lightningtools = require('./lightningtools');
const providers = require('./net/providers');
const { DownloadQueue } = require('./net/queue');
const itch = require('./net/itch');
const api = require('./net/api');
const auth = require('./auth');
const discord = require('./discord');
const updater = require('./updater');

const APP_NAME = 'Apex Launcher';
app.setName(APP_NAME);

/** @type {BrowserWindow|null} */
let win = null;
/** @type {BrowserWindow|null} */
let splash = null;
/** @type {Tray|null} */
let tray = null;
let quitting = false;

// How long the splash stays up at minimum, so a fast start does not flash.
const SPLASH_MIN_MS = 1400;
let splashStart = 0;
let splashTimer = null;
let mainShown = false;

const stateFile = () => path.join(app.getPath('userData'), 'apex-state.json');
const projectDir = () => app.getAppPath();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Bumped to 3 when the Library became "installed games only".
 * Older files carried a hard-coded demo seed that made games look installed
 * when they were not, so we drop that seed on first load of a v3 build.
 */
const STATE_VERSION = 3;

function defaults() {
  const root = projectDir();
  // Packaged builds run from a read-only app.asar, so the working-folder
  // defaults only make sense in development. In a real install, put games and
  // downloads somewhere the user actually owns.
  const gamesDir = app.isPackaged
    ? path.join(app.getPath('documents'), 'Apex Games')
    : path.join(root, 'Games');
  const downloadsDir = app.isPackaged
    ? path.join(app.getPath('downloads'), 'Apex Launcher')
    : path.join(root, 'Downloads');
  return {
    version: STATE_VERSION,
    settings: {
      theme: 'dark',                 // dark | oled | neon
      accent: '#00a8ff',
      reduceMotion: false,
      minimizeToTray: true,
      hideOnMinimize: false,
      // Custom full-app background image (path on disk) + how strongly it shows.
      background: null,
      backgroundOpacity: 45,
      backgroundBlur: 0,
      startOnBoot: false,
      notifications: true,
      autoUpdate: true,
      cloudSaves: true,
      telemetry: false,
      bandwidth: 'unlimited',        // unlimited | 50 | 25 | 10  (MB/s cap)
      installPath: gamesDir,
      downloadPath: downloadsDir,
      installDrive: null,            // e.g. 'D:' - the drive chosen for installs
      // Frosted-glass sidebar over the wallpaper (Settings > Appearance).
      glassSidebar: true,
      // --- input & presentation ---------------------------------------------
      // Gamepad detection, connection notifications and d-pad navigation.
      controller: true,
      // Synthesised UI sound effects (see src/js/sfx.js) and how loud they are.
      uiSounds: true,
      uiVolume: 60,                  // 0..100
      // Big Picture takes the whole screen while it is open.
      bigPictureFullscreen: true,
      // --- download engine (see installs.js + net/) -------------------------
      // Where the download pipeline looks for authorised content. Empty
      // `manifests` means only a pasted direct URL (Settings) can be fetched.
      download: {
        connections: 4,          // parallel HTTP connections per transfer
        manifests: [],           // absolute paths to manifest JSON files
        allowedHosts: [],        // non-empty => allowlist of download hosts
        requireChecksum: true,   // refuse items without a valid sha256
        queueConcurrency: 2      // how many queued jobs installs.js runs at once
      },
      // --- artwork lookup (see coverart.js / logoart.js) --------------------
      // The transparent wordmark resolver can also consult SteamGridDB, but only
      // with the user's own API key (steamgriddb.com/profile/preferences). Left
      // empty it still uses the Steam CDN's own logos plus the keyless lookup.
      art: {
        steamgriddbKey: ''
      },
      // --- itch.io (see net/itch.js) ----------------------------------------
      // Browsing itch.io needs nothing. Downloading a build needs the user's own
      // API key, because itch.io only hands a file URL to an account it can
      // identify; the key is stored here, locally, and never sent anywhere else.
      itch: {
        apiKey: '',
        username: ''             // remembered so Settings can show who is connected
      },
      // --- Discord Rich Presence (see discord.js) ---------------------------
      // Off until the user pastes the Application ID of their own Discord app
      // (discord.com/developers). Nothing is sent anywhere: Apex writes to the
      // local Discord client's IPC socket and nothing else.
      discord: {
        enabled: false,
        clientId: ''
      },
      // --- backend account / cloud sync (see net/api.js) -------------------
      // Pre-filled with the address the bundled backend listens on, so a fresh
      // install has a working sign-in screen as soon as `npm run serve` is up.
      // Point it at any other Apex backend and everything here follows.
      api: {
        baseUrl: 'http://127.0.0.1:8787',
        token: '',               // bearer token; only ever sent to baseUrl
        email: '',               // who is signed in, for the UI
        name: ''                 // their username, for the UI
      },
      // --- the sign-in gate (see auth.js) ----------------------------------
      // With this on, the launcher refuses to launch, install or download until
      // the backend has vouched for a session. Turning it off is the sign-in
      // screen's escape hatch, and it is remembered.
      auth: {
        required: true
      },
      // --- Project Lightning tools (see lightningtools.js) ------------------
      // Remembered folders for the Bypass / OnlineFix apply dialog and the
      // SteamLess DLL swap. Stored locally and never uploaded anywhere.
      pl: {
        fixSource: '',           // a folder the user prepared with fix files
        steamlessSource: '',     // the replacement steam_api(_64).dll folder
        lastGameFolder: '',      // last game folder a fix was applied to
        gofileToken: ''          // optional GoFile account token (enables GoFile mirrors)
      },
      // --- performance overlay (see perf.js + overlay/) ---------------------
      // F8 floats a click-through panel over whatever is running. Every number
      // it shows is measured; see perf.js for why there is no pretend in-game
      // FPS readout. `auto` makes it appear by itself when a game is launched.
      overlay: {
        enabled: true,
        auto: true,
        key: 'F8',
        corner: 'top-left',      // top-left | top-right | bottom-left | bottom-right
        opacity: 92              // 0..100
      },
      // --- screenshots (see shots.js) --------------------------------------
      screenshot: {
        enabled: true,
        key: 'F2',
        sound: true              // play the shutter sound on capture
      },
      // --- achievements (see src/js/achieve.js + steamapi.js) ---------------
      // Apex's own achievements always work. The Steam half needs the user's own
      // Web API key (steamcommunity.com/dev/apikey) and their SteamID64; nothing
      // is fetched without both.
      achievements: {
        enabled: true,
        steam: {
          apiKey: '',
          steamId: ''
        }
      }
    },
    // The library starts empty and is populated by real Steam/Epic detection
    // plus games the user installs from the store.
    installed: {},
    owned: {},
    updates: {},
    favorites: {},
    stats: { launches: 0, lastPlayed: {}, playtime: {} },
    // games the user explicitly removed; a rescan must not bring them back
    dismissed: {},
    // user-added games and real local installs discovered / linked on this PC
    custom: [],
    art: {},
    // Artwork Apex looked up online for titles that shipped none of their own
    // (id -> image URL). Kept apart from `art` so the user's own pictures always
    // win and are never overwritten by a refresh.
    artAuto: {},
    // Transparent hero wordmarks resolved online (id -> image URL), kept apart
    // from `artAuto` because a logo is not a banner and is resolved by a
    // different module (logoart.js).
    logoAuto: {},
    installDirs: {},
    local: { installs: {}, roots: {}, stores: {} },
    // The user's own profile: display name, avatar (stored as a local file
    // path plus a data URL for display) and a short blurb.
    profile: { name: '', avatar: null, avatarUrl: null, bio: '', theme: 'flame' },
    // Cached gaming news so the tab still renders when the PC is offline.
    news: { items: [], fetchedAt: null, lang: 'fr' },
    // Last real file-verification report per game id (see verify.js).
    verify: {},
    // Titles the user registered pre-order interest in.
    preorders: {},
    // User-made library collections: id -> { name, games: [gameId, ...] }.
    collections: {},
    // Achievements Apex has awarded (achievement id -> unix ms it was earned).
    achievements: {},
    // Which of Steam's achievements the user has already been told about, per
    // appId (apiName -> unlocktime). A toast fires exactly once per unlock.
    steamSeen: {},
    // Playtime already credited towards achievements, so a long session is only
    // counted once (game id -> seconds already awarded).
    credited: {},
    // The changelog version the user has already read, so "What's new" can show
    // itself exactly once per update.
    seenChangelog: null
  };
}

function load() {
  const d = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // v1/v2 shipped with a demo library seed; discard it once.
    const legacy = (Number(raw.version) || 0) < STATE_VERSION;
    return {
      version: STATE_VERSION,
      settings: {
        ...d.settings,
        ...(raw.settings || {}),
        // settings.download is nested: a shallow spread would drop its
        // defaults the moment an older state file carries any of its keys.
        download: { ...d.settings.download, ...((raw.settings && raw.settings.download) || {}) },
        art: { ...d.settings.art, ...((raw.settings && raw.settings.art) || {}) },
        itch: { ...d.settings.itch, ...((raw.settings && raw.settings.itch) || {}) },
        discord: { ...d.settings.discord, ...((raw.settings && raw.settings.discord) || {}) },
        api: { ...d.settings.api, ...((raw.settings && raw.settings.api) || {}) },
        pl: { ...d.settings.pl, ...((raw.settings && raw.settings.pl) || {}) },
        overlay: { ...d.settings.overlay, ...((raw.settings && raw.settings.overlay) || {}) },
        screenshot: { ...d.settings.screenshot, ...((raw.settings && raw.settings.screenshot) || {}) },
        achievements: {
          ...d.settings.achievements,
          ...((raw.settings && raw.settings.achievements) || {}),
          steam: { ...d.settings.achievements.steam, ...(((raw.settings || {}).achievements || {}).steam || {}) }
        }
      },
      installed: legacy ? {} : (raw.installed || {}),
      owned: legacy ? {} : (raw.owned || {}),
      updates: legacy ? {} : (raw.updates || {}),
      favorites: legacy ? {} : (raw.favorites || {}),
      stats: legacy ? { ...d.stats } : { ...d.stats, ...(raw.stats || {}) },
      dismissed: legacy ? {} : (raw.dismissed || {}),
      custom: Array.isArray(raw.custom) ? raw.custom : d.custom,
      // per-game custom artwork overrides (Settings/Properties > Custom art)
      art: (raw.art && typeof raw.art === 'object') ? raw.art : {},
      // Artwork resolved online for titles that shipped none of their own.
      artAuto: (raw.artAuto && typeof raw.artAuto === 'object') ? raw.artAuto : {},
      // Transparent hero wordmarks resolved online.
      logoAuto: (raw.logoAuto && typeof raw.logoAuto === 'object') ? raw.logoAuto : {},
      // per-game install folders chosen in the installer
      installDirs: (raw.installDirs && typeof raw.installDirs === 'object') ? raw.installDirs : {},
      local: {
        installs: (raw.local && raw.local.installs) || {},
        roots: (raw.local && raw.local.roots) || {},
        stores: (raw.local && raw.local.stores) || {}
      },
      // User profile (name, avatar, blurb). Never dropped by a version bump.
      profile: { ...d.profile, ...(raw.profile || {}) },
      // Last good news payload, so the tab opens instantly and works offline.
      news: (raw.news && Array.isArray(raw.news.items))
        ? { items: raw.news.items, fetchedAt: raw.news.fetchedAt || null, lang: raw.news.lang || 'fr' }
        : d.news,
      verify: (raw.verify && typeof raw.verify === 'object') ? raw.verify : {},
      preorders: (raw.preorders && typeof raw.preorders === 'object') ? raw.preorders : {},
      // User-made library collections. Never dropped by a version bump.
      collections: (raw.collections && typeof raw.collections === 'object' && !Array.isArray(raw.collections))
        ? raw.collections : {},
      // Apex's own achievements, plus what the user has already been told about
      // Steam's, and the playtime already credited. All additive: a version bump
      // must never wipe earned achievements.
      achievements: (raw.achievements && typeof raw.achievements === 'object') ? raw.achievements : {},
      steamSeen: (raw.steamSeen && typeof raw.steamSeen === 'object') ? raw.steamSeen : {},
      credited: (raw.credited && typeof raw.credited === 'object') ? raw.credited : {},
      seenChangelog: raw.seenChangelog || null
    };
  } catch {
    return d;
  }
}

function save(state) {
  const dir = path.dirname(stateFile());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...state, version: STATE_VERSION }, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile()); // atomic-ish write
  return true;
}

// ---------------------------------------------------------------------------
// Renderer-safe state
// ---------------------------------------------------------------------------
// The session belongs to the main process. The renderer never receives the
// token (so it cannot leak it, log it or hand it to a page), and a renderer
// save cannot blank or forge one - which matters, because the renderer holds a
// snapshot of the settings from boot and would otherwise overwrite the token
// with the empty string it was given. Everything else in the file really is the
// renderer's to manage.
function rendererState() {
  const st = load();
  const api = { ...(st.settings.api || {}) };
  api.signedIn = !!api.token;
  delete api.token;
  st.settings.api = api;
  return st;
}

function mergeSession(state) {
  const prev = (load().settings || {}).api || {};
  state.settings = state.settings || {};
  state.settings.api = {
    ...(state.settings.api || {}),
    token: prev.token || '',
    email: prev.email || '',
    name: prev.name || ''
  };
  delete state.settings.api.signedIn;
  return state;
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const h = String(hex || '#00a8ff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Draws a small accent rounded square with a white play glyph (BGRA bitmap).
function trayIcon(accent) {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = hexToRgb(accent);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x > 2 && x < size - 3 && y > 2 && y < size - 3;
      const tri = x >= 11 && x <= 22 && Math.abs(y - 15.5) <= (22 - x) * 0.78;
      let cr = 0, cg = 0, cb = 0, ca = 0;
      if (inside) { cr = r; cg = g; cb = b; ca = 255; }
      if (tri) { cr = 255; cg = 255; cb = 255; ca = 255; }
      buf[i] = cb; buf[i + 1] = cg; buf[i + 2] = cr; buf[i + 3] = ca;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showWin() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  if (tray) {
    tray.setImage(trayIcon(load().settings.accent));
    return;
  }
  tray = new Tray(trayIcon(load().settings.accent));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Apex Launcher', click: showWin },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWin);
  tray.on('double-click', showWin);
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------

/** A small frameless loading card shown while the launcher starts up. */
function createSplash() {
  splashStart = Date.now();
  splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  splash.loadFile(path.join(__dirname, 'src', 'splash.html'));
  splash.once('ready-to-show', () => { if (splash) splash.show(); });
  splash.on('closed', () => { splash = null; });
}

/**
 * Reveals the main window: holds until the splash has been up for its minimum
 * time, then cross-fades the window in. Idempotent - the renderer's ready ping
 * and the `ready-to-show` handler can both call it.
 */
function revealMain() {
  if (!win || mainShown) return;
  mainShown = true;
  clearTimeout(splashTimer);

  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashStart));
  setTimeout(() => {
    if (splash) { try { splash.close(); } catch { /* already gone */ } splash = null; }
    if (!win) return;
    try { win.setOpacity(0); } catch { /* not supported: just show */ }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    let o = 0;
    const step = setInterval(() => {
      o = Math.min(1, o + 0.09);
      try { win.setOpacity(o); } catch { /* ignore */ }
      if (o >= 1) clearInterval(step);
    }, 16);
  }, wait);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * True full screen, toggled by F11 or by the UI. The renderer is told through
 * `win:fullscreen` (see the enter/leave handlers below) so its chrome can hide
 * the title bar while the window owns the screen.
 */
function toggleFullScreen(force) {
  if (!win || win.isDestroyed()) return false;
  const next = typeof force === 'boolean' ? force : !win.isFullScreen();
  win.setFullScreen(next);
  return next;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#0b0d12',
    title: APP_NAME,
    icon: trayIcon('#00a8ff'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // --- full screen ----------------------------------------------------------
  // A frameless window carries no menu, so there is no built-in accelerator for
  // this. `before-input-event` sees the key before the page does, so F11 works
  // even while a text field has focus and never leaks into the UI.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || input.code === 'F11') {
      e.preventDefault();
      toggleFullScreen();
    }
  });

  // Keep the renderer's chrome in step with the real window state — whichever
  // way the change came about (F11, the UI button, or the OS).
  const sendFs = (v) => { if (win && !win.isDestroyed()) win.webContents.send('win:fullscreen', v); };
  win.on('enter-full-screen', () => sendFs(true));
  win.on('leave-full-screen', () => sendFs(false));

  win.once('ready-to-show', () => {
    // The renderer tells us the moment its first paint is done; this is the
    // safety net so a broken renderer never strands the user on the splash.
    splashTimer = setTimeout(revealMain, 8000);
  });
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  // A locked app re-checks whenever it comes back to the front: that is exactly
  // when somebody has just started the backend from another window.
  win.on('focus', () => { try { auth.touch(); } catch { /* never block a focus */ } });
  win.on('closed', () => { win = null; });

  // Optional: hide to the tray instead of the taskbar when minimising.
  win.on('minimize', (e) => {
    if (load().settings.hideOnMinimize) {
      e.preventDefault();
      ensureTray();
      win.hide();
    }
  });

  win.on('close', (e) => {
    if (!quitting && load().settings.minimizeToTray) {
      e.preventDefault();
      ensureTray();
      win.hide();
    }
  });

  // Open external links in the OS browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.on('win:min', () => win && win.minimize());
ipcMain.on('win:max', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('win:show', showWin);
ipcMain.on('app:quit', () => { quitting = true; app.quit(); });
// Sent once the renderer has painted; dismisses the splash screen.
ipcMain.on('app:ready', () => revealMain());
ipcMain.handle('win:isMaximized', () => !!(win && win.isMaximized()));

// Full screen. `force` is optional: without it the state simply flips, which is
// what the F11 key and the title-bar button both want.
ipcMain.on('win:fullscreen', (_e, force) => toggleFullScreen(force));
ipcMain.handle('win:isFullscreen', () => !!(win && win.isFullScreen()));

// --- download engine --------------------------------------------------------
// The renderer only ever receives *validated* items: net/sources.js owns the
// host policy, installs.js owns download -> verify -> extract -> install.
// net/queue.js sits in front of the engine to admit at most N jobs at a time;
// it validates nothing itself, so a refusal can only ever come from the
// engine's own host/checksum policy.
let downloadQueue = null;

installs.init({
  send: (evt) => {
    if (win && !win.isDestroyed()) win.webContents.send('dl:event', evt);
    // The queue tracks slot usage off the same stream the renderer consumes.
    try { if (downloadQueue) downloadQueue.onJobEvent(evt); } catch { /* never block the engine */ }
    // A job reaching a terminal state can be the moment a pending update stops
    // being blocked (see updateBlocked / updater.releaseIfIdle).
    if (evt && evt.type === 'job' && TERMINAL_JOB.has(String(evt.state || ''))) updater.releaseIfIdle();
  },
  getSettings: () => load().settings,
  userDataDir: app.getPath('userData'),
  appDir: __dirname
});

downloadQueue = new DownloadQueue({
  // `installs.start` *is* the admission gate: it resolves the source and runs
  // SourceRegistry.validate before it creates a job, so anything refused there
  // (a blocked host, a missing checksum) never takes a queue slot.
  start: (target, ctx) => installs.start(target, { settings: load().settings, ...(ctx || {}) }),
  controller: {
    pause: (id) => installs.pause(id),
    resume: (id) => installs.resume(id),
    cancel: (id) => installs.cancel(id)
  },
  concurrency: Number((load().settings.download || {}).queueConcurrency) || 2,
  maxConcurrency: 4,
  onLog: (level, msg) => console.log(`[queue] ${msg}`)
});

downloadQueue.on('event', (evt) => {
  if (win && !win.isDestroyed()) win.webContents.send('dlq:event', evt);
  // A slot freeing up may be exactly what a waiting update was held back for.
  updater.releaseIfIdle();
});

// --- what counts as "busy", for the updater ---------------------------------
// A forced update restarts the app, so it must not do that mid-transfer,
// mid-install, or while a game is up (that would take the overlay and Rich
// Presence down with it). Both download surfaces are checked: the queue's own
// slots, and the engine's live jobs (a bare `dl:start` never goes through the
// queue).
const TERMINAL_JOB = new Set(['done', 'cancelled', 'error']);
function updateBlocked() {
  try {
    const d = downloadQueue && downloadQueue.depth;
    if (d && (d.active > 0 || d.pending > 0)) return true;
  } catch { /* ignore */ }
  try {
    if (installs.list().some((j) => !TERMINAL_JOB.has(String(j.state || '')))) return true;
  } catch { /* ignore */ }
  try {
    if (procs.list().length > 0) return true;
  } catch { /* ignore */ }
  return false;
}

// --- Project Lightning tools (see lightningtools.js) ------------------------
// The Bypass / OnlineFix catalogues, fix application and the SteamLess DLL
// swap. The catalogues are plain metadata (bundled in `data/`, refreshable from
// the project's GitHub); a fix only ever writes files the user already has on
// disk or points Apex at, and every file it replaces is backed up first.
lightningtools.init({
  userDataDir: app.getPath('userData'),
  appDir: __dirname,
  log: (level, msg) => console.log(`[lightningtools] ${msg}`)
});

// --- backend account / cloud sync -------------------------------------------
// The client is configured from local state so a restart keeps the session.
// net/api.js owns the HTTP; these handlers only move data in and out. Signing in
// is auth.js's job, so the account panel and the sign-in gate cannot drift apart.
const apiSettings = () => (load().settings.api || {});
api.configure(apiSettings().baseUrl);
api.setToken(apiSettings().token);

// The gate is armed before anything can be asked of it. `onChanged` pushes a
// fresh snapshot at the renderer, which is how an expiry or a sign-out reaches a
// window that is already open.
//
// `_smoke.js` and friends boot this very main process and drive the real
// renderer, which never signs in. They are recognised here by name and get their
// throwaway state file disarmed - rather than the gate growing a test-only code
// path, it has exactly one behaviour and the harness simply starts from a
// different setting. (Electron passes the script name as a bare relative path,
// so the directory separator is optional in the pattern.)
//
// `_gate-check.js` is deliberately NOT in this list: it exists to test the gate
// while it is armed, so disarming it would quietly turn that harness into a no-op.
const HARNESS = /(^|[\\/])_(smoke|download-test|render-test|feat-check)\.js$/i.test(String(process.argv[1] || ''));

if (HARNESS) {
  const st = load();
  st.settings.auth = { ...(st.settings.auth || {}), required: false };
  save(st);
}

auth.init({
  load,
  save,
  dataDir: app.getPath('userData'),
  onChanged: (snap) => {
    if (win && !win.isDestroyed()) win.webContents.send('auth:changed', snap);
  }
});

// The renderer is not the gate - a reloaded page or an open devtools console can
// ask for anything. This is what actually stops a signed-out launcher from
// launching a game, and every privileged channel goes through it.
/**
 * Registers an IPC channel that only works while the user is signed in.
 * @param {string} channel
 * @param {(event:any, ...args:any[]) => any} fn
 */
function handleAuthed(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!auth.allow()) return auth.refuse();
    return fn(event, ...args);
  });
}

ipcMain.handle('api:status', () => ({ ...api.status(), ...auth.snapshot() }));
ipcMain.handle('api:configure', async (_e, url) => {
  const snap = await auth.configure(url);
  return { ...api.status(), baseUrl: snap.baseUrl };
});
// Both sign-in routes run through auth.js so there is exactly one place that
// decides what a valid session is.
ipcMain.handle('api:register', (_e, payload) => auth.signUp(payload || {}));
ipcMain.handle('api:login', (_e, payload) => auth.signIn(payload || {}));
ipcMain.handle('api:logout', () => auth.signOut());
ipcMain.handle('api:sync', (_e, payload) => api.syncProfile(payload));
ipcMain.handle('api:fetch', () => api.fetchProfile());

// --- the sign-in gate (see auth.js) -----------------------------------------
ipcMain.handle('auth:state', async () => {
  // Waits for the launch-time check, so the renderer gets a real answer in one
  // round trip instead of painting "checking..." and polling for the truth.
  await auth.ready();
  return auth.snapshot();
});
ipcMain.handle('auth:signIn', (_e, creds) => auth.signIn(creds || {}));
ipcMain.handle('auth:signUp', (_e, creds) => auth.signUp(creds || {}));
ipcMain.handle('auth:signOut', () => auth.signOut());
ipcMain.handle('auth:configure', (_e, url) => auth.configure(url));
ipcMain.handle('auth:recheck', () => auth.recheck());
ipcMain.handle('auth:startServer', () => auth.startServer());
ipcMain.handle('auth:relax', () => auth.relax());
ipcMain.handle('auth:require', () => auth.require());
ipcMain.handle('auth:changePassword', (_e, payload) => {
  const p = payload || {};
  return auth.changePassword(p.current, p.next);
});
// Opens the companion site in the user's browser: it is the one place with the
// installer, and the only place with an account page you can reach without
// already being signed in. Only the configured address (plus a known fragment)
// is ever opened, so this cannot be turned into "open any URL".
ipcMain.handle('site:open', (_e, where) => {
  const base = String((load().settings.api || {}).baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:/i.test(base)) return { ok: false, error: 'No server address is set.' };
  const frag = where === 'download' ? '/#download' : (where === 'account' ? '/#account' : '/');
  shell.openExternal(base + frag);
  return { ok: true };
});

ipcMain.handle('dl:search', (_e, query) => installs.search(query));
ipcMain.handle('dl:list', () => installs.list());
handleAuthed('dl:start', (_e, target) => installs.start(target, { settings: load().settings }));
ipcMain.handle('dl:pause', (_e, id) => installs.pause(id));
ipcMain.handle('dl:resume', (_e, id) => installs.resume(id));
ipcMain.handle('dl:cancel', (_e, id) => installs.cancel(id));

// --- download queue (see net/queue.js) --------------------------------------
// Ordering + admission control over the engine above. An entry that fails the
// host policy is refused here and reported as a `refused` record, never queued.
handleAuthed('dlq:enqueue', (_e, target, ctx) => downloadQueue.enqueue(target || {}, ctx || {}));
ipcMain.handle('dlq:list', () => downloadQueue.list());
ipcMain.handle('dlq:pause', (_e, id) => downloadQueue.pause(id));
ipcMain.handle('dlq:resume', (_e, id) => downloadQueue.resume(id));
ipcMain.handle('dlq:cancel', (_e, id) => downloadQueue.cancel(id));
ipcMain.handle('dlq:clear', (_e, opts) => downloadQueue.clear(opts || {}));
ipcMain.handle('dlq:concurrency', (_e, n) => {
  const res = downloadQueue.setConcurrency(n);
  // Remembered so the next launch opens with the same setting.
  const st = load();
  st.settings.download = { ...(st.settings.download || {}), queueConcurrency: res.concurrency };
  save(st);
  return res;
});

// --- real uninstalls (see uninstall.js) -------------------------------------
// The main process owns the delete target. The renderer only sends a game id;
// the paths are re-derived from Apex's own state file and checked against
// safeTarget(), so nothing here can be talked into removing an arbitrary folder.
// Content another launcher owns is handed back to that launcher instead.
uninstall.init({
  getState: load,
  userDataDir: app.getPath('userData'),
  appDir: __dirname
});

handleAuthed('uninstall:plan', async (_e, id) => {
  try { return await uninstall.plan(String(id || ''), load()); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not inspect that install' }; }
});

handleAuthed('uninstall:delete', async (_e, id) => {
  try { return await uninstall.remove(String(id || ''), load()); }
  catch (err) {
    return { ok: false, freed: 0, removed: [], blocked: [], errors: [{ error: (err && err.message) || 'Uninstall failed' }] };
  }
});

handleAuthed('uninstall:store', async (_e, id) => {
  const target = uninstall.storeUri(String(id || ''), load());
  if (!target.ok) return { ok: false, store: target.store || null };
  const proto = String(target.uri).slice(0, String(target.uri).indexOf(':') + 1).toLowerCase();
  if (!gameLaunch.ALLOWED_PROTOCOLS.has(proto)) return { ok: false, store: target.store };
  try {
    await shell.openExternal(target.uri);
    return { ok: true, store: target.store, uri: target.uri };
  } catch (err) {
    return { ok: false, store: target.store, error: err.message };
  }
});

// --- performance overlay, screenshots & hotkeys ------------------------------
// Both global hotkeys are registered here rather than in a module, so there is
// exactly one place that owns "which key does what" and one place that gives the
// keys back on quit. The defaults (F8 / F2) are the ones the user asked for; both
// are configurable in Settings, because a game may want them for itself.
let overlayAutoShown = false;
let shotBusy = false;

/** Registers an accelerator without ever throwing on a bad one. */
function safeShortcut(accelerator, handler) {
  if (!accelerator) return false;
  try {
    globalShortcut.unregister(accelerator);
    return globalShortcut.register(accelerator, () => {
      try { handler(); } catch { /* a hotkey must never take the app down */ }
    });
  } catch { return false; }
}

/**
 * Grabs the screen for the screenshot hotkey.
 *
 * The overlay is hidden for a moment first: it is our own window and it sits on
 * top, so leaving it up would mean every screenshot came back with the overlay
 * burnt into it.
 */
async function takeScreenshot() {
  if (shotBusy) return { ok: false, error: 'busy' };
  shotBusy = true;
  try {
    const s = load().settings || {};
    if ((s.screenshot || {}).enabled === false) return { ok: false, reason: 'disabled' };

    const hadOverlay = perf.isOpen();
    if (hadOverlay) {
      perf.hide();
      // Two frames is enough for the compositor to drop our window; any less and
      // the panel is still on screen when the capture happens.
      await new Promise((r) => setTimeout(r, 200));
    }

    const game = procs.list()[0] || null;
    const res = await shots.capture({
      game: game ? game.name : null,
      gameId: game ? game.id : null
    });

    if (hadOverlay) perf.show();

    if (res.ok) {
      const payload = { ...res, sound: (s.screenshot || {}).sound !== false };
      const focused = !!win && !win.isDestroyed() && win.isFocused();
      if (win && !win.isDestroyed()) win.webContents.send('shot:taken', payload);
      // With the launcher in the tray the in-app toast would be invisible, so a
      // real OS notification carries the news instead.
      if (!focused && Notification.isSupported()) {
        try {
          new Notification({
            title: 'Screenshot saved',
            body: `${res.name}${game ? ` \u00b7 ${game.name}` : ''}`
          }).show();
        } catch { /* notifications can be denied; the file is already saved */ }
      }
    }
    return res;
  } finally {
    shotBusy = false;
  }
}

/**
 * Re-reads the settings and makes the shortcuts and the overlay match.
 *
 * Called at startup and again whenever the renderer has persisted a change, so
 * the running app - not a restart - picks up a new hotkey or corner.
 */
function applyHotkeys() {
  const s = load().settings || {};
  const ov = s.overlay || {};
  const sh = s.screenshot || {};

  perf.configure({
    corner: ov.corner || 'top-left',
    opacity: Math.max(0.25, Math.min(1, (Number(ov.opacity) || 92) / 100))
  });
  perf.setEnabled(ov.enabled !== false);

  try { globalShortcut.unregisterAll(); } catch { /* nothing registered yet */ }

  const out = { overlay: false, screenshot: false };
  if (ov.enabled !== false) out.overlay = safeShortcut(ov.key || 'F8', () => perf.toggle());
  if (sh.enabled !== false) out.screenshot = safeShortcut(sh.key || 'F2', () => { takeScreenshot(); });
  return out;
}

perf.configure({ corner: 'top-left' });
shots.setLogger((msg) => console.warn(`[shots] ${msg}`));

ipcMain.handle('perf:sample', () => perf.sample());
ipcMain.handle('perf:status', () => perf.status());
ipcMain.handle('perf:toggle', () => { overlayAutoShown = false; return perf.toggle(); });
ipcMain.handle('perf:show', () => perf.show());
ipcMain.handle('perf:hide', () => { overlayAutoShown = false; return perf.hide(); });
ipcMain.handle('hotkeys:apply', () => applyHotkeys());

ipcMain.handle('shots:capture', () => takeScreenshot());
ipcMain.handle('shots:list', () => shots.list());
ipcMain.handle('shots:remove', (_e, name) => shots.remove(name));
ipcMain.handle('shots:open', () => shots.open());

// --- achievements: Steam's real ones (see steamapi.js) -----------------------
// The key and SteamID live in the user's own state file and are only ever sent
// to api.steampowered.com. Apex owns no key and works fully without one.
function steamCfg() {
  const s = load().settings || {};
  return ((s.achievements || {}).steam) || {};
}

ipcMain.handle('steam:apiStatus', () => {
  steamapi.configure(steamCfg());
  return steamapi.status();
});

ipcMain.handle('steam:apiApply', () => {
  steamapi.configure(steamCfg());
  return steamapi.status();
});

ipcMain.handle('steam:apiDetectId', async () => {
  try {
    const roots = await detect.findSteamRoots();
    return await steamapi.detectSteamId(roots);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'no-steam' };
  }
});

ipcMain.handle('steam:apiResolveId', async (_e, input) => {
  steamapi.configure(steamCfg());
  try { return await steamapi.resolveSteamId(input); }
  catch (err) { return { ok: false, error: (err && err.message) || 'failed' }; }
});

ipcMain.handle('steam:achievements', async (_e, appId, opts) => {
  steamapi.configure(steamCfg());
  try { return await steamapi.achievements(appId, opts || {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'failed' }; }
});

// --- changelog (see data/changelog.json) -------------------------------------
// Bundled with the app rather than fetched, so "What's new" always works offline
// and can never be swapped out from under the user.
ipcMain.handle('changelog:list', () => {
  try {
    const file = path.join(projectDir(), 'data', 'changelog.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(raw) ? raw : (raw.entries || []);
    return { ok: true, version: app.getVersion(), entries };
  } catch (err) {
    return { ok: true, version: app.getVersion(), entries: [], error: (err && err.message) || 'No changelog bundled' };
  }
});

// --- self-update (see updater.js) -------------------------------------------
// Informational plus a manual nudge. Updating is forced: the app downloads and
// installs a new build on its own, so none of these are required for one to
// happen - they only exist so Settings can show what is going on. Deliberately
// *not* behind handleAuthed: the updater runs before sign-in and is nobody's
// private data.
ipcMain.handle('update:status', () => updater.status());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:install', () => updater.installNow('Manual'));

// --- catalogue providers (see net/providers/) -------------------------------
// Official, unauthenticated metadata only. `providers:deliver` is what the
// queue asks for a file; a metadata-only provider always declines, and any
// item it did return would still face the host policy above.
ipcMain.handle('providers:list', () => providers.describe());
ipcMain.handle('providers:search', async (_e, providerId, term, opts) => {
  const p = providers.get(providerId);
  if (!p || typeof p.search !== 'function') return { ok: false, items: [], error: 'Unknown provider' };
  try { return await p.search(term, opts || {}); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'Search failed' }; }
});
ipcMain.handle('providers:details', async (_e, providerId, id, opts) => {
  const p = providers.get(providerId);
  if (!p || typeof p.details !== 'function') return { ok: false, error: 'Unknown provider' };
  try { return await p.details(id, opts || {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not load details' }; }
});
ipcMain.handle('providers:deliver', async (_e, providerId, target, ctx) =>
  providers.deliver(providerId, target, ctx || {}));

// --- itch.io ----------------------------------------------------------------
// Browse, search and detail are open to everyone. The uploads list and the
// download URL are asked for with the key the user saved in Settings, so a paid
// build is only ever offered to the account that already owns it.
ipcMain.handle('itch:feeds', () => itch.feeds());
ipcMain.handle('itch:browse', async (_e, feedId, page) => {
  try { return await itch.browse(feedId, page); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('itch:search', async (_e, query) => {
  try { return await itch.search(query); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('itch:detail', async (_e, url) => {
  try { return await itch.detail(url); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('itch:connect', async (_e, key) => {
  const clean = String(key || '').trim();
  if (!clean) return { ok: false, error: 'Paste an itch.io API key first.' };
  try {
    const who = await itch.profile(clean);
    return { ok: true, username: who.username, displayName: who.displayName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('steamrip:search', async (_e, query) => {
  const p = providers.get('steamrip');
  if (!p || typeof p.search !== 'function') return { ok: false, items: [], error: 'Unknown provider' };
  try { return await p.search(query, {}); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'Search failed' }; }
});
ipcMain.handle('steamrip:details', async (_e, id) => {
  const p = providers.get('steamrip');
  if (!p || typeof p.details !== 'function') return { ok: false, error: 'Unknown provider' };
  try { return await p.details(id, {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not load details' }; }
});

// --- Project Lightning (Lightning Nexus) -----------------------------------
ipcMain.handle('lightning:search', async (_e, query) => {
  const p = providers.get('lightning');
  if (!p || typeof p.search !== 'function') return { ok: false, items: [], error: 'Unknown provider' };
  try { return await p.search(query, {}); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'Search failed' }; }
});
ipcMain.handle('lightning:details', async (_e, id) => {
  const p = providers.get('lightning');
  if (!p || typeof p.details !== 'function') return { ok: false, error: 'Unknown provider' };
  try { return await p.details(id, {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not load details' }; }
});

// --- Project Lightning tools (Bypass / OnlineFix / SteamLess) ---------------
// See lightningtools.js. Catalogues are metadata only; applyFix and the
// SteamLess swap write into a folder the user explicitly chose.
ipcMain.handle('pl:status', () => {
  try { return lightningtools.catalogs(); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Catalogues unavailable' }; }
});
ipcMain.handle('pl:catalogs', (_e, opts) => {
  try { return lightningtools.catalogs(opts || {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Catalogues unavailable' }; }
});
ipcMain.handle('pl:bypass', (_e, query) => {
  try { return lightningtools.bypassList(query); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'Bypass list unavailable' }; }
});
ipcMain.handle('pl:onlinefix', (_e, query) => {
  try { return lightningtools.onlinefixList(query); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'OnlineFix list unavailable' }; }
});
ipcMain.handle('pl:refresh', async () => {
  try { return await lightningtools.refresh(); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Refresh failed' }; }
});
handleAuthed('pl:applyFix', async (_e, payload) => {
  try { return await lightningtools.applyFix(payload || {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not apply the fix' }; }
});
ipcMain.handle('pl:steamlessScan', async (_e, payload) => {
  try { return await lightningtools.steamlessScan(payload || {}); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'Scan failed' }; }
});
handleAuthed('pl:steamlessReplace', async (_e, payload) => {
  try { return await lightningtools.steamlessReplace(payload || {}); }
  catch (err) { return { ok: false, replaced: [], error: (err && err.message) || 'Could not replace the DLLs' }; }
});

ipcMain.handle('itch:uploads', async (_e, gameId) => {
  const key = String((load().settings.itch || {}).apiKey || '').trim();
  if (!key) return { ok: false, error: 'no-key', uploads: [] };
  try {
    return { ok: true, uploads: await itch.uploads(key, gameId) };
  } catch (err) {
    return { ok: false, error: err.message, uploads: [] };
  }
});

ipcMain.handle('state:load', () => rendererState());
ipcMain.handle('state:save', (_e, state) => {
  mergeSession(state);
  save(state);
  try { app.setLoginItemSettings({ openAtLogin: !!state.settings.startOnBoot }); } catch { /* unsupported */ }
  if (state.settings.minimizeToTray) ensureTray();
  else if (tray && win && win.isVisible()) destroyTray();
  if (tray) tray.setImage(trayIcon(state.settings.accent));
  // Rich Presence follows the Settings toggle without a restart.
  try { discord.configure(state.settings.discord || {}); } catch { /* never block a save */ }
  return true;
});
ipcMain.handle('state:reset', () => {
  try { fs.rmSync(stateFile(), { force: true }); } catch { /* ignore */ }
  return rendererState();
});

// ---------------------------------------------------------------------------
// Discord Rich Presence (see discord.js)
// ---------------------------------------------------------------------------
// The renderer owns the wording ("Browsing the Store", "Playing Halo"); the
// main process owns the socket, the handshake and the reconnect loop.
ipcMain.handle('presence:status', () => discord.status());
ipcMain.handle('presence:configure', (_e, cfg) => discord.configure(cfg || {}));
ipcMain.on('presence:set', (_e, activity) => { try { discord.setActivity(activity || null); } catch { /* ignore */ } });
ipcMain.on('presence:clear', () => { try { discord.clear(); } catch { /* ignore */ } });

ipcMain.handle('dialog:folder', async (_e, current) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || app.getPath('home')
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('shell:openPath', async (_e, target) => {
  if (!target) return false;
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch { /* path may already exist or be read-only */ }
  const err = await shell.openPath(target);
  return err === '';
});

ipcMain.handle('app:info', () => ({
  name: APP_NAME,
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  paths: {
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    downloads: app.getPath('downloads')
  }
}));

// ---------------------------------------------------------------------------
// Local game detection & launching
// ---------------------------------------------------------------------------
ipcMain.handle('games:detect', async (_e, hints) => {
  try {
    return await detect.detectAll(Array.isArray(hints) ? hints : []);
  } catch (err) {
    return { roots: {}, counts: { steam: 0, epic: 0 }, matched: {}, unknown: [], error: err.message };
  }
});

/**
 * Real file verification.
 *
 * `records` is `{ [gameId]: targetDescriptor }` — the same descriptors the
 * renderer keeps in State.local.installs.
 *
 * `opts.deep` (the default) walks every file and compares the byte count to
 * the size the store recorded, which is what an explicit "Verify files" should
 * do. Passing `{ deep: false }` does the fast checks only — folder present,
 * folder not empty, store flags say complete — which is what the pre-launch
 * gate wants, since it must not stall on a 150 GB install.
 *
 * @returns {Promise<{[gameId]: object}>} a summarize() report per game.
 */
ipcMain.handle('games:verify', async (_e, records, opts) => {
  const input = records && typeof records === 'object' ? records : {};
  const deep = !(opts && opts.deep === false);
  const out = {};
  for (const [id, target] of Object.entries(input)) {
    try {
      out[id] = verify.summarize(verify.verifyInstall(target || {}, { deep }));
    } catch (err) {
      out[id] = { state: 'unknown', ok: false, label: 'Unknown', reason: (err && err.message) || 'Verification failed' };
    }
  }
  return out;
});

handleAuthed('game:launch', async (_e, target) => {
  const res = await gameLaunch.launch(target);
  // The performance overlay follows the game by itself when the user asked for
  // that. It can never fail a launch: a broken overlay is not a reason to stop.
  try {
    const ov = (load().settings || {}).overlay || {};
    if (res && res.ok && ov.enabled !== false && ov.auto !== false) {
      perf.show();
      overlayAutoShown = true;
    }
  } catch { /* ignore */ }
  return res;
});

// --- running games ---------------------------------------------------------
// Every game Apex starts is registered in procs.js, so STOP can terminate the
// real process tree. Exits (natural or killed) are pushed back to the renderer
// so the action button always returns to PLAY on its own.
procs.setNotifier((rec) => {
  if (win && !win.isDestroyed()) win.webContents.send('game:exited', rec);
  // Once the game is gone the overlay has nothing left to measure, so one that
  // appeared on its own leaves on its own too.
  if (overlayAutoShown && perf.isOpen()) {
    perf.hide();
    overlayAutoShown = false;
  }
});

ipcMain.handle('game:stop', async (_e, target) => {
  try { return await procs.stop(target); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('game:running', () => procs.list());

// ---------------------------------------------------------------------------
// Install locations & real platform installs
// ---------------------------------------------------------------------------
// Every drive Apex could install onto, with real free space.
ipcMain.handle('drives:list', async () => {
  try {
    const [list, libs] = await Promise.all([drives.listDrives(), drives.steamLibraries()]);
    // The Steam root also lets the renderer offer a "restart Steam and retry".
    let steamExe = null;
    let steamRunning = false;
    try {
      const roots = await detect.findSteamRoots();
      if (roots.length) steamExe = path.join(roots[0], 'steam.exe');
      steamRunning = await drives.steamRunning();
    } catch { /* Steam may not be installed at all */ }
    return { ok: true, drives: list, steamLibraries: libs, steamExe, steamRunning };
  } catch (err) {
    return { ok: false, error: err.message, drives: [], steamLibraries: [] };
  }
});

// Free space for one folder (used to warn before a big install).
ipcMain.handle('drives:space', (_e, target) => {
  try { return drives.space(target); } catch { return null; }
});

// Registers a folder as a Steam library so Steam can install onto that drive.
handleAuthed('steam:addLibrary', async (_e, dir) => {
  try { return await drives.addSteamLibrary(dir); }
  catch (err) { return { ok: false, error: err.message }; }
});

// Pre-registers an install in one library, which is what stops Steam asking
// which drive to use. Creates one file; Apex can delete exactly that file.
handleAuthed('steam:seedManifest', async (_e, target) => {
  try { return await drives.seedManifest(target || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});

// Undoes steam:seedManifest.
ipcMain.handle('steam:removeManifest', (_e, file) => {
  try { return drives.removeManifest(file); }
  catch (err) { return { ok: false, error: err.message }; }
});

// Just "is Steam open right now?" - cheap enough to poll while waiting for it
// to close or come back during an install.
ipcMain.handle('steam:running', async () => {
  try { return { ok: true, running: await drives.steamRunning() }; }
  catch { return { ok: false, running: false }; }
});

// Hands the install to the store that owns the game (Steam/Epic). Real download.
handleAuthed('install:start', async (_e, target) => {
  try { return await gameLaunch.install(target); }
  catch (err) { return { ok: false, error: err.message }; }
});

// Live progress for installs a store is performing (read from Steam's own
// appmanifest files, so the percentage is Steam's real one).
ipcMain.handle('steam:progress', async () => {
  try { return await steamwatch.steamProgress(); }
  catch (err) { return { ok: false, error: err.message, apps: {} }; }
});

ipcMain.handle('dialog:exe', async (_e, current) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Locate game executable',
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] },
      { name: 'All files', extensions: ['*'] }
    ],
    defaultPath: current || undefined
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('fs:exists', (_e, target) => {
  try { return !!target && fs.existsSync(target); } catch { return false; }
});

// --- custom background image ----------------------------------------------
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif'
};

ipcMain.handle('dialog:image', async (_e, current) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
    defaultPath: current || app.getPath('pictures')
  });
  return res.canceled ? null : res.filePaths[0];
});

/**
 * Reads an image back as a data URL. The renderer runs under a strict CSP that
 * blocks `file:` images, so the bytes are handed over explicitly instead. Large
 * files are refused rather than blowing up the renderer's memory.
 */
ipcMain.handle('file:dataUrl', (_e, target) => {
  try {
    if (!target) return null;
    const st = fs.statSync(target);
    if (!st.isFile() || st.size > 32 * 1024 * 1024) return null;
    const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`;
  } catch { return null; }
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  try { await shell.openExternal(url); return true; } catch { return false; }
});

/**
 * Shallow scan of a folder the user points at, listing launchable executables.
 * Used by "Import a folder" so games already on disk can be added to the
 * library without any network access.
 */
ipcMain.handle('folder:scanGames', async (_e, dir) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Folder not found', games: [] };
    const SKIP_EXE = /^(unins|vc_?redist|dxsetup|dxwebsetup|setup|install|crash|report|launcher|update|dotnet|oalinst)/i;
    const SKIP_DIR = /^(redist|redistributable|directx|vcredist|support|engine|tools?|plugins?|saves?|logs?)$/i;
    const games = [];
    const walk = (d, depth) => {
      if (depth > 2 || games.length > 80) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (games.length > 80) return;
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (!SKIP_DIR.test(ent.name)) walk(full, depth + 1);
        } else if (ent.isFile() && /\.exe$/i.test(ent.name) && !SKIP_EXE.test(ent.name)) {
          let size = 0;
          try { size = fs.statSync(full).size; } catch { /* ignore */ }
          games.push({ name: ent.name.replace(/\.exe$/i, ''), exe: full, dir: d, size });
        }
      }
    };
    walk(dir, 0);

    // Pull the real icon out of each executable so an imported game shows the
    // artwork it shipped with instead of a blank placeholder. This is a shell
    // round-trip per file, so it is capped — the list is a preview, not a
    // library, and the cap keeps a folder of 80 executables responsive.
    const ICON_LIMIT = 24;
    await Promise.all(games.slice(0, ICON_LIMIT).map(async (g) => {
      try {
        const img = await app.getFileIcon(g.exe, { size: 'large' });
        if (img && !img.isEmpty()) g.icon = img.toDataURL();
      } catch { /* no icon available: the card keeps its typographic banner */ }
    }));

    return { ok: true, games, root: dir };
  } catch (err) {
    return { ok: false, error: err.message, games: [] };
  }
});

/**
 * Live store catalogue.
 *
 * `store:search` queries the whole Steam storefront for real titles with real
 * AppIDs and prices. `store:details` fetches one AppID's full record. Both are
 * metadata only — nothing here downloads a game.
 */
ipcMain.handle('store:search', async (_e, term, opts) => {
  try { return await catalog.search(term, opts || {}); }
  catch (err) { return { ok: false, items: [], error: (err && err.message) || 'Search failed' }; }
});

ipcMain.handle('store:details', async (_e, appId, opts) => {
  try { return await catalog.details(appId, opts || {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not load details' }; }
});

// Gaming news, read from news.instant-gaming.com in the main process.
ipcMain.handle('news:list', async (_e, opts) => {
  try { return await news.list(opts || {}); }
  catch (err) {
    return { ok: false, items: [], categories: [], fetchedAt: null, stale: false, error: (err && err.message) || 'News unavailable' };
  }
});

// Banner artwork for a title that shipped none of its own. Read-only: it only
// ever returns an image URL (see coverart.js).
ipcMain.handle('art:resolve', async (_e, spec) => {
  try { return await coverart.resolve(spec || {}); }
  catch (err) { return { ok: false, error: (err && err.message) || 'No artwork found online' }; }
});

// The hero's transparent wordmark. Also read-only: it fetches image headers
// to prove a candidate really has an alpha channel, and nothing else
// (see logoart.js).
ipcMain.handle('logo:resolve', async (_e, spec) => {
  try {
    const key = ((load().settings || {}).art || {}).steamgriddbKey || '';
    return await logoart.resolve(spec || {}, { apiKey: key });
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'No transparent logo found online' };
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// One window only: re-launching the app just refocuses the running instance.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWin());

  app.whenReady().then(() => {
    try { app.setAppUserModelId('com.apex.launcher'); } catch { /* ignore */ }
    createSplash();
    createWindow();
    const boot = load();
    if (boot.settings.minimizeToTray) ensureTray();
    // Rich Presence starts as soon as the app does, if the user turned it on.
    try { discord.configure(boot.settings.discord || {}); } catch { /* never block startup */ }
    // F8 / F2 (or whatever the user rebound them to) work anywhere, including
    // over a running game with the launcher tucked away in the tray.
    try { applyHotkeys(); } catch { /* an unavailable hotkey is not a crash */ }
    // Forced self-update: check on launch and every few hours, download quietly,
    // then restart into the installer. The only thing that holds it back is work
    // in flight (see updateBlocked), and even then nobody is asked anything.
    try {
      updater.init({
        isBusy: updateBlocked,
        log: (msg) => console.log(`[updater] ${msg}`)
      });
    } catch { /* updating must never block startup */ }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWin();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    try { discord.destroy(); } catch { /* ignore */ }
    // Give the keys back to the system and take the overlay down with us.
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
    try { perf.destroy(); } catch { /* ignore */ }
    try { updater.stop(); } catch { /* ignore */ }
  });
  app.on('window-all-closed', () => {
    if (!load().settings.minimizeToTray) app.quit();
  });
}
