'use strict';

/**
 * Emulators and ROM shelves (main process).
 * -----------------------------------------------------------------------------
 * Apex does not ship or fetch games. What it does here is read-only and boring:
 *
 *   1. find the emulators already installed on this PC,
 *   2. walk the folders the user points it at and work out which console each
 *      file belongs to,
 *   3. hand a ROM to the right emulator when the user presses play.
 *
 * Everything is defensive. A missing directory, a locked file or a fourteen
 * gigabyte ISO sitting in a folder called "stuff" can never throw: the worst
 * case is a file that does not get listed, and the user can say otherwise by
 * putting it in a folder that names its console.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const detect = require('./detect');

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Consoles
// ---------------------------------------------------------------------------
// One entry per console Apex can recognise. `ext` is what the file has to end
// with; `plain` lists extensions that name their console unambiguously, while
// anything in AMBIGUOUS needs the folder path to decide (see systemForPath).
// `via` is the preference order of emulators, best first.

const SYSTEMS = {
  nes:        { label: 'NES',             full: 'Nintendo Entertainment System', group: 'Nintendo', ext: ['.nes', '.unf', '.unif', '.fds'], via: ['mesen', 'nestopia', 'fceux', 'retroarch'] },
  snes:       { label: 'SNES',            full: 'Super Nintendo',                group: 'Nintendo', ext: ['.sfc', '.smc', '.swc', '.fig'],    via: ['snes9x', 'mesen', 'retroarch'] },
  n64:        { label: 'N64',             full: 'Nintendo 64',                   group: 'Nintendo', ext: ['.z64', '.n64', '.v64'],            via: ['simple64', 'project64', 'mupen64plus', 'retroarch'] },
  gamecube:   { label: 'GameCube',        full: 'Nintendo GameCube',             group: 'Nintendo', ext: ['.gcm', '.rvz', '.dol', '.gcz'],     via: ['dolphin'] },
  wii:        { label: 'Wii',             full: 'Nintendo Wii',                  group: 'Nintendo', ext: ['.wbfs', '.wad', '.wia'],           via: ['dolphin'] },
  wiiu:       { label: 'Wii U',           full: 'Nintendo Wii U',                group: 'Nintendo', ext: ['.wud', '.wux', '.rpx'],            via: ['cemu'] },
  switch:     { label: 'Switch',          full: 'Nintendo Switch',               group: 'Nintendo', ext: ['.nsp', '.xci', '.nsz', '.xcz'],     via: ['ryujinx', 'yuzu', 'citron'] },
  vb:         { label: 'Virtual Boy',     full: 'Virtual Boy',                   group: 'Nintendo', ext: ['.vb'],                            via: ['retroarch', 'mednafen'] },

  gb:         { label: 'Game Boy',        full: 'Game Boy',                      group: 'Handheld', ext: ['.gb'],                            via: ['mgba', 'mesen', 'retroarch'] },
  gbc:        { label: 'Game Boy Color',  full: 'Game Boy Color',                group: 'Handheld', ext: ['.gbc'],                           via: ['mgba', 'mesen', 'retroarch'] },
  gba:        { label: 'Game Boy Advance', full: 'Game Boy Advance',             group: 'Handheld', ext: ['.gba', '.agb', '.srl'],            via: ['mgba', 'mesen', 'retroarch'] },
  nds:        { label: 'Nintendo DS',     full: 'Nintendo DS',                   group: 'Handheld', ext: ['.nds', '.dsi'],                     via: ['melonds', 'desmume', 'retroarch'] },
  '3ds':      { label: 'Nintendo 3DS',    full: 'Nintendo 3DS',                  group: 'Handheld', ext: ['.3ds', '.cci', '.cxi'],             via: ['azahar', 'citra'] },
  ws:         { label: 'WonderSwan',      full: 'WonderSwan',                     group: 'Handheld', ext: ['.ws', '.wsc'],                      via: ['retroarch', 'mednafen'] },

  ps1:        { label: 'PlayStation',     full: 'PlayStation',                   group: 'Sony', ext: ['.pbp', '.m3u'],                       via: ['duckstation', 'retroarch', 'mednafen'] },
  ps2:        { label: 'PlayStation 2',   full: 'PlayStation 2',                 group: 'Sony', ext: [],                                        via: ['pcsx2'] },
  ps3:        { label: 'PlayStation 3',   full: 'PlayStation 3',                 group: 'Sony', ext: [],                                        via: ['rpcs3'] },
  ps4:        { label: 'PlayStation 4',   full: 'PlayStation 4',                 group: 'Sony', ext: [],                                        via: ['shadps4', 'kyty'] },
  ps5:        { label: 'PlayStation 5',   full: 'PlayStation 5',                 group: 'Sony', ext: [],                                        via: ['kyty'] },
  psp:        { label: 'PSP',             full: 'PlayStation Portable',          group: 'Handheld', ext: ['.cso', '.dax'],                    via: ['ppsspp'] },
  vita:       { label: 'PS Vita',         full: 'PlayStation Vita',              group: 'Handheld', ext: ['.vpk'],                            via: ['vita3k'] },

  genesis:    { label: 'Mega Drive',      full: 'Sega Mega Drive / Genesis',     group: 'Sega', ext: ['.md', '.gen', '.smd', '.68k'],        via: ['blastem', 'retroarch', 'mednafen', 'fusion'] },
  mastersystem: { label: 'Master System', full: 'Sega Master System',            group: 'Sega', ext: ['.sms'],                              via: ['retroarch', 'mednafen', 'fusion'] },
  gamegear:   { label: 'Game Gear',       full: 'Sega Game Gear',                group: 'Sega', ext: ['.gg'],                               via: ['retroarch', 'mednafen', 'fusion'] },
  saturn:     { label: 'Saturn',          full: 'Sega Saturn',                   group: 'Sega', ext: [],                                       via: ['retroarch', 'mednafen'] },
  dreamcast:  { label: 'Dreamcast',       full: 'Sega Dreamcast',                group: 'Sega', ext: ['.cdi', '.gdi'],                     via: ['flycast', 'redream'] },

  atari2600:  { label: 'Atari 2600',      full: 'Atari 2600',                    group: 'Atari', ext: ['.a26'],                             via: ['stella', 'retroarch'] },
  atari7800:  { label: 'Atari 7800',      full: 'Atari 7800',                    group: 'Atari', ext: ['.a78'],                             via: ['retroarch'] },
  lynx:       { label: 'Atari Lynx',      full: 'Atari Lynx',                    group: 'Handheld', ext: ['.lnx'],                          via: ['retroarch', 'mednafen'] },

  pce:        { label: 'PC Engine',       full: 'PC Engine / TurboGrafx-16',     group: 'Other', ext: ['.pce', '.sgx'],                     via: ['retroarch', 'mednafen'] },
  arcade:     { label: 'Arcade',          full: 'Arcade',                        group: 'Arcade', ext: [],                                       via: ['mame', 'retroarch'] },
  neogeo:     { label: 'Neo Geo',         full: 'SNK Neo Geo',                   group: 'Arcade', ext: [],                                       via: ['mame', 'retroarch'] },
  dos:        { label: 'DOS',             full: 'MS-DOS',                        group: 'Other', ext: [],                                       via: ['dosbox'] },
  xbox360:    { label: 'Xbox 360',        full: 'Xbox 360',                      group: 'Other', ext: [],                                       via: ['xenia'] }
};

/**
 * Extensions that belong to more than one console. `.iso` alone could be PS2,
 * GameCube, Wii, PSP or Dreamcast, so the folder path has the final say and
 * these only fall back to a default when nothing in the path helps.
 */
const AMBIGUOUS = {
  '.iso': { systems: ['ps2', 'gamecube', 'wii', 'psp', 'ps1', 'dreamcast', 'saturn', 'ps3'], fallback: 'ps2' },
  '.pkg': { systems: ['ps3', 'ps4', 'ps5'], fallback: 'ps3' },
  '.chd': { systems: ['ps1', 'ps2', 'saturn', 'dreamcast'], fallback: 'ps1' },
  '.bin': { systems: ['ps1', 'genesis', 'atari2600'], fallback: 'ps1' },
  '.ccd': { systems: ['ps1', 'saturn'], fallback: 'ps1' },
  '.img': { systems: ['ps1', 'saturn'], fallback: 'ps1' },
  '.sub': { systems: ['ps1', 'saturn'], fallback: 'ps1' },
  '.zip': { systems: ['arcade', 'neogeo', 'dos'], fallback: 'arcade' },
  '.7z':  { systems: ['arcade', 'neogeo'], fallback: 'arcade' },
  '.rom': { systems: ['genesis', 'atari2600', 'lynx'], fallback: 'genesis' }
};

/** The sheet file that names a disc: the entry point for a multi-track game. */
const DISC_SHEET = /\.(cue|gdi|m3u|ccd|toc)$/i;
/**
 * The data tracks a disc is made of. These are only skipped when a sheet sits
 * beside them, because one game = one shelf entry: DuckStation wants the .cue,
 * not the .bin. A bare `.iso` is NOT a track - it is a whole disc on its own,
 * so it is always listed.
 */
const TRACK_EXT = new Set(['.bin', '.raw', '.track', '.wav', '.sub', '.img']);

/**
 * Words that name a console, checked against the *folder* part of a path when
 * an extension is ambiguous. Ordered longest/most specific first so "ps2" is
 * tested before a bare "ps", and every pattern is anchored on a word boundary
 * because short tokens like `gc` or `md` turn up inside ordinary words.
 */
const PATH_HINTS = [
  [/\bps\s*5\b|\bps5\b|playstation\s*5|kyty/i, 'ps5'],
  [/\bps\s*4\b|\bps4\b|playstation\s*4|shad\s*ps4/i, 'ps4'],
  [/\bps\s*2\b|\bps2\b|playstation\s*2|pcsx2/i, 'ps2'],
  [/\bps\s*3\b|\bps3\b|playstation\s*3|rpcs3/i, 'ps3'],
  [/\bpsx\b|\bps\s*1\b|\bps1\b|playstation\s*(1|one)|duckstation|epsxe/i, 'ps1'],
  [/\bpsp\b|ppsspp/i, 'psp'],
  [/\bvita\b|vita3k/i, 'vita'],
  [/\bgame\s*cube\b|gamecube|\bgcn?\b|dolphin/i, 'gamecube'],
  [/\bwii\s*u\b|wiiu|cemu/i, 'wiiu'],
  [/\bwii\b/i, 'wii'],
  [/\bdreamcast\b|flycast|redream/i, 'dreamcast'],
  [/\bsaturn\b/i, 'saturn'],
  [/\bswitch\b|yuzu|ryujinx|suyu|citron/i, 'switch'],
  [/\bnintendo\s*64\b|\bn64\b|project\s*64|mupen/i, 'n64'],
  [/\bsuper\s*nintendo\b|\bsnes\b|snes9x/i, 'snes'],
  [/\bnes\b|famicom|nestopia|fceux|\bmesen\b/i, 'nes'],
  [/\bgame\s*boy\s*advance\b|\bgba\b|mgba/i, 'gba'],
  [/\bgame\s*boy\s*color\b|\bgbc\b/i, 'gbc'],
  [/\bgame\s*boy\b|\bgb\b|gambatte/i, 'gb'],
  [/\bnintendo\s*ds\b|\bnds\b|desmume|melon\s*ds|melonds/i, 'nds'],
  [/\b3ds\b|citra|azahar/i, '3ds'],
  [/\bmega\s*drive\b|megadrive|\bgenesis\b|blastem|kega/i, 'genesis'],
  [/\bmaster\s*system\b|\bsms\b/i, 'mastersystem'],
  [/\bgame\s*gear\b|\bgamegear\b|\bgg\b/i, 'gamegear'],
  [/\batari\s*2600\b|\ba26\b|stella/i, 'atari2600'],
  [/\batari\s*7800\b|\ba78\b/i, 'atari7800'],
  [/\blynx\b/i, 'lynx'],
  [/\bneo\s*geo\b|neogeo/i, 'neogeo'],
  [/\bmame\b|arcade|\bfba\b|finalburn/i, 'arcade'],
  [/\bpc\s*engine\b|turbografx|\bpce\b/i, 'pce'],
  [/\bwonderswan\b|\bws\b/i, 'ws'],
  [/\bdos\b|dosbox/i, 'dos'],
  [/\bxbox\s*360\b|xenia/i, 'xbox360'],
  [/\bvirtual\s*boy\b|\bvb\b/i, 'vb']
];

/**
 * The RetroArch core Apex reaches for on each console, best first.
 *
 * RetroArch is a front-end rather than an emulator: handed a ROM with no `-L`
 * it loads the content, and when no core is associated with that file it has
 * nothing to run, so it opens its own menu. From the outside that is the
 * difference between "the game started" and "the emulator started", which is
 * why the core is named explicitly and passed ahead of the ROM.
 *
 * The names are the shipped core file names, so a core that is not installed
 * simply falls through to the next candidate and finally to RetroArch's own
 * content loading.
 */
const RETRO_CORES = {
  nes:          ['mesen_libretro.dll', 'fceumm_libretro.dll', 'nestopia_libretro.dll'],
  snes:         ['snes9x_libretro.dll', 'bsnes_libretro.dll', 'mesen-s_libretro.dll'],
  n64:          ['mupen64plus_next_libretro.dll', 'parallel_n64_libretro.dll'],
  vb:           ['mednafen_vb_libretro.dll'],
  gb:           ['gambatte_libretro.dll', 'sameboy_libretro.dll'],
  gbc:          ['gambatte_libretro.dll', 'sameboy_libretro.dll'],
  gba:          ['mgba_libretro.dll', 'vba_next_libretro.dll'],
  nds:          ['melonds_libretro.dll', 'desmume_libretro.dll'],
  ws:           ['mednafen_wswan_libretro.dll'],
  ps1:          ['swanstation_libretro.dll', 'beetle_psx_hw_libretro.dll', 'pcsx_rearmed_libretro.dll'],
  genesis:      ['genesis_plus_gx_libretro.dll', 'picodrive_libretro.dll'],
  mastersystem: ['genesis_plus_gx_libretro.dll', 'smsplus_libretro.dll'],
  gamegear:     ['genesis_plus_gx_libretro.dll'],
  saturn:       ['mednafen_saturn_libretro.dll', 'kronos_libretro.dll', 'yabause_libretro.dll'],
  atari2600:    ['stella_libretro.dll', 'stella2014_libretro.dll'],
  atari7800:    ['prosystem_libretro.dll'],
  lynx:         ['handy_libretro.dll', 'mednafen_lynx_libretro.dll'],
  pce:          ['mednafen_pce_libretro.dll', 'mednafen_pce_fast_libretro.dll'],
  arcade:       ['mame_libretro.dll', 'fbneo_libretro.dll'],
  neogeo:       ['fbneo_libretro.dll', 'mame_libretro.dll']
};

// ---------------------------------------------------------------------------
// Emulators
// ---------------------------------------------------------------------------
// `exe` lists candidate binary names, best first. `dirs` is how an install
// folder gives itself away. `arg` says how the ROM path is passed; almost every
// emulator takes it bare, and the exceptions are listed explicitly.

const EMULATORS = {
  retroarch:    { name: 'RetroArch',            dirs: [/^retroarch/i], exe: ['retroarch.exe'], systems: Object.keys(RETRO_CORES) },
  dolphin:      { name: 'Dolphin',              dirs: [/^dolphin/i], exe: ['Dolphin.exe', 'dolphin.exe'], arg: ['-e'], systems: ['gamecube', 'wii'] },
  pcsx2:        { name: 'PCSX2',                dirs: [/^pcsx2/i], exe: ['pcsx2-qt.exe', 'pcsx2.exe'], systems: ['ps2'] },
  rpcs3:        { name: 'RPCS3',                dirs: [/^rpcs3/i], exe: ['rpcs3.exe'], systems: ['ps3'] },
  // KytyPS5 - the maintained fork of the original Kyty - ships the window and
  // the game runner as two binaries: `kyty_launcher.exe` is the Qt game list,
  // and `kyty_emulator.exe` is what loads a title, with the path behind
  // `--game`. The original Kyty's own runner (`fc_script.exe`) is deliberately
  // not listed: an install still carrying it is a build Apex cannot place, so it
  // is offered the current release instead of being treated as up to date. Its
  // window (`launcher.exe`) *is* listed, second, for the opposite reason: so that
  // until the user takes that update, Launch still opens the window that install
  // already has rather than running its runner bare into a hidden console.
  kyty:         { name: 'KytyPS5',              dirs: [/^kyty/i], exe: ['kyty_emulator.exe', 'kyty.exe', 'Kyty.exe'], gui: ['kyty_launcher.exe', 'launcher.exe'], arg: ['--game'], systems: ['ps5', 'ps4'] },
  // shadPS4's Windows download is a single self-contained `shadPS4.exe` - no
  // Qt DLLs beside it - and it boots a title by path, behind `-g`. The project
  // split its Qt interface into a separate rolling repository, but that one only
  // publishes prereleases and needs the core anyway; the core's own build is the
  // complete program, so this is what Apex installs and looks for.
  shadps4:      { name: 'shadPS4',              dirs: [/^shad\s*ps4/i, /^shadps4/i], exe: ['shadPS4.exe', 'shadps4.exe'], arg: ['-g'], systems: ['ps4'] },
  duckstation:  { name: 'DuckStation',          dirs: [/^duckstation/i], exe: ['duckstation-qt-x64-ReleaseLTCG.exe', 'duckstation-qt-x64-ReleaseAVX2.exe', 'duckstation-qt-x64-Release.exe', 'duckstation-nogui-x64-ReleaseLTCG.exe', 'duckstation.exe'], systems: ['ps1'] },
  ppsspp:       { name: 'PPSSPP',               dirs: [/^ppsspp/i], exe: ['PPSSPPWindows64.exe', 'PPSSPPWindows.exe', 'PPSSPP.exe'], systems: ['psp'] },
  cemu:         { name: 'Cemu',                 dirs: [/^cemu/i], exe: ['Cemu.exe', 'cemu.exe'], arg: ['-g'], systems: ['wiiu'] },
  ryujinx:      { name: 'Ryujinx',              dirs: [/^ryujinx/i], exe: ['Ryujinx.exe', 'Ryujinx.Ava.exe'], systems: ['switch'] },
  yuzu:         { name: 'yuzu',                 dirs: [/^yuzu/i], exe: ['yuzu.exe'], systems: ['switch'] },
  citron:       { name: 'Citron',               dirs: [/^citron/i], exe: ['citron.exe'], systems: ['switch'] },
  azahar:       { name: 'Azahar',               dirs: [/^azahar/i], exe: ['azahar.exe'], systems: ['3ds'] },
  citra:        { name: 'Citra',                dirs: [/^citra/i], exe: ['citra-qt.exe', 'citra.exe'], systems: ['3ds'] },
  mgba:         { name: 'mGBA',                 dirs: [/^mgba/i], exe: ['mGBA.exe', 'mgba.exe'], systems: ['gb', 'gbc', 'gba'] },
  melonds:      { name: 'melonDS',              dirs: [/^melon/i], exe: ['melonDS.exe', 'melonds.exe'], systems: ['nds'] },
  desmume:      { name: 'DeSmuME',              dirs: [/^desmume/i], exe: ['DeSmuME.exe', 'desmume.exe', 'DeSmuME_x64.exe'], systems: ['nds'] },
  snes9x:       { name: 'Snes9x',               dirs: [/^snes9x/i], exe: ['snes9x-x64.exe', 'snes9x.exe'], systems: ['snes'] },
  mesen:        { name: 'Mesen',                dirs: [/^mesen/i], exe: ['Mesen.exe', 'mesen.exe'], systems: ['nes', 'snes', 'gb', 'gbc', 'gba', 'pce'] },
  nestopia:     { name: 'Nestopia',             dirs: [/^nestopia/i], exe: ['nestopia.exe'], systems: ['nes'] },
  fceux:        { name: 'FCEUX',                dirs: [/^fceux/i], exe: ['fceux.exe'], systems: ['nes'] },
  project64:    { name: 'Project64',            dirs: [/^project\s*64/i], exe: ['Project64.exe', 'project64.exe'], systems: ['n64'] },
  mupen64plus:  { name: 'Mupen64Plus',          dirs: [/^mupen/i], exe: ['mupen64plus.exe', 'mupen64plus-ui-console.exe'], systems: ['n64'] },
  simple64:     { name: 'Simple64',             dirs: [/^simple64/i], exe: ['simple64-gui.exe', 'simple64.exe'], systems: ['n64'] },
  blastem:      { name: 'BlastEm',              dirs: [/^blastem/i], exe: ['blastem.exe'], systems: ['genesis'] },
  fusion:       { name: 'Kega Fusion',          dirs: [/^kega|^fusion/i], exe: ['Fusion.exe', 'fusion.exe'], systems: ['genesis', 'mastersystem', 'gamegear'] },
  flycast:      { name: 'Flycast',              dirs: [/^flycast/i], exe: ['flycast.exe', 'flycast-win64.exe'], systems: ['dreamcast'] },
  redream:      { name: 'redream',              dirs: [/^redream/i], exe: ['redream.exe'], systems: ['dreamcast'] },
  stella:       { name: 'Stella',               dirs: [/^stella/i], exe: ['Stella.exe', 'stella.exe'], systems: ['atari2600'] },
  mame:         { name: 'MAME',                 dirs: [/^mame/i], exe: ['mame.exe', 'mame64.exe'], systems: ['arcade', 'neogeo'] },
  mednafen:     { name: 'Mednafen',             dirs: [/^mednafen/i], exe: ['mednafen.exe'], systems: ['vb', 'ps1', 'pce', 'ws', 'saturn', 'lynx'] },
  dosbox:       { name: 'DOSBox',               dirs: [/^dosbox/i], exe: ['DOSBox.exe', 'dosbox.exe'], systems: ['dos'] },
  vita3k:       { name: 'Vita3K',               dirs: [/^vita3k/i], exe: ['Vita3K.exe'], systems: ['vita'] },
  xenia:        { name: 'Xenia',                dirs: [/^xenia/i], exe: ['xenia_canary.exe', 'xenia.exe'], systems: ['xbox360'] }
};

/** Folders that tend to hold an emulator, relative to a base directory. */
const EMU_DIR_NAMES = /^(retroarch|dolphin|pcsx2|rpcs3|kyty|shad\s*ps4|duckstation|ppsspp|cemu|ryujinx|yuzu|citron|azahar|citra|mgba|melon|desmume|snes9x|mesen|nestopia|fceux|project\s*64|mupen|simple64|blastem|kega|fusion|flycast|redream|stella|mame|mednafen|dosbox|vita3k|xenia)/i;

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}
function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; }
}
function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// ---------------------------------------------------------------------------
// The emulators Apex downloaded itself
// ---------------------------------------------------------------------------
// The "Get emulators" shelf installs into a folder of our own and records the
// binary it found here. Detection reads this file, so a finished download shows
// up on the very next scan without the user having to point Apex at anything.

function apexDataDir() {
  try {
    return require('electron').app.getPath('userData');
  } catch {
    // Not under Electron (a plain-node probe): land on the same folder the app
    // itself uses. Electron's userData is %APPDATA%\<name> on Windows and
    // ~/.config/<name> elsewhere, so LOCALAPPDATA is deliberately the last
    // resort - the app's Emulators folder is not there.
    const base = process.env.APPDATA
      || (process.env.HOME ? path.join(process.env.HOME, '.config') : '')
      || process.env.LOCALAPPDATA
      || process.cwd();
    return path.join(base, 'Apex Launcher');
  }
}

/** Where Apex keeps the emulators it downloads. */
function emulatorRoot() {
  return path.join(apexDataDir(), 'Emulators');
}

function managedFile() {
  return path.join(apexDataDir(), 'apex-emulators.json');
}

/** id -> exe, with anything since deleted quietly dropped. */
function readManaged() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(managedFile(), 'utf8')); }
  catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};

  const out = {};
  const healed = {};
  for (const [id, exe] of Object.entries(raw)) {
    const spec = EMULATORS[id];
    if (!spec || !isFile(exe)) continue;
    // A download records whatever file name the release happened to use, and a
    // release that renames or re-orders its binaries leaves that guess stale.
    // KytyPS5 is the live example: it renamed the game runner from the original
    // Kyty's `fc_script.exe` to `kyty_emulator.exe`, and re-resolving against
    // the spec's own order lets a record correct itself instead of needing a
    // fresh download.
    const preferred = exeIn(path.dirname(exe), spec);
    out[id] = preferred || exe;
    if (preferred && preferred !== exe) healed[id] = preferred;
  }
  for (const [id, exe] of Object.entries(healed)) writeManaged(id, exe);
  return out;
}

/** Records one downloaded emulator and returns the whole map. */
function writeManaged(id, exe) {
  const all = {};
  try { Object.assign(all, JSON.parse(fs.readFileSync(managedFile(), 'utf8'))); }
  catch { /* first run, or the file was edited into nonsense */ }
  if (id) {
    if (exe) all[id] = exe;
    else delete all[id];
  }
  try {
    fs.mkdirSync(path.dirname(managedFile()), { recursive: true });
    fs.writeFileSync(managedFile(), JSON.stringify(all, null, 2), 'utf8');
  } catch { /* a read-only profile just means detection falls back to a scan */ }
  return all;
}

// ---------------------------------------------------------------------------
// Which build each download came from
// ---------------------------------------------------------------------------
// Emulators that publish several builds a day make "is mine still current?"
// worth answering, and the only way to answer it is to remember what was
// installed. This is kept beside the binaries rather than inside
// apex-emulators.json: that file is a plain id -> path map which detection reads
// on every scan, and widening it would touch every reader for the sake of one
// field nobody there needs.

function versionFile() {
  return path.join(apexDataDir(), 'apex-emulator-versions.json');
}

/** id -> { version, at }. Anything unreadable simply means "nothing known". */
function readVersions() {
  try {
    const raw = JSON.parse(fs.readFileSync(versionFile(), 'utf8'));
    return (raw && typeof raw === 'object') ? raw : {};
  } catch { return {}; }
}

/** Records the release a downloaded emulator came from. */
function writeVersion(id, version) {
  const all = readVersions();
  if (id) {
    if (version) all[id] = { version, at: Date.now() };
    else delete all[id];
  }
  try {
    fs.mkdirSync(path.dirname(versionFile()), { recursive: true });
    fs.writeFileSync(versionFile(), JSON.stringify(all, null, 2), 'utf8');
  } catch { /* a read-only profile only costs the update check */ }
  return all;
}

/** Every directory an emulator plausibly lives in on this machine. */
function emulatorSearchRoots() {
  const roots = [];
  const env = process.env;
  const home = env.USERPROFILE || env.HOME || '';

  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA', 'ProgramData']) {
    if (env[key]) roots.push(env[key]);
  }
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'Programs'));
  if (home) {
    roots.push(home);
    roots.push(path.join(home, 'Desktop'));
    roots.push(path.join(home, 'Downloads'));
    roots.push(path.join(home, 'Documents'));
    roots.push(path.join(home, 'Emulators'));
    roots.push(path.join(home, 'Games'));
  }
  // Drive roots, plus the folders people actually keep emulators in. This is
  // one readdir per entry, so it stays cheap even with a full disk.
  for (const letter of 'CDEFGH') {
    roots.push(`${letter}:\\`);
    roots.push(`${letter}:\\Emulators`);
    roots.push(`${letter}:\\Games`);
    roots.push(`${letter}:\\Games\\Emulators`);
    roots.push(`${letter}:\\Retro`);
  }
  return roots.filter((r, i, all) => r && all.indexOf(r) === i && isDir(r));
}

/** Finds the binary inside an install folder, one level into subfolders too. */
function exeIn(dir, spec) {
  for (const name of spec.exe) {
    const direct = path.join(dir, name);
    if (isFile(direct)) return direct;
  }
  // A lot of emulators ship as a folder with the exe one level down ({app,
  // bin, x64}) or as a versioned folder.
  for (const entry of safeReadDir(dir)) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    for (const name of spec.exe) {
      const p = path.join(sub, name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * Emulators installed on this PC.
 *
 * Two independent sources, because neither is complete on its own: the folders
 * people unpack emulators into, and the uninstall registry, which is where an
 * emulator that arrived with an installer announces itself - along with a
 * `DisplayIcon` that points at the real binary even when the folder name gives
 * nothing away.
 *
 * `overrides` lets the user pin a binary by hand (Settings and the Emulators
 * page both offer it), and always wins.
 */
async function detectEmulators(overrides) {
  const pinned = (overrides && typeof overrides === 'object') ? overrides : {};
  const found = {};

  const claim = (id, exe, via) => {
    if (found[id] || !exe || !isFile(exe)) return;
    found[id] = { id, name: EMULATORS[id].name, exe, systems: EMULATORS[id].systems.slice(), via };
  };

  // 1. Anything the user pinned by hand.
  for (const [id, exe] of Object.entries(pinned)) {
    if (EMULATORS[id]) claim(id, exe, 'manual');
  }

  // 2. What the "Get emulators" shelf installed. A path the user pinned by hand
  // still wins, but a download gets its own label rather than looking like
  // something they set up themselves.
  for (const [id, exe] of Object.entries(readManaged())) {
    if (EMULATORS[id]) claim(id, exe, 'apex');
  }

  // 3. Folders that look like an emulator install.
  for (const root of emulatorSearchRoots()) {
    for (const entry of safeReadDir(root)) {
      if (!entry.isDirectory() || !EMU_DIR_NAMES.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      for (const id of Object.keys(EMULATORS)) {
        const spec = EMULATORS[id];
        if (!spec.dirs.some((re) => re.test(entry.name))) continue;
        claim(id, exeIn(dir, spec), 'folder');
      }
    }
  }

  // 4. The uninstall registry.
  try {
    for (const rec of await detect.uninstallEntries()) {
      const name = String(rec.DisplayName || '');
      const where = String(rec.InstallLocation || '');
      const icon = detect.displayIconPath(rec.DisplayIcon);
      for (const id of Object.keys(EMULATORS)) {
        const spec = EMULATORS[id];
        if (found[id]) continue;
        // Only names Apex recognises, matched against the emulator's own folder
        // patterns, so an unrelated app called "Fusion" is not claimed.
        if (!spec.dirs.some((re) => re.test(name.replace(/[^a-z0-9 ]/gi, ' ').trim()))) continue;
        let exe = null;
        if (icon && /\.exe$/i.test(icon) && isFile(icon) && !/unins/i.test(icon)) exe = icon;
        if (!exe && where && isDir(where)) exe = exeIn(where, spec);
        claim(id, exe, 'registry');
      }
    }
  } catch { /* the registry is a bonus, never a requirement */ }

  const emulators = Object.values(found);

  // Which emulator wins each console: the first installed one on that
  // console's preference list.
  const systems = {};
  for (const [key, sys] of Object.entries(SYSTEMS)) {
    const pick = sys.via.find((id) => found[id]);
    systems[key] = pick ? { emulator: pick, name: found[pick].name, exe: found[pick].exe } : null;
  }

  return { emulators, systems };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The console named by the folder part of a path, or null. */
function systemForPath(filePath) {
  const dir = path.dirname(filePath).replace(/[\\/]+/g, ' ');
  for (const [re, key] of PATH_HINTS) {
    if (re.test(dir)) return key;
  }
  return null;
}

/** The console a file belongs to, or null when nothing claims it. */
function systemForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // A plain extension that only ever means one console.
  for (const [key, sys] of Object.entries(SYSTEMS)) {
    if (sys.ext.includes(ext)) return key;
  }

  // One that several consoles share: the folder decides, best first.
  const amb = AMBIGUOUS[ext];
  if (amb) {
    const hint = systemForPath(filePath);
    return (hint && amb.systems.includes(hint)) ? hint : amb.fallback;
  }
  return null;
}

/** A friendlier title than the file name. */
function titleFor(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/[_]+/g, ' ')
    .replace(/\s*\((?:usa|europe|japan|world|rev\s*\d+|en|fr|de|es|it|disc\s*\d+)[^)]*\)\s*/gi, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || base;
}

const MAX_FILES = 6000;
const MAX_DEPTH = 6;

/**
 * Walks the given folders and returns every ROM it can identify.
 *
 * `max` bounds the walk so pointing Apex at a whole drive cannot hang the UI;
 * when the cap is hit the result says so and the page offers to narrow the
 * folder down instead of pretending the list is complete.
 */
function scanRoms(folders, opts) {
  const list = Array.isArray(folders) ? folders.filter((f) => typeof f === 'string' && f.trim()) : [];
  const max = (opts && Number(opts.max)) || MAX_FILES;
  const roms = [];
  const skipped = [];
  let capped = false;

  const consider = (filePath) => {
    const system = systemForFile(filePath);
    if (!system) return;
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { size = 0; }
    if (size < 64) return;                      // a stray shortcut, not a ROM
    roms.push({
      path: filePath,
      name: path.basename(filePath),
      title: titleFor(filePath),
      system,
      size,
      dir: path.dirname(filePath)
    });
  };

  const walk = (dir, depth) => {
    if (capped || depth > MAX_DEPTH) return;
    const entries = safeReadDir(dir);
    const files = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); if (capped) return; continue; }
      if (!entry.isFile()) continue;
      files.push(full);
    }

    // A disc that ships as a .cue plus its .bin tracks (or a .gdi plus its raw
    // tracks) has to appear once. The sheet is the entry point, so that is what
    // the emulator gets handed and the tracks beside it are left out.
    const sheets = files.filter((f) => DISC_SHEET.test(f)).length > 0;
    const chosen = sheets
      ? files.filter((f) => DISC_SHEET.test(f) || !TRACK_EXT.has(path.extname(f).toLowerCase()))
      : files;

    const kept = new Set(chosen);
    for (const f of chosen) {
      if (roms.length >= max) { capped = true; return; }
      consider(f);
    }
    for (const f of files) {
      if (!kept.has(f) && systemForFile(f)) skipped.push(path.basename(f));
    }
  };

  for (const folder of list) {
    if (!isDir(folder)) continue;
    walk(folder, 0);
    if (capped) break;
  }

  // Grouped for the shelves, biggest shelf first so the page leads with what
  // the user actually has.
  const bySystem = {};
  for (const rom of roms) (bySystem[rom.system] = bySystem[rom.system] || []).push(rom);
  for (const key of Object.keys(bySystem)) bySystem[key].sort((a, b) => a.title.localeCompare(b.title));

  return {
    ok: true,
    roms,
    bySystem,
    count: roms.length,
    capped,
    folders: list,
    skippedTracks: skipped.length
  };
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/** The emulator that owns a console, resolved fresh so a new install is picked up. */
/** The first RetroArch core for a console that is actually present on disk. */
function retroCore(exe, system) {
  const names = RETRO_CORES[system];
  if (!names) return null;
  const dir = path.join(path.dirname(exe), 'cores');
  for (const name of names) {
    const full = path.join(dir, name);
    if (isFile(full)) return full;
  }
  return null;
}

async function resolveFor(system, overrides) {
  const sys = SYSTEMS[system];
  if (!sys) return null;
  const { emulators, systems } = await detectEmulators(overrides);

  const direct = systems[system];
  if (direct) return direct;

  // Nothing dedicated: RetroArch is the fallback that covers almost everything,
  // but only for a console it actually has a core for. Handing it a console it
  // cannot load just opens RetroArch's own menu, which reads as "the game did
  // not start".
  const retro = emulators.find((e) => e.id === 'retroarch');
  if (retro && RETRO_CORES[system]) return { emulator: 'retroarch', name: retro.name, exe: retro.exe };

  // Last resort: anything the user pinned that claims the console.
  for (const e of emulators) {
    if (e.systems.includes(system)) return { emulator: e.id, name: e.name, exe: e.exe };
  }
  return null;
}

/**
 * Opens a ROM in the emulator that owns its console.
 *
 * The emulator is started detached and unref'd: Apex has no business owning the
 * game's lifetime, and closing the launcher must never take a game down with it.
 *
 * A bad path or a binary Windows refuses to run arrives as an asynchronous
 * `error` event rather than a throw, so this waits for it. Without that wait an
 * unhandled 'error' would come out of the event loop and take the main process
 * with it, which would mean a broken emulator entry could kill the launcher.
 */
async function launch(system, romPath, opts) {
  const overrides = (opts && opts.overrides) || null;
  if (!romPath || !isFile(romPath)) return { ok: false, error: 'That file is not there any more.' };

  const target = await resolveFor(system, overrides);
  if (!target) {
    return {
      ok: false,
      needsEmulator: true,
      error: `No emulator for ${(SYSTEMS[system] || {}).full || system} is installed yet.`
    };
  }

  const spec = EMULATORS[target.emulator] || {};
  // RetroArch takes its core as `-L <core>` ahead of the content; every other
  // emulator takes the path on its own, or with the fixed prefix in `spec.arg`.
  const core = target.emulator === 'retroarch' ? retroCore(target.exe, system) : null;
  const args = (core ? ['-L', core] : []).concat(spec.arg || [], [romPath]);
  const started = { ok: true, emulator: target.name, exe: target.exe, system, title: titleFor(romPath) };
  return spawnEmulator(target, args, started);
}

/**
 * The binary a bare launch should open.
 *
 * A few emulators ship the window and the game runner as separate files.
 * KytyPS5 is the one in the catalogue: `kyty_emulator.exe` wants a title behind
 * `--game`, `kyty_launcher.exe` is the game list, and running the runner with
 * nothing to run just prints its own help into a console nobody sees - which
 * looks exactly like the button doing nothing. So when a spec names a `gui`, and
 * it is really there, that is what a bare launch opens.
 *
 * A spec may name several, in order of preference: KytyPS5 also lists the
 * original Kyty's `launcher.exe` after its own, so an install that has not taken
 * the update yet still opens the window it ships with.
 */
function guiBinary(id, exe) {
  const spec = EMULATORS[id] || {};
  if (!spec.gui) return exe;
  const names = Array.isArray(spec.gui) ? spec.gui : [spec.gui];
  for (const name of names) {
    const gui = path.join(path.dirname(exe), name);
    if (isFile(gui)) return gui;
  }
  return exe;
}

/**
 * Starts an emulator with nothing loaded in it.
 *
 * Same spawn as a ROM launch minus the ROM: plenty of emulators boot to their
 * own menu, which is where controllers, BIOS files and memory cards get sorted
 * out before any game is involved.
 */
async function run(id, overrides) {
  const { emulators: found } = await detectEmulators(overrides || null);
  const target = found.find((e) => e.id === id);
  if (!target) {
    return { ok: false, error: `${(EMULATORS[id] || {}).name || id} is not installed yet.` };
  }
  const exe = guiBinary(id, target.exe);
  return spawnEmulator({ ...target, exe }, [], { ok: true, emulator: target.name, exe, id });
}

/**
 * The spawn itself, shared by a ROM launch and a bare emulator launch.
 *
 * The child is detached and unref'd: Apex has no business owning the game's
 * lifetime, and closing the launcher must never take the emulator down with it.
 * A bad path or a binary Windows refuses to run arrives as an asynchronous
 * `error` event rather than a throw, so this waits for it - without that wait an
 * unhandled 'error' would come out of the event loop and take the main process
 * with it, which would mean a broken emulator entry could kill the launcher.
 */
async function spawnEmulator(target, args, started) {
  let child;
  try {
    child = spawn(target.exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(target.exe)
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'The emulator refused to start.' };
  }

  const result = await new Promise((resolve) => {
    // 'spawn' means the process really exists. Give it a moment to fail, but do
    // not hold the click hostage - after this long the process is running.
    const timer = setTimeout(() => resolve(started), 2000);
    child.once('spawn', () => { clearTimeout(timer); resolve(started); });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Could not start ${target.name}: ${(err && err.message) || 'unknown error'}` });
    });
  });

  try { child.unref(); } catch { /* already gone */ }
  return result;
}

module.exports = {
  SYSTEMS,
  EMULATORS,
  systems: () => Object.entries(SYSTEMS).map(([id, s]) => ({ id, ...s })),
  detectEmulators,
  scanRoms,
  launch,
  run,
  guiBinary,
  resolveFor,
  systemForFile,
  systemForPath,
  titleFor,
  emulatorRoot,
  managedFile,
  versionFile,
  readManaged,
  writeManaged,
  readVersions,
  writeVersion
};
