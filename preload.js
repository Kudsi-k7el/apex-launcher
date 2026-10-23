'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Apex Launcher renderer bridge.
 * Context isolation is on and node integration is off: the renderer only ever
 * sees this small, explicit surface.
 */
contextBridge.exposeInMainWorld('api', {
  // --- window controls ---
  minimize: () => ipcRenderer.send('win:min'),
  maximize: () => ipcRenderer.send('win:max'),
  close: () => ipcRenderer.send('win:close'),
  show: () => ipcRenderer.send('win:show'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  toggleFullscreen: (force) => ipcRenderer.send('win:fullscreen', force),
  isFullscreen: () => ipcRenderer.invoke('win:isFullscreen'),
  onFullscreen: (cb) => ipcRenderer.on('win:fullscreen', (_e, v) => cb(v)),

  // --- persistent state ---
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  resetState: () => ipcRenderer.invoke('state:reset'),

  // --- dialogs / shell ---
  pickFolder: (current) => ipcRenderer.invoke('dialog:folder', current),
  pickExecutable: (current) => ipcRenderer.invoke('dialog:exe', current),
  pickImage: (current) => ipcRenderer.invoke('dialog:image', current),
  pickLuaFile: () => ipcRenderer.invoke('dialog:lua'),
  readImage: (p) => ipcRenderer.invoke('file:dataUrl', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  pathExists: (p) => ipcRenderer.invoke('fs:exists', p),
  appInfo: () => ipcRenderer.invoke('app:info'),
  quit: () => ipcRenderer.send('app:quit'),

  // --- local game detection & launching ---
  detectGames: (hints) => ipcRenderer.invoke('games:detect', hints),
  verifyGames: (records, opts) => ipcRenderer.invoke('games:verify', records, opts),
  launchGame: (target) => ipcRenderer.invoke('game:launch', target),

  // --- live store catalogue & news (metadata only) ---
  storeSearch: (term, opts) => ipcRenderer.invoke('store:search', term, opts),
  storeDetails: (appId, opts) => ipcRenderer.invoke('store:details', appId, opts),
  storeAssets: (appId) => ipcRenderer.invoke('store:assets', appId),

  storeName: (appId) => ipcRenderer.invoke('store:name', appId),

  wallpaperPath: () => ipcRenderer.invoke('wallpaper:file'),
  newsList: (opts) => ipcRenderer.invoke('news:list', opts),
  resolveArt: (spec) => ipcRenderer.invoke('art:resolve', spec),
  // Transparent wordmark for the hero: returns an image URL or nothing at all.
  resolveLogo: (spec) => ipcRenderer.invoke('logo:resolve', spec),

  // --- running games (STOP button) ---
  stopGame: (target) => ipcRenderer.invoke('game:stop', target),
  runningGames: () => ipcRenderer.invoke('game:running'),
  onGameExited: (cb) => ipcRenderer.on('game:exited', (_e, rec) => cb(rec)),

  scanFolder: (dir) => ipcRenderer.invoke('folder:scanGames', dir),

  // --- emulators & ROM shelves (see emulators.js) --------------------------
  // `emuSystems` is the static console table; detection and scanning are
  // read-only walks of the user's own folders, and only `emuLaunch` is gated.
  emuSystems: () => ipcRenderer.invoke('emu:systems'),
  emuDetect: (overrides) => ipcRenderer.invoke('emu:detect', overrides),
  emuScan: (folders, opts) => ipcRenderer.invoke('emu:scan', folders, opts),
  emuLaunch: (system, romPath, opts) => ipcRenderer.invoke('emu:launch', system, romPath, opts),
  // Opens an installed emulator with nothing loaded, for its own menu.
  emuRun: (id, overrides) => ipcRenderer.invoke('emu:run', id, overrides),

  // The emulator shelf: which programs Apex can fetch for you, and the one
  // download at a time that goes with it. Emulators are ordinary downloads, so
  // none of this is gated. `onEmuEvent` carries start/progress/done/error.
  emuCatalog: () => ipcRenderer.invoke('emu:catalog'),
  emuUpdates: (force) => ipcRenderer.invoke('emu:updates', force),
  emuInstall: (id) => ipcRenderer.invoke('emu:install', id),
  emuCancel: (id) => ipcRenderer.invoke('emu:cancel', id),
  onEmuEvent: (cb) => ipcRenderer.on('emu:event', (_e, evt) => cb(evt)),

  // --- itch.io (browse needs nothing; downloads use the user's own key) -----
  itchFeeds: () => ipcRenderer.invoke('itch:feeds'),
  itchBrowse: (feed, page) => ipcRenderer.invoke('itch:browse', feed, page),
  itchSearch: (query) => ipcRenderer.invoke('itch:search', query),
  itchDetail: (url) => ipcRenderer.invoke('itch:detail', url),
  itchConnect: (key) => ipcRenderer.invoke('itch:connect', key),
  itchStatus: () => ipcRenderer.invoke('itch:status'),
  itchUploads: (gameId) => ipcRenderer.invoke('itch:uploads', gameId),
  steamripSearch: (query) => ipcRenderer.invoke('steamrip:search', query),
  steamripDetails: (id) => ipcRenderer.invoke('steamrip:details', id),
  lightningSearch: (query) => ipcRenderer.invoke('lightning:search', query),
  lightningDetails: (id) => ipcRenderer.invoke('lightning:details', id),

  // --- Project Lightning tools (see lightningtools.js) ----------------------
  // The Bypass / OnlineFix catalogues, fix application and the SteamLess DLL
  // swap. `plApplyFix` and `plSteamlessReplace` only ever write into a folder
  // the user picked in the dialog, and back up what they replace.
  plStatus: () => ipcRenderer.invoke('pl:status'),
  plCatalogs: (opts) => ipcRenderer.invoke('pl:catalogs', opts),
  plBypass: (query) => ipcRenderer.invoke('pl:bypass', query),
  plOnlinefix: (query) => ipcRenderer.invoke('pl:onlinefix', query),
  plRefresh: () => ipcRenderer.invoke('pl:refresh'),
  plApplyFix: (payload) => ipcRenderer.invoke('pl:applyFix', payload),
  plSteamlessScan: (payload) => ipcRenderer.invoke('pl:steamlessScan', payload),
  plSteamlessReplace: (payload) => ipcRenderer.invoke('pl:steamlessReplace', payload),

  // --- Discord Rich Presence (see discord.js in the main process) ----------
  presenceStatus: () => ipcRenderer.invoke('presence:status'),
  presenceConfigure: (cfg) => ipcRenderer.invoke('presence:configure', cfg),
  presenceSet: (activity) => ipcRenderer.send('presence:set', activity),
  presenceClear: () => ipcRenderer.send('presence:clear'),

  // --- backend account / cloud sync (see net/api.js) ----------------------
  apiStatus: () => ipcRenderer.invoke('api:status'),
  apiConfigure: (url) => ipcRenderer.invoke('api:configure', url),
  apiRegister: (payload) => ipcRenderer.invoke('api:register', payload),
  apiLogin: (payload) => ipcRenderer.invoke('api:login', payload),
  apiLogout: () => ipcRenderer.invoke('api:logout'),
  apiSyncProfile: (payload) => ipcRenderer.invoke('api:sync', payload),
  apiFetchProfile: () => ipcRenderer.invoke('api:fetch'),

  // --- the sign-in gate (see auth.js) -------------------------------------
  // Apex Launcher is only usable with a session; these are the only channels
  // that work without one, because they are how you get one.
  authState: () => ipcRenderer.invoke('auth:state'),
  authSignIn: (creds) => ipcRenderer.invoke('auth:signIn', creds),
  authSignUp: (creds) => ipcRenderer.invoke('auth:signUp', creds),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  authConfigure: (url) => ipcRenderer.invoke('auth:configure', url),
  authRecheck: () => ipcRenderer.invoke('auth:recheck'),
  authStartServer: () => ipcRenderer.invoke('auth:startServer'),
  authRelax: () => ipcRenderer.invoke('auth:relax'),
  authRequire: () => ipcRenderer.invoke('auth:require'),
  authChangePassword: (payload) => ipcRenderer.invoke('auth:changePassword', payload),
  onAuthChanged: (cb) => ipcRenderer.on('auth:changed', (_e, snap) => cb(snap)),

  // --- the companion site (installer + account pages) ----------------------
  openSite: (where) => ipcRenderer.invoke('site:open', where),

  // --- real download / install engine (net/ + installs.js) ---------------
  // `search` only lists items from manifests the user configured; `start`
  // validates the host policy in the main process before anything is fetched.
  dlSearch: (query) => ipcRenderer.invoke('dl:search', query),
  dlList: () => ipcRenderer.invoke('dl:list'),
  dlStart: (target) => ipcRenderer.invoke('dl:start', target),
  dlPause: (id) => ipcRenderer.invoke('dl:pause', id),
  dlResume: (id) => ipcRenderer.invoke('dl:resume', id),
  dlCancel: (id) => ipcRenderer.invoke('dl:cancel', id),
  onDownloadEvent: (cb) => ipcRenderer.on('dl:event', (_e, evt) => cb(evt)),

  // --- download queue (net/queue.js) --------------------------------------
  // Same engine as above, but ordered and admission-controlled. `enqueue`
  // refuses anything the main process' host policy blocks, so the returned
  // record for a bad source reads `refused` and nothing is ever fetched.
  dlqEnqueue: (target, ctx) => ipcRenderer.invoke('dlq:enqueue', target, ctx),
  dlqList: () => ipcRenderer.invoke('dlq:list'),
  dlqPause: (id) => ipcRenderer.invoke('dlq:pause', id),
  dlqResume: (id) => ipcRenderer.invoke('dlq:resume', id),
  dlqCancel: (id) => ipcRenderer.invoke('dlq:cancel', id),
  dlqClear: (opts) => ipcRenderer.invoke('dlq:clear', opts),
  dlqConcurrency: (n) => ipcRenderer.invoke('dlq:concurrency', n),
  onQueueEvent: (cb) => ipcRenderer.on('dlq:event', (_e, evt) => cb(evt)),

  // --- catalogue providers (net/providers/) -------------------------------
  // Metadata only: titles, descriptions, art and logos from official APIs.
  // `providerDeliver` is the file hook and always declines for these.
  providersList: () => ipcRenderer.invoke('providers:list'),
  providerSearch: (providerId, term, opts) => ipcRenderer.invoke('providers:search', providerId, term, opts),
  providerDetails: (providerId, id, opts) => ipcRenderer.invoke('providers:details', providerId, id, opts),
  providerDeliver: (providerId, target, ctx) => ipcRenderer.invoke('providers:deliver', providerId, target, ctx),

  // --- install locations & real platform installs ---
  listDrives: () => ipcRenderer.invoke('drives:list'),
  driveSpace: (p) => ipcRenderer.invoke('drives:space', p),
  addSteamLibrary: (dir) => ipcRenderer.invoke('steam:addLibrary', dir),
  installStart: (target) => ipcRenderer.invoke('install:start', target),
  steamProgress: () => ipcRenderer.invoke('steam:progress'),
  seedManifest: (target) => ipcRenderer.invoke('steam:seedManifest', target),
  removeManifest: (file) => ipcRenderer.invoke('steam:removeManifest', file),
  steamLibraries: () => ipcRenderer.invoke('steam:libraries'),
  steamRestart: () => ipcRenderer.invoke('steam:restart'),
  luaScan: () => ipcRenderer.invoke('lua:scan'),
  luaApp: () => ipcRenderer.invoke('lua:app'),
  luaInspect: (file) => ipcRenderer.invoke('lua:inspect', file),
  luaRemove: (file, dir) => ipcRenderer.invoke('lua:remove', file, dir),
  luaClear: (dir) => ipcRenderer.invoke('lua:clear', dir),
  luaApply: (...args) => ipcRenderer.invoke('lua:apply', ...args),
  luaInstall: (...args) => ipcRenderer.invoke('lua:install', ...args),
  luaDownload: (...args) => ipcRenderer.invoke('lua:download', ...args),
  luaDownloadAll: (...args) => ipcRenderer.invoke('lua:downloadAll', ...args),
  luaInject: (...args) => ipcRenderer.invoke('lua:inject', ...args),
  luaInstallLuaTools: (...args) => ipcRenderer.invoke('lua:installLuaTools', ...args),
  luaWrite: (...args) => ipcRenderer.invoke('lua:write', ...args),
  luaAdd: (...args) => ipcRenderer.invoke('lua:add', ...args),
  luaPut: (...args) => ipcRenderer.invoke('lua:put', ...args),
  luaCreate: (...args) => ipcRenderer.invoke('lua:create', ...args),
  luaApplyFile: (...args) => ipcRenderer.invoke('lua:applyFile', ...args),
  luaInstallFile: (...args) => ipcRenderer.invoke('lua:installFile', ...args),
  luaImport: (...args) => ipcRenderer.invoke('lua:import', ...args),
  luaImportLua: (...args) => ipcRenderer.invoke('lua:importLua', ...args),
  luaInstallApp: (...args) => ipcRenderer.invoke('lua:installApp', ...args),
  luaApplyApp: (...args) => ipcRenderer.invoke('lua:applyApp', ...args),
  luaAddApp: (...args) => ipcRenderer.invoke('lua:addApp', ...args),
  luaTrackSteam: (...args) => ipcRenderer.invoke('lua:trackSteam', ...args),
  luaWriteLua: (...args) => ipcRenderer.invoke('lua:writeLua', ...args),
  luaEnable: (...args) => ipcRenderer.invoke('lua:enable', ...args),
  luaApplyLua: (...args) => ipcRenderer.invoke('lua:applyLua', ...args),
  luaInstallLua: (...args) => ipcRenderer.invoke('lua:installLua', ...args),
  luaInstallGame: (...args) => ipcRenderer.invoke('lua:installGame', ...args),
  luaApplyGame: (...args) => ipcRenderer.invoke('lua:applyGame', ...args),
  luaAddGame: (...args) => ipcRenderer.invoke('lua:addGame', ...args),
  luaWriteGame: (...args) => ipcRenderer.invoke('lua:writeGame', ...args),
  luaPutGame: (...args) => ipcRenderer.invoke('lua:putGame', ...args),
  luaCreateGame: (...args) => ipcRenderer.invoke('lua:createGame', ...args),
  luaInstallLuaFile: (...args) => ipcRenderer.invoke('lua:installLuaFile', ...args),
  luaWriteLuaFile: (...args) => ipcRenderer.invoke('lua:writeLuaFile', ...args),
  luaAddLuaFile: (...args) => ipcRenderer.invoke('lua:addLuaFile', ...args),
  luaApplyManifest: (...args) => ipcRenderer.invoke('lua:applyManifest', ...args),
  luaActivate: (...args) => ipcRenderer.invoke('lua:activate', ...args),
  luaUnlock: (...args) => ipcRenderer.invoke('lua:unlock', ...args),
  luaAddGameToSteam: (...args) => ipcRenderer.invoke('lua:addGameToSteam', ...args),
  luaPutGameInSteam: (...args) => ipcRenderer.invoke('lua:putGameInSteam', ...args),
  luaMakeShow: (...args) => ipcRenderer.invoke('lua:makeShow', ...args),
  luaShowInSteam: (...args) => ipcRenderer.invoke('lua:showInSteam', ...args),
  luaShowInLibrary: (...args) => ipcRenderer.invoke('lua:showInLibrary', ...args),
  luaBackups: () => ipcRenderer.invoke('lua:backups'),
  luaRestore: (id) => ipcRenderer.invoke('lua:restore', id),

  // --- LuaTools feature ports (luatoolsplus) --------------------------------
  // read: parse one .lua out of a plugin folder (depots, keys, pins, toggles).
  // edit: apply one op (enable/disable/lock/unlock/setPin/addDepot/...).
  // downloads: DepotDownloaderMod CDN pulls, progress streamed via onLuaEvent.
  // modes: OpenSteamTools / BetterSteamTools / Custom unlocker management.
  luaRead: (file) => ipcRenderer.invoke('lua:read', file),
  luaEdit: (opts) => ipcRenderer.invoke('lua:edit', opts),
  luaDownloader: () => ipcRenderer.invoke('lua:downloader'),
  luaDownloaderFetch: () => ipcRenderer.invoke('lua:downloader-fetch'),
  luaDepotDownload: (opts) => ipcRenderer.invoke('lua:depot-download', opts),
  luaDepotCancel: (id) => ipcRenderer.invoke('lua:depot-cancel', id),
  luaModes: () => ipcRenderer.invoke('lua:modes'),
  luaSetMode: (opts) => ipcRenderer.invoke('lua:mode-set', opts),
  luaModeManage: () => ipcRenderer.invoke('lua:mode-manage'),
  luaRepairManifests: () => ipcRenderer.invoke('lua:manifests-repair'),

  luaUninstallApp: (appId) => ipcRenderer.invoke('lua:uninstall-app', appId),
  onLuaEvent: (cb) => ipcRenderer.on('lua:event', (_e, evt) => cb(evt)),
  steamRunning: () => ipcRenderer.invoke('steam:running'),

  // --- uninstall / remove (see uninstall.js) -------------------------------
  // Only an id crosses the bridge: the main process re-derives every folder it
  // is willing to delete from Apex's own state file.
  uninstallPlan: (id) => ipcRenderer.invoke('uninstall:plan', id),
  uninstallDelete: (id) => ipcRenderer.invoke('uninstall:delete', id),
  uninstallStore: (id) => ipcRenderer.invoke('uninstall:store', id),

  // --- performance overlay (see perf.js + overlay/) ------------------------
  // The overlay window itself only ever calls `perfSample`. These control it
  // from the launcher: the Settings toggles and the title-bar button.
  perfSample: () => ipcRenderer.invoke('perf:sample'),
  perfStatus: () => ipcRenderer.invoke('perf:status'),
  perfToggle: () => ipcRenderer.invoke('perf:toggle'),
  perfShow: () => ipcRenderer.invoke('perf:show'),
  perfHide: () => ipcRenderer.invoke('perf:hide'),
  // Re-registers the global hotkeys and re-positions the overlay after the
  // renderer has saved new settings.
  applyHotkeys: () => ipcRenderer.invoke('hotkeys:apply'),

  // --- screenshots (see shots.js) ------------------------------------------
  shotsCapture: () => ipcRenderer.invoke('shots:capture'),
  shotsList: () => ipcRenderer.invoke('shots:list'),
  shotsRemove: (name) => ipcRenderer.invoke('shots:remove', name),
  shotsOpen: () => ipcRenderer.invoke('shots:open'),
  onShotTaken: (cb) => ipcRenderer.on('shot:taken', (_e, shot) => cb(shot)),

  // --- achievements: Steam's real ones (see steamapi.js) -------------------
  // Nothing is fetched without the user's own Web API key and SteamID, both of
  // which stay in the local state file.
  steamApiStatus: () => ipcRenderer.invoke('steam:apiStatus'),
  steamApiApply: () => ipcRenderer.invoke('steam:apiApply'),
  steamApiDetectId: () => ipcRenderer.invoke('steam:apiDetectId'),
  steamApiResolveId: (input) => ipcRenderer.invoke('steam:apiResolveId', input),
  steamAchievements: (appId, opts) => ipcRenderer.invoke('steam:achievements', appId, opts),

  // --- changelog (bundled with the app, see data/changelog.json) -----------
  changelogList: () => ipcRenderer.invoke('changelog:list'),

  // --- self-update (see updater.js) ----------------------------------------
  // Updating is forced and silent: the app downloads and installs new builds on
  // its own. These only report what the main process is doing, so Settings can
  // show it and offer a manual check.
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, snap) => cb(snap)),

  // Tells the main process the first paint is done so the splash can go away.
  appReady: () => ipcRenderer.send('app:ready')
});
