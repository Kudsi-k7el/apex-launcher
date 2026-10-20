'use strict';

/**
 * Local game detection (main process).
 *
 * Finds real installs of Steam and Epic Games titles on this machine:
 *   Steam -> registry keys -> libraryfolders.vdf -> appmanifest_*.acf
 *   Epic  -> %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
 *
 * Everything is read-only and every filesystem call is defensive: a missing
 * key, a locked file or a malformed manifest can never crash the launcher.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const verify = require('./verify');

const isWin = process.platform === 'win32';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Steam/Epic install these alongside games; they are not playable titles.
const NON_GAME = /(steamworks common redistributables|steam linux runtime|proton \d|steamvr|epic online services)/i;

function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function safeReadFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Windows registry helper (shell-free: execFile passes an argv array)
// ---------------------------------------------------------------------------
function regQuery(key, value) {
  return new Promise((resolve) => {
    if (!isWin) return resolve(null);
    execFile('reg', ['query', key, '/v', value], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = stdout.split(/\r?\n/).find((l) => l.includes('REG_SZ'));
      if (!line) return resolve(null);
      const idx = line.indexOf('REG_SZ');
      const val = line.slice(idx + 'REG_SZ'.length).trim();
      resolve(val || null);
    });
  });
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------
async function findSteamRoots() {
  const roots = new Set();
  if (isWin) {
    const hkcu = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    if (hkcu) roots.add(hkcu);
    for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam']) {
      const p = await regQuery(key, 'InstallPath');
      if (p) roots.add(p);
    }
  }
  // Common fallbacks in case the registry is unavailable.
  const pf = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles;
  if (pf) roots.add(path.join(pf, 'Steam'));
  if (process.env.HOME) roots.add(path.join(process.env.HOME, '.steam', 'steam'));

  return [...roots]
    .filter(Boolean)
    .map((r) => path.normalize(r))
    .filter((r) => exists(path.join(r, 'steamapps')));
}

/** Expands a Steam root into every library folder that holds a `steamapps` dir. */
function steamLibraries(root) {
  const libs = new Set([root]);
  const vdf = safeReadFile(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  if (vdf) {
    // Modern format: "path"  "D:\\SteamLibrary"
    let m;
    const rePath = /"path"\s*"([^"]+)"/g;
    while ((m = rePath.exec(vdf))) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
    // Legacy format: "1"  "D:\\SteamLibrary"
    const reLegacy = /"(?:\d+)"\s*"([A-Za-z]:[^"]*)"/g;
    while ((m = reLegacy.exec(vdf))) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  }
  return [...libs].filter((p) => exists(path.join(p, 'steamapps')));
}

function scanSteamLibrary(lib) {
  const apps = [];
  const appsDir = path.join(lib, 'steamapps');
  for (const ent of safeReadDir(appsDir)) {
    if (!ent.isFile() || !/^appmanifest_\d+\.acf$/i.test(ent.name)) continue;
    const acf = safeReadFile(path.join(appsDir, ent.name));
    if (!acf) continue;

    const get = (k) => {
      const m = acf.match(new RegExp(`"${k}"\\s*"([^"]*)"`));
      return m ? m[1] : null;
    };
    const appId = get('appid') || (ent.name.match(/(\d+)/) || [])[1];
    const name = get('name');
    const installdir = get('installdir');
    if (!name || !appId) continue;

    const installPath = installdir ? path.join(appsDir, 'common', installdir) : null;
    apps.push({
      source: 'steam',
      appId: String(appId),
      name,
      installPath,
      acfText: acf,                       // kept for real file verification
      stateFlags: Number(get('StateFlags') || 0) || null,
      sizeOnDisk: Number(get('SizeOnDisk') || 0),
      // A cheap verification pass, not a bare `exists()`. A manifest whose
      // folder was deleted, or which Steam still has flagged as needing an
      // update, is not an installed game.
      verify: verify.summarize(verify.verifySteam({
        appId: String(appId), name, installPath, acfText: acf
      })),
      installed: false                        // filled in below from `verify`
    });
    apps[apps.length - 1].installed = apps[apps.length - 1].verify.ok;
  }
  return apps;
}

// ---------------------------------------------------------------------------
// Epic Games
// ---------------------------------------------------------------------------
function epicManifestDirs() {
  const pd = process.env.ProgramData || (process.env.SystemDrive ? `${process.env.SystemDrive}\\ProgramData` : 'C:\\ProgramData');
  return [
    path.join(pd, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    path.join(pd, 'Epic', 'UnrealEngineLauncher', 'Data', 'Manifests')
  ];
}

function epicLaunchUri(item) {
  const ns = item.CatalogNamespace;
  const cat = item.CatalogItemId;
  const app = item.AppName;
  if (ns && cat && app) {
    return `com.epicgames.launcher://apps/${ns}%3A${cat}%3A${app}?action=launch&silent=true`;
  }
  return null;
}

/**
 * The parts of an Epic `.item` manifest that verification needs, and nothing
 * else. A full manifest is several KB of install bookkeeping; these are just the
 * flags that decide whether an install is complete. Carrying them on the link
 * means a later "Verify files" reaches the same conclusion detection did.
 */
function epicVerifyItem(item) {
  const it = item || {};
  return {
    AppName: it.AppName || null,
    DisplayName: it.DisplayName || null,
    InstallLocation: it.InstallLocation || null,
    LaunchExecutable: it.LaunchExecutable || null,
    InstallSize: it.InstallSize || null,
    bIsIncompleteInstall: it.bIsIncompleteInstall === true,
    bIsApplication: it.bIsApplication
  };
}

function scanEpic() {
  const apps = [];
  const seen = new Set();
  for (const dir of epicManifestDirs()) {
    for (const ent of safeReadDir(dir)) {
      if (!ent.isFile() || !/\.item$/i.test(ent.name)) continue;
      const raw = safeReadFile(path.join(dir, ent.name));
      if (!raw) continue;
      let item;
      try { item = JSON.parse(raw); } catch { continue; }

      const name = item.DisplayName || item.AppName;
      if (!name) continue;
      const installPath = item.InstallLocation || null;
      const key = `${norm(item.AppName)}|${norm(installPath)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const exe = installPath && item.LaunchExecutable
        ? path.join(installPath, item.LaunchExecutable)
        : null;

      const verifyReport = verify.summarize(verify.verifyEpic({
        name, installPath, item
      }));

      apps.push({
        source: 'epic',
        appName: item.AppName || null,
        name,
        installPath,
        item,                              // kept for real file verification
        uri: epicLaunchUri(item),
        exe: exists(exe) ? exe : null,
        categories: item.AppCategories || [],
        verify: verifyReport,
        installed: verifyReport.ok
      });
    }
  }
  return apps;
}

// ---------------------------------------------------------------------------
// Other stores: GOG, Ubisoft Connect, EA App, Battle.net, Xbox
// ---------------------------------------------------------------------------
/**
 * Each store keeps its own local database of installed games. Apex reads the
 * same sources the store clients themselves use, so a title bought elsewhere
 * shows up here with a working launch target. Every probe is defensive and
 * returns `{ present, path, apps }`.
 */

/** Runs `reg query <key> /s` and returns raw stdout (or null). */
function regQueryAll(key) {
  return new Promise((resolve) => {
    if (!isWin) return resolve(null);
    execFile('reg', ['query', key, '/s'], { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err || !stdout ? null : stdout));
  });
}

/** Parses `reg query /s` output into `[{ key, values }]`. */
function parseRegDump(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^HKEY_/i.test(raw.trim())) { cur = { key: raw.trim(), values: {} }; out.push(cur); continue; }
    if (!cur) continue;
    const m = raw.match(/^\s+(.+?)\s{4,}(REG_[A-Z_]+)\s{4,}(.*)$/);
    if (m) cur.values[m[1].trim()] = m[3];
  }
  return out;
}

/**
 * Executables that ship next to a game but are never the game itself.
 * Deliberately targeted (not a bare /crash/ or /helper/) so real titles like
 * "Crash Bandicoot" are not filtered out.
 */
const BAD_EXE = /(unins|vcredist|vc_redist|dxsetup|dxwebsetup|crashhandler|crashreport|crashreporter|ue4prereq|prereqsetup|eossdk|epicwebhelper|installer|_setup|setup$|launcher_helper)/i;

/** Picks the most plausible launcher executable in a game folder. */
function pickExe(dir, hints = [], maxDepth = 3) {
  if (!dir || !exists(dir)) return null;
  const want = hints.map(norm).filter((h) => h.length > 2);
  let best = null;
  let bestScore = -1;
  const walk = (d, depth) => {
    if (!d || depth > maxDepth) return;
    for (const ent of safeReadDir(d)) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        // Skip the folders that never hold the game binary.
        if (/^(support|redist|redistributables|directx|__installer|installer|docs?|manual|tools?|editor|sdk)$/i.test(ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile() || !/\.exe$/i.test(ent.name)) continue;
      const base = norm(path.basename(ent.name, '.exe'));
      if (BAD_EXE.test(base)) continue;
      let score = 0;
      if (want.some((w) => base.includes(w))) score += 6;
      if (/^(game|play|launch|start|client|runtime)$/.test(base)) score += 2;
      try { score += Math.min(fs.statSync(full).size / (64 * 1024 * 1024), 2); } catch { /* keep score */ }
      if (score > bestScore) { bestScore = score; best = full; }
    }
  };
  walk(dir, 0);
  return best;
}

async function scanGog() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games',
    'HKLM\\SOFTWARE\\GOG.com\\Games',
    'HKCU\\Software\\GOG.com\\Games'
  ];
  const clientPaths = [
    ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient', 'path'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient', 'installpath'],
    ['HKCU\\Software\\GOG.com\\GalaxyClient', 'path']
  ];
  let client = null;
  for (const [key, value] of clientPaths) {
    client = client || await regQuery(key, value);
  }

  const apps = [];
  const seen = new Set();
  let present = !!client;
  for (const key of keys) {
    const dump = await regQueryAll(key);
    if (!dump) continue;
    present = true;
    for (const rec of parseRegDump(dump)) {
      const v = rec.values;
      const name = v.gameName;
      const dir = v.path;
      if (!name || !dir) continue;
      const id = v.gameID || rec.key.split('\\').pop() || name;
      if (seen.has(id)) continue;
      seen.add(id);
      const exe = (v.exe && exists(v.exe)) ? v.exe : pickExe(dir, [name]);
      if (!exe) continue;
      apps.push({ source: 'gog', gameId: String(id), name, installPath: dir, exe, uri: null, installed: true });
    }
  }
  return { present, path: client || apps[0] && apps[0].installPath || null, apps };
}

async function scanUbisoft() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
    'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs',
    'HKCU\\Software\\Ubisoft\\Launcher\\Installs'
  ];
  const clientKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher',
    'HKCU\\Software\\Ubisoft\\Launcher'
  ];
  const apps = [];
  const seen = new Set();
  let present = false;
  let clientPath = null;

  const pf = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles;
  const guess = pf ? path.join(pf, 'Ubisoft', 'Ubisoft Game Launcher') : null;
  if (guess && exists(guess)) { present = true; clientPath = guess; }

  for (const key of keys) {
    const dump = await regQueryAll(key);
    if (!dump) continue;
    present = true;
    for (const rec of parseRegDump(dump)) {
      const dir = rec.values.InstallDir || rec.values.Path;
      const installId = rec.key.split('\\').pop();
      if (!dir || !installId || !/^\d+$/.test(installId)) continue;
      if (seen.has(installId)) continue;
      const trimmed = dir.replace(/[\\/]+$/, '');
      if (!exists(trimmed)) continue;
      seen.add(installId);
      const name = rec.values.DisplayName || path.basename(trimmed);
      apps.push({
        source: 'ubisoft',
        gameId: installId,
        name,
        installPath: trimmed,
        uri: `uplay://launch/${installId}/0`,
        exe: pickExe(trimmed, [name]),
        installed: true
      });
    }
  }
  for (const key of clientKeys) {
    const p = await regQuery(key, 'InstallDir');
    if (p) { present = true; clientPath = clientPath || p; }
  }
  return { present, path: clientPath, apps };
}

/** `"C:\x\game.exe",0` -> `C:\x\game.exe`; null when it is not an .exe. */
function displayIconPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Entries quote the path and may append an icon index: `"C:\x\y.exe",0`.
  const quoted = raw.match(/^"([^"]+)"/);
  const p = (quoted ? quoted[1] : raw.split(',')[0]).trim();
  return /\.exe$/i.test(p) ? p : null;
}

/** Uninstall entries that are the store client itself, never a game. */
const EA_CLIENT = /^(ea app|ea desktop|origin|electronic arts|ea anti-?cheat|eaac|ea help|ea background service|eabackgroundservice)$/i;

/**
 * Every record in the Windows uninstall registry, in real Unicode.
 *
 * `reg.exe` is deliberately not used for this one. When its output is piped it
 * is written in the OEM code page, and non-ASCII is silently *rewritten*: the
 * EA App's own entry for Battlefield(TM) 1 comes back as "BattlefieldT 1".
 * That is not cosmetic - the mangled name then fails to match the catalogue
 * title, so the game arrives in the library misspelled, unrecognised and
 * without its artwork. PowerShell has the same habit unless
 * [Console]::OutputEncoding is forced, which the prelude below does.
 */
function uninstallEntries() {
  return new Promise((resolve) => {
    if (!isWin) return resolve([]);
    const script = [
      "$ErrorActionPreference='SilentlyContinue';",
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');",
      'Get-ItemProperty $k |',
      '  Where-Object { $_.Publisher -and $_.DisplayName } |',
      '  Select-Object DisplayName,Publisher,InstallLocation,DisplayIcon |',
      '  ConvertTo-Json -Compress -Depth 3'
    ].join('\n');
    execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 25000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed = JSON.parse(stdout);
          return resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch { resolve([]); }
      });
  });
}

/**
 * Installed EA titles, across both generations of the store.
 *
 *   - The legacy `Electronic Arts\EA Games` keys, which Origin wrote for the
 *     older titles and which some installs still carry.
 *   - The Windows uninstall registry, which is the source that actually works
 *     for today's EA App. A title installed through the EA App lands there with
 *     `Publisher` = "Electronic Arts", an `InstallLocation` and - the valuable
 *     part - a `DisplayIcon` pointing straight at the game's own executable.
 *
 * That last field is why this source beats folder guessing. EA install trees
 * bury the real binary (Battlefield 1 ships `bf1.exe` next to `bf1Trial.exe`,
 * an EAAntiCheat launcher and a full `__Installer` tree), so `pickExe` is a coin
 * flip where `DisplayIcon` is authoritative.
 *
 * Modern EA App titles are absent from `EA Games` entirely, which is exactly why
 * an EA App install used to show up nowhere in Apex.
 */
async function scanEa() {
  const apps = [];
  const seen = new Set();
  let present = false;
  let clientPath = null;

  const add = (name, dir, exe) => {
    const id = norm(name);
    if (!id || seen.has(id) || !exe || !exists(exe)) return;
    seen.add(id);
    apps.push({ source: 'ea', gameId: id, name, installPath: dir, exe, uri: null, installed: true });
  };

  // --- legacy Origin keys (older titles) ----------------------------------
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Games', 'HKLM\\SOFTWARE\\Electronic Arts\\EA Games']) {
    const dump = await regQueryAll(key);
    if (!dump) continue;
    present = true;
    for (const rec of parseRegDump(dump)) {
      const v = rec.values;
      const dir = v['Install Dir'] || v.InstallDir || v.InstallLocation;
      const name = v.DisplayName || v.ProductName || rec.key.split('\\').pop();
      if (!dir || !name || !exists(dir)) continue;
      add(name, dir, (v.Executable && exists(v.Executable)) ? v.Executable : pickExe(dir, [name]));
    }
  }

  // --- the client itself, which also proves EA is present at all -----------
  for (const [key, value] of [
    ['HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop', 'DesktopAppPath'],
    ['HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop', 'DesktopAppPath'],
    ['HKLM\\SOFTWARE\\Electronic Arts\\EA Core', 'ClientPath']
  ]) {
    const p = await regQuery(key, value);
    if (p) { present = true; clientPath = clientPath || p; }
  }

  // --- today's EA App: the Windows uninstall registry ----------------------
  for (const rec of await uninstallEntries()) {
    if (!/electronic arts/i.test(String(rec.Publisher || ''))) continue;
    const name = String(rec.DisplayName || '').trim();
    if (!name || EA_CLIENT.test(name) || NON_GAME.test(name)) continue;
    const dir = String(rec.InstallLocation || '').replace(/[\\/]+$/, '');
    if (!dir || !exists(dir)) continue;
    present = true;
    const icon = displayIconPath(rec.DisplayIcon);
    add(name, dir, (icon && exists(icon)) ? icon : pickExe(dir, [name, path.basename(dir)]));
  }

  return {
    present,
    path: clientPath || (apps[0] && apps[0].installPath) || (present ? 'Windows registry (EA)' : null),
    apps
  };
}

async function scanBattleNet() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment',
    'HKLM\\SOFTWARE\\Blizzard Entertainment'
  ];
  const apps = [];
  const seen = new Set();
  let present = false;

  for (const key of keys) {
    const dump = await regQueryAll(key);
    if (!dump) continue;
    present = true;
    for (const rec of parseRegDump(dump)) {
      const v = rec.values;
      const dir = v.InstallLocation || v.InstallPath;
      const name = rec.key.split('\\').pop();
      if (!dir || !name || /^(blizzard entertainment|battle\.net|agents|capabilities)$/i.test(name)) continue;
      if (norm(name).length < 3 || !exists(dir)) continue;
      if (seen.has(norm(name))) continue;
      const exe = pickExe(dir, [name]);
      if (!exe) continue;
      seen.add(norm(name));
      apps.push({ source: 'battlenet', gameId: norm(name), name, installPath: dir, exe, uri: null, installed: true });
    }
  }
  return { present, path: present ? 'Windows registry (Blizzard Entertainment)' : null, apps };
}

function scanXbox() {
  const roots = [];
  for (const letter of 'CDEFGHIJ') {
    const p = `${letter}:\\XboxGames`;
    if (exists(p)) roots.push(p);
  }
  const apps = [];
  for (const root of roots) {
    for (const ent of safeReadDir(root)) {
      if (!ent.isDirectory()) continue;
      // Package-family GUIDs are not game names.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(ent.name)) continue;
      const dir = path.join(root, ent.name);
      const content = path.join(dir, 'Content');
      const base = exists(content) ? content : dir;
      const exe = pickExe(base, [ent.name]);
      if (!exe) continue;
      apps.push({ source: 'xbox', gameId: norm(ent.name), name: ent.name, installPath: base, exe, uri: null, installed: true });
    }
  }
  return { present: roots.length > 0, path: roots[0] || null, apps };
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------
/** Returns every balanced `"key" { ... }` block in a VDF document. */
function extractBlocks(text, key) {
  const blocks = [];
  const re = new RegExp(`"${key}"\\s*\\{`, 'gi');
  let m;
  while ((m = re.exec(text))) {
    const start = text.indexOf('{', m.index);
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { blocks.push(text.slice(start, i + 1)); break; }
      }
    }
  }
  return blocks;
}

/**
 * Steam keeps a licence list for every account it has signed in on this PC in
 *   <root>/userdata/<steamid>/config/localconfig.vdf
 * under Software > Valve > Steam > apps. Reading it is what lets the Store tell
 * "owned but not installed" apart from "not owned at all". Read-only, tolerant.
 */
function scanSteamOwned(roots) {
  const owned = new Set();
  for (const root of roots) {
    const userdata = path.join(root, 'userdata');
    for (const user of safeReadDir(userdata)) {
      if (!user.isDirectory() || !/^\d+$/.test(user.name)) continue;
      const vdf = safeReadFile(path.join(userdata, user.name, 'config', 'localconfig.vdf'));
      if (!vdf) continue;
      for (const block of extractBlocks(vdf, 'apps')) {
        for (const m of block.matchAll(/"(\d{2,8})"\s*\{/g)) owned.add(m[1]);
      }
    }
  }
  return owned;
}

/**
 * A few catalogue titles (VALORANT, and games from stores without a public
 * library database) are not distributed through Steam or Epic, so ownership is
 * inferred from their well-known folders. Each probe returns a ready-to-use
 * launch target rather than just a path.
 */
function localProbeTargets(id) {
  const pd = process.env.ProgramData || 'C:\\ProgramData';

  if (id === 'valorant') {
    const exe = 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe';
    if (exists(exe)) {
      return { type: 'exe', exe, cwd: path.dirname(exe), name: 'VALORANT', path: 'C:\\Riot Games\\VALORANT', source: 'local' };
    }
    const meta = path.join(pd, 'Riot Games', 'Metadata', 'valorant.live');
    if (exists(meta)) {
      return { type: 'uri', uri: 'riotclient://launch-valorant', name: 'VALORANT', path: meta, source: 'local' };
    }
    return null;
  }

  return null;
}

function scanLocalAvailability(hints) {
  const local = {};
  for (const h of hints) {
    const target = localProbeTargets(h.id);
    if (!target) continue;
    // Probe targets are launchable by construction, but "launchable" is not
    // the same as "verified": report what we actually found on disk.
    target.verify = verify.summarize(verify.verifyInstall(target));
    target.installed = target.verify.ok;
    local[h.id] = target;
  }
  return local;
}

// ---------------------------------------------------------------------------
// Matching against the renderer's catalogue hints
// ---------------------------------------------------------------------------
/**
 * @param {Array<{id:string,title:string,steamAppId?:string|null,epicNames?:string[]|null,gogIds?:string[]|null}>} hints
 */
async function detectAll(hints = []) {
  const steamRootsFound = isWin ? await findSteamRoots() : [];
  const libs = [];
  const addLib = (p) => {
    const n = path.normalize(p);
    if (!libs.some((l) => l.toLowerCase() === n.toLowerCase())) libs.push(n);
  };
  for (const root of steamRootsFound) {
    for (const lib of steamLibraries(root)) addLib(lib);
  }

  const steamApps = isWin ? libs.flatMap(scanSteamLibrary) : [];
  const epicApps = isWin ? scanEpic() : [];

  // The other storefronts keep their libraries in the Windows registry (GOG,
  // Ubisoft, EA, Battle.net) or a well-known folder (Xbox).
  const emptyStore = { present: false, path: null, apps: [] };
  const gog = isWin ? await scanGog() : emptyStore;
  const ubisoft = isWin ? await scanUbisoft() : emptyStore;
  const ea = isWin ? await scanEa() : emptyStore;
  const battlenet = isWin ? await scanBattleNet() : emptyStore;
  const xbox = isWin ? scanXbox() : emptyStore;
  const otherApps = [...gog.apps, ...ubisoft.apps, ...ea.apps, ...battlenet.apps, ...xbox.apps];

  const byAppId = new Map();
  const byTitle = new Map();
  const byGogId = new Map();
  for (const h of hints) {
    if (h.steamAppId) byAppId.set(String(h.steamAppId), h.id);
    byTitle.set(norm(h.title), h.id);
    for (const alt of (h.epicNames || [])) byTitle.set(norm(alt), h.id);
    // GOG stores each install under its product id, so a curated title that
    // declares one is matched exactly rather than by a fuzzy name comparison.
    for (const gid of (h.gogIds || [])) byGogId.set(String(gid), h.id);
  }

  const matched = {};
  const unknown = [];
  const seenUnknown = new Set();

  for (const app of steamApps) {
    const id = byAppId.get(app.appId);
    const descriptor = {
      type: 'steam',
      appId: app.appId,
      name: app.name,
      path: app.installPath || null,
      source: 'steam',
      // Carried so an explicit "Verify files" can re-check from the renderer
      // without re-reading the manifest.
      stateFlags: app.stateFlags || null,
      sizeOnDisk: app.sizeOnDisk || null,
      verify: app.verify || null,
      installed: app.installed
    };
    if (id) { if (!matched[id]) matched[id] = descriptor; continue; }
    // Games installed in more than one library would otherwise repeat.
    const key = `steam:${app.appId}`;
    if (app.installed && !NON_GAME.test(app.name) && !seenUnknown.has(key)) {
      seenUnknown.add(key);
      unknown.push(descriptor);
    }
  }

  for (const app of epicApps) {
    const id = byTitle.get(norm(app.name));
    // The install folder and the slim manifest travel with the link, so a later
    // renderer-side verify has the same facts detection just used. Without them
    // the link said "The install folder is gone" for games sitting right there.
    const base = {
      name: app.name,
      path: app.installPath || null,
      installPath: app.installPath || null,
      item: epicVerifyItem(app.item),
      source: 'epic',
      verify: app.verify || null,
      installed: app.installed
    };
    const descriptor = app.uri
      ? { type: 'epic', uri: app.uri, ...base }
      : { type: 'exe', exe: app.exe, cwd: app.installPath || null, ...base };
    if (id) { if (!matched[id]) matched[id] = descriptor; continue; }
    const key = `epic:${norm(app.name)}`;
    // Only offer titles we can actually start (launcher URI or a real .exe);
    // Epic also lists content packs / DLC manifests we should skip.
    const launchable = !!(app.uri || app.exe);
    const isContent = /\scontent$/i.test(app.name) || (Array.isArray(app.categories) && app.categories.includes('plugins'));
    if (app.installed && launchable && !isContent && !NON_GAME.test(app.name) && !seenUnknown.has(key)) {
      seenUnknown.add(key);
      unknown.push(descriptor);
    }
  }

  for (const app of otherApps) {
    const appVerify = verify.summarize(verify.verifyLocal({
      name: app.name,
      path: app.installPath || null,
      exe: app.exe || null,
      type: app.uri ? 'uri' : 'exe',
      uri: app.uri || null
    }));
    const descriptor = app.uri
      ? { type: 'uri', uri: app.uri, name: app.name, path: app.installPath || null, source: app.source, verify: appVerify, installed: appVerify.ok }
      : { type: 'exe', exe: app.exe, cwd: app.installPath || null, name: app.name, path: app.installPath || null, source: app.source, verify: appVerify, installed: appVerify.ok };
    // GOG carries an exact product id; every other store only has a name.
    const id = (app.source === 'gog' && app.gameId && byGogId.get(String(app.gameId)))
      || byTitle.get(norm(app.name));
    if (id) { if (!matched[id]) matched[id] = descriptor; continue; }
    const key = `${app.source}:${app.gameId || norm(app.name)}`;
    if (!seenUnknown.has(key)) { seenUnknown.add(key); unknown.push(descriptor); }
  }

  // --- ownership -----------------------------------------------------------
  // A licence in Steam's local config, a folder we recognise on disk, or any
  // installed manifest all count as "owned". Installed-but-unknown titles are
  // deliberately left out: the Store only offers what we can verify.
  const steamOwned = isWin ? scanSteamOwned(steamRootsFound) : new Set();
  const localAvail = isWin ? scanLocalAvailability(hints) : {};

  const owned = {};
  for (const h of hints) {
    if (h.steamAppId && steamOwned.has(String(h.steamAppId))) {
      owned[h.id] = { source: 'steam', appId: String(h.steamAppId) };
    } else if (localAvail[h.id]) {
      owned[h.id] = { source: 'local', path: localAvail[h.id].path || null };
    }
  }
  // Anything actually installed is owned by definition.
  for (const id of Object.keys(matched)) {
    if (!owned[id]) owned[id] = { source: matched[id].source || 'local' };
  }

  // Which store clients/libraries were found on this PC (Settings > Game Stores).
  const stores = {};
  const epicDir = epicManifestDirs().find(exists);
  if (steamRootsFound[0]) stores.steam = { path: steamRootsFound[0] };
  if (epicDir) stores.epic = { path: epicDir };
  if (gog.present) stores.gog = { path: gog.path || 'Installed' };
  if (ubisoft.present) stores.ubisoft = { path: ubisoft.path || 'Installed' };
  if (ea.present) stores.ea = { path: ea.path || 'Installed' };
  if (battlenet.present) stores.battlenet = { path: battlenet.path || 'Installed' };
  if (xbox.present) stores.xbox = { path: xbox.path || 'Installed' };

  return {
    roots: {
      steam: steamRootsFound[0] || null,
      steamLibraries: libs,
      epic: epicDir || null
    },
    stores,
    counts: {
      steam: steamApps.length,
      epic: epicApps.length,
      gog: gog.apps.length,
      ubisoft: ubisoft.apps.length,
      ea: ea.apps.length,
      battlenet: battlenet.apps.length,
      xbox: xbox.apps.length,
      owned: steamOwned.size
    },
    matched,
    owned,
    local: localAvail,
    unknown,
    // Per-catalogue-id verification results for anything we matched, so the
    // renderer can say *why* a game is not playable instead of guessing.
    reports: Object.fromEntries(
      Object.entries(matched).map(([id, d]) => [id, (d && d.verify) || null])
    )
  };
}

module.exports = { detectAll, findSteamRoots, steamLibraries, scanEpic, scanSteamOwned, scanEa, pickExe, uninstallEntries, displayIconPath };
