'use strict';

/**
 * Emulator downloads (main process).
 * -----------------------------------------------------------------------------
 * An emulator is a legal, ordinary program, and every one listed here is
 * published by the people who make it. What this module does is fetch that
 * program from its official release page, unpack it into a folder Apex owns,
 * and tell `emulators.js` where the binary landed.
 *
 * What it deliberately does not do is supply games. A catalogue entry is a
 * console program - never a ROM, an ISO or a BIOS - and the shelf points at the
 * project's own download page as well, so nothing here is a mirror.
 *
 * Two kinds of entry:
 *
 *   repo + asset   the project publishes Windows builds as GitHub release
 *                  assets, resolved fresh from the API every time, so the
 *                  download never rots at a version someone pinned once.
 *   page only      the project ships from its own site (or, in Kega Fusion's
 *                  case, is freeware rather than open source). Apex opens that
 *                  page and picks the emulator up afterwards, because detection
 *                  already looks in the usual install folders.
 */

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const http = require('./net/http');
const archives = require('./net/archives');
const emulators = require('./emulators');

/** Sections, in the order the page shows them. */
const GROUPS = ['Nintendo', 'Handheld', 'Sony', 'Sega', 'Atari', 'Other'];

// ---------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------
// `mb` is filled in only where the release asset was actually measured, so a
// size on a card is a fact rather than a guess; everything else stays quiet
// until the download reports its own total.
//
// `asset` is matched against the newest release's file names. Anchored at the
// end so a checksum sidecar (`...7z.sha256`) or an installer never wins.

const CATALOG = [
  // --- Nintendo ------------------------------------------------------------
  {
    id: 'mesen', name: 'Mesen', group: 'Nintendo',
    systems: ['nes', 'snes', 'gb', 'gbc', 'gba', 'pce'],
    blurb: 'The most accurate NES emulator there is, and a first-rate SNES, Game Boy and PC Engine one as well.',
    repo: 'SourMesen/Mesen2', asset: /Mesen_.*_Windows\.zip$/i,
    page: 'https://www.mesen.ca/'
  },
  {
    id: 'snes9x', name: 'Snes9x', group: 'Nintendo',
    systems: ['snes'],
    blurb: 'Lightweight, reliable Super Nintendo emulation that runs on anything.',
    repo: 'snes9xgit/snes9x', asset: /win32-x64\.zip$/i, mb: 5,
    page: 'https://www.snes9x.com/'
  },
  {
    id: 'simple64', name: 'Simple64', group: 'Nintendo',
    systems: ['n64'],
    blurb: 'A modern, accurate Nintendo 64 emulator built on a maintained Mupen64Plus core.',
    repo: 'simple64/simple64', asset: /simple64-win64.*\.zip$/i, mb: 47,
    page: 'https://github.com/simple64/simple64/releases'
  },
  {
    id: 'dolphin', name: 'Dolphin', group: 'Nintendo',
    systems: ['gamecube', 'wii'],
    blurb: 'The premier GameCube and Wii emulator — HD resolutions, widescreen hacks and netplay.',
    // Dolphin has no GitHub releases at all - the project publishes from its own
    // host - so this is the release build itself rather than a feed lookup. The
    // development builds are newer but have no fixed address (their path carries
    // a commit hash), which is no use to a launcher. The pin moves when Dolphin
    // cuts a release, roughly quarterly, and anyone holding an older build is
    // offered the newer one.
    url: 'https://dl.dolphin-emu.org/releases/2609a/dolphin-2609a-x64.7z',
    file: 'dolphin-2609a-x64.7z', version: '2609a', mb: 20,
    page: 'https://dolphin-emu.org/download/',
    note: 'Dolphin’s stable release 2609a, taken straight from the project’s download host rather than a mirror. The development builds move several times a day and have no fixed address. If Dolphin complains about a missing DLL, its downloads want the 64-bit Visual C++ redistributable.'
  },
  {
    id: 'cemu', name: 'Cemu', group: 'Nintendo',
    systems: ['wiiu'],
    blurb: 'Wii U emulation with upscaling and good controller support.',
    repo: 'cemu-project/Cemu', asset: /cemu-.*windows-x64\.zip$/i, mb: 25,
    page: 'https://cemu.info/'
  },
  {
    id: 'ryujinx', name: 'Ryujinx', group: 'Nintendo',
    systems: ['switch'],
    blurb: 'The accuracy-first Nintendo Switch emulator, carried on by the Ryubing community after the original project stopped.',
    // Published from the project's own forge rather than from GitHub, and that
    // is not pedantry: the original Ryujinx stopped in October 2024, the mirror
    // that carried its builds was taken down in 2026, and the repositories still
    // wearing the name on GitHub are download-farm pages with a zip attached.
    // The continuation ships its own builds, so that is where this points.
    // The stable channel rather than Canary: an install Apex does by itself
    // should be the one the project calls stable, and its page offers Canary to
    // anyone who wants the moving one.
    feed: 'forgejo', host: 'git.ryujinx.app', repo: 'Ryubing/Ryujinx',
    asset: /win_x64\.zip$/i, mb: 32,
    page: 'https://ryujinx.app/download',
    note: 'Apex installs the Ryubing fork\'s own Windows build from the project\'s release feed - the stable channel; Canary is on the same page. It arrives without keys: Switch titles need your own console\'s keys and firmware, which Ryujinx asks for the first time you open it.'
  },

  // --- Handheld ------------------------------------------------------------
  {
    id: 'mgba', name: 'mGBA', group: 'Handheld',
    systems: ['gb', 'gbc', 'gba'],
    blurb: 'The best modern Game Boy and Game Boy Advance emulator — accurate, fast and actively kept up.',
    repo: 'mgba-emu/mgba', asset: /win64\.7z$/i,
    page: 'https://mgba.io/downloads.html'
  },
  {
    id: 'melonds', name: 'melonDS', group: 'Handheld',
    systems: ['nds'],
    blurb: 'Aimed at being fast, accurate and dependable for Nintendo DS, with proper Wi-Fi support.',
    repo: 'melonDS-emu/melonDS', asset: /windows-x86_64\.zip$/i,
    page: 'https://melonds.kuribo64.net/downloads.php'
  },
  {
    id: 'desmume', name: 'DeSmuME', group: 'Handheld',
    systems: ['nds'],
    blurb: 'The long-standing Nintendo DS emulator — the other good choice for DS games.',
    repo: 'TASVideos/desmume', asset: /win64\.zip$/i,
    page: 'https://desmume.org/download/'
  },
  {
    id: 'azahar', name: 'Azahar', group: 'Handheld',
    systems: ['3ds'],
    blurb: 'The maintained continuation of the Citra codebase — Nintendo 3DS emulation that still gets releases.',
    repo: 'azahar-emu/azahar', asset: /azahar-windows-msvc-.*\.zip$/i, mb: 42,
    page: 'https://azahar-emu.org/'
  },
  {
    id: 'ppsspp', name: 'PPSSPP', group: 'Handheld',
    systems: ['psp'],
    blurb: 'Outstanding PlayStation Portable emulation — it runs smoothly on everything from a laptop upward.',
    repo: 'hrydgard/ppsspp', asset: /Windows-x64\.zip$/i,
    page: 'https://www.ppsspp.org/download/'
  },

  // --- Sony ----------------------------------------------------------------
  {
    id: 'duckstation', name: 'DuckStation', group: 'Sony',
    systems: ['ps1'],
    blurb: 'Extremely accurate PlayStation emulation with the best upscaling and enhancement options around.',
    repo: 'stenzek/duckstation', asset: /^duckstation-windows-x64-release\.zip$/i,
    page: 'https://www.duckstation.org/'
  },
  {
    id: 'pcsx2', name: 'PCSX2', group: 'Sony',
    systems: ['ps2'],
    blurb: 'The long-standing standard for PlayStation 2 — massive graphical enhancements and widescreen hacks.',
    repo: 'PCSX2/pcsx2', asset: /windows-x64-Qt\.7z$/i,
    page: 'https://pcsx2.net/downloads/'
  },
  {
    id: 'rpcs3', name: 'RPCS3', group: 'Sony',
    systems: ['ps3'],
    blurb: 'The PlayStation 3 emulator, with a new Windows build published continuously.',
    repo: 'RPCS3/rpcs3-binaries-win', asset: /win64_msvc\.7z$/i, mb: 38,
    page: 'https://rpcs3.net/download'
  },
  {
    id: 'shadps4', name: 'shadPS4', group: 'Sony',
    systems: ['ps4'],
    blurb: 'The PlayStation 4 emulator that has come the furthest — retail and homebrew titles, a growing compatibility list, and its own online-play layer.',
    // Version-tagged releases (`v.0.20.0`) rather than the several-a-day kind, and
    // the Windows asset is the entire program in a single file. The project keeps
    // its Qt interface in a separate repository, but that one only ever publishes
    // prereleases and wants the core beside it anyway - the core's own build is
    // the complete program, so that is the one Apex installs.
    repo: 'shadps4-emu/shadPS4', asset: /shadps4-win64.*\.zip$/i, mb: 30,
    page: 'https://shadps4.net/',
    note: 'Windows builds are one self-contained shadPS4.exe, so Apex records which build you have and offers you the newer one rather than pinning a version. It needs a Vulkan 1.3 GPU, and a PlayStation 4 firmware dump of your own in its sys_modules folder before titles will boot.'
  },
  {
    id: 'kyty', name: 'KytyPS5', group: 'Sony',
    systems: ['ps5', 'ps4'],
    blurb: 'The PlayStation 5 emulator that is genuinely moving — it boots 2D and 3D retail titles, including Unreal Engine and Unity games.',
    // Rolling, date-tagged releases (several a day), and the newest one is the
    // whole point. Every build ships the same three assets, so the Windows zip
    // is simply the one whose name ends that way.
    repo: 'KytyPS5/KytyPS5', asset: /Windows-x64\.zip$/i, mb: 27,
    page: 'https://github.com/KytyPS5/KytyPS5/releases',
    note: 'A heavily modified, actively developed fork of the original Kyty, rebuilt several times a day — so Apex records which build you have and offers you the newer one rather than pinning a version. It inherits a PS4 emulator\'s groundwork, but the project targets PS5. Needs a Vulkan 1.3 GPU and current drivers.'
  },

  // --- Sega ----------------------------------------------------------------
  {
    id: 'flycast', name: 'Flycast', group: 'Sega',
    systems: ['dreamcast'],
    blurb: 'Fast, accurate Dreamcast emulation — the strongest free option for Sega’s 3D generation.',
    repo: 'flyinghead/flycast', asset: /win64.*\.zip$/i, mb: 9,
    page: 'https://github.com/flyinghead/flycast/releases'
  },
  {
    id: 'blastem', name: 'BlastEm', group: 'Sega',
    systems: ['genesis'],
    blurb: 'Extremely accurate and fast Mega Drive emulation.',
    // The project's own site carries its Windows builds, so Apex fetches the one
    // it points at instead of sending the user there.
    url: 'https://www.retrodev.com/blastem/blastem-win64-1.0.0.zip',
    file: 'blastem-win64-1.0.0.zip', version: '1.0.0', mb: 3,
    page: 'https://www.retrodev.com/blastem/',
    note: 'BlastEm posts its Windows builds on the project’s own site, which is where this comes from. RetroArch also covers Mega Drive.'
  },
  {
    id: 'fusion', name: 'Kega Fusion', group: 'Sega',
    systems: ['genesis', 'mastersystem', 'gamegear'],
    blurb: 'The classic, famously compatible Mega Drive, Master System and Game Gear emulator.',
    // Freeware, not open source, and the author's own page is the only place that
    // carries it - so this is that page's download rather than a copy of it from
    // some third-party mirror. Kega Fusion is a finished program: 3.64 is the last
    // version there will be.
    url: 'https://www.carpeludum.com/download/Fusion364.zip',
    file: 'Fusion364.zip', version: '3.64', mb: 1,
    page: 'https://www.carpeludum.com/kega-fusion/',
    note: 'Freeware rather than open source: this is the author’s own 3.64 build, from the page he distributes it on. It runs as-is — no keys, no firmware — and 3.64 is the final version.'
  },

  // --- Atari ---------------------------------------------------------------
  {
    id: 'stella', name: 'Stella', group: 'Atari',
    systems: ['atari2600'],
    blurb: 'The reference Atari 2600 emulator — accurate enough for the homebrew scene to build on it.',
    repo: 'stella-emu/stella', asset: /windows\.zip$/i, mb: 4,
    page: 'https://stella-emu.github.io/downloads.html'
  },

  // --- Other ---------------------------------------------------------------
  {
    id: 'fceux', name: 'FCEUX', group: 'Other',
    systems: ['nes'],
    blurb: 'A long-lived NES emulator with unusually good debugging and tooling.',
    repo: 'TASVideos/fceux', asset: /win64\.zip$/i,
    page: 'https://fceux.com/web/download.html'
  },
  {
    id: 'xenia', name: 'Xenia Canary', group: 'Other',
    systems: ['xbox360'],
    blurb: 'Xbox 360 emulation. The Canary channel is the one that moves.',
    repo: 'xenia-canary/xenia-canary', asset: /xenia_canary_windows\.7z$/i, mb: 4,
    page: 'https://github.com/xenia-canary/xenia-canary'
  },
  {
    id: 'retroarch', name: 'RetroArch', group: 'Other',
    systems: ['nes', 'snes', 'n64', 'gb', 'gbc', 'gba', 'nds', 'vb', 'ws', 'ps1',
      'genesis', 'mastersystem', 'gamegear', 'saturn', 'atari2600', 'atari7800',
      'lynx', 'pce', 'arcade', 'neogeo'],
    blurb: 'One front-end for dozens of consoles. The universal fallback — anything without a dedicated emulator installed can still run here.',
    url: 'https://buildbot.libretro.com/nightly/windows/x86_64/RetroArch.7z',
    file: 'RetroArch.7z', version: 'nightly', mb: 231,
    page: 'https://www.retroarch.com/?page=platforms',
    note: 'RetroArch publishes a rolling nightly build rather than tagged releases, so this is the current one. It is a large download because it bundles every core.'
  }
];

const byId = new Map(CATALOG.map((e) => [e.id, e]));

// ---------------------------------------------------------------------------
// Resolving the current release
// ---------------------------------------------------------------------------

/**
 * Where an entry's release feed lives.
 *
 * GitHub is the default, because that is where almost everything on the shelf is
 * published. A project that runs its own forge gets its own API path instead,
 * and the reason to support that at all is Ryujinx: its community continuation
 * distributes from a self-hosted Forgejo rather than from GitHub, where the name
 * is now attached to download-farm repositories. Forgejo answers with the same
 * shape as GitHub - `tag_name`, `assets[].browser_download_url`, `assets[].size`
 * - so everything downstream of this is the same code either way.
 */
function feedEndpoint(entry) {
  const path = `/repos/${entry.repo}/releases/latest`;
  return entry.feed === 'forgejo'
    ? `https://${entry.host}/api/v1${path}`
    : `https://api.github.com${path}`;
}

/** Where an entry's feed lives, for messages a person will actually read. */
const feedHost = (entry) => (entry.feed === 'forgejo' ? entry.host : 'GitHub');

/**
 * How Apex identifies itself when it reads a release feed.
 *
 * Deliberately not the browser user-agent the download engine wears. Forges
 * sitting behind bot protection answer a spoofed browser with HTTP 403 - Codeberg
 * does, and git.ryujinx.app is Forgejo too - while an honest client name is let
 * through. GitHub's API asks clients to identify themselves for the same reason.
 * Downloads keep the browser agent, because file hosts expect one.
 */
const FEED_UA = 'Apex Launcher (+https://github.com/Kudsi-k7el/apex-launcher)';

/**
 * Reads a JSON body from the app's own HTTP layer.
 *
 * Short-tempered on purpose: this is a metadata call that either answers quickly
 * or is not going to, and a feed that hangs should not leave someone watching a
 * progress bar that will never move.
 */
async function readJson(url, where, timeoutMs = 15000) {
  let res;
  try {
    ({ res } = await http.open(url, {
      headers: { accept: 'application/json', 'user-agent': FEED_UA },
      timeoutMs
    }));
  } catch (err) {
    throw new Error(`${where} could not be reached (${(err && err.message) || 'no answer'})`);
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`${where} answered HTTP ${res.statusCode}`);
  }
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(`${where} sent something that was not JSON`);
  }
}

/**
 * The newest download for one entry, resolved now rather than stored, so a
 * catalogue entry keeps working as projects publish new versions.
 */
async function resolve(entry) {
  if (entry.url) {
    return { url: entry.url, name: entry.file || path.basename(entry.url), version: entry.version || '', size: 0 };
  }
  const where = feedHost(entry);
  let release;
  try {
    release = await readJson(feedEndpoint(entry), where);
  } catch (err) {
    // Named, because the interesting part of an unreachable feed is which host
    // is unreachable - and that host may simply not be reachable from here.
    throw new Error(`${entry.name}: ${(err && err.message) || `could not read ${where}`}`);
  }
  const asset = (release.assets || []).find((a) => entry.asset.test(a.name));
  if (!asset) {
    throw new Error(`${entry.name} has no Windows download in its latest release`);
  }
  return { url: asset.browser_download_url, name: asset.name, version: release.tag_name || '', size: asset.size || 0 };
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

const safeName = (n) => String(n).replace(/[^\w.\-]+/g, '_').slice(-120);

/**
 * Streams the file to disk, reporting real byte progress. `signal` lets the
 * user walk away from a 200 MB download instead of waiting it out.
 */
async function download(url, dest, { signal, onProgress } = {}) {
  const { res } = await http.open(url, { signal });
  const code = res.statusCode || 0;
  if (code !== 200) {
    res.resume();
    throw new Error(`The download failed (HTTP ${code})`);
  }

  const total = Number(res.headers['content-length']) || 0;
  let got = 0;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      got += chunk.length;
      if (typeof onProgress === 'function') onProgress(got, total);
      done(null, chunk);
    }
  });

  await pipeline(res, meter, fs.createWriteStream(dest));
  return { got, total };
}

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

/**
 * Most releases unpack into a single folder named after the build. Lifting its
 * contents up one level keeps every install shaped the same way, which is what
 * detection expects to find.
 */
async function liftSingleFolder(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = path.join(dir, entries[0].name);
  try {
    for (const name of await fsp.readdir(inner)) {
      await fsp.rename(path.join(inner, name), path.join(dir, name));
    }
    await fsp.rm(inner, { recursive: true, force: true });
  } catch { /* leaving it nested is harmless: the search below is recursive */ }
}

/** Programs that ship alongside an emulator but are never the emulator. */
const NOT_THE_EMULATOR = /unins|setup|install|vcredist|redist|\b7za?\.exe$|updater|crashpad|dxsetup|report/i;

async function collectExes(dir, depth, acc) {
  if (depth > 3) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await collectExes(full, depth + 1, acc); continue; }
    if (!/\.exe$/i.test(entry.name)) continue;
    let size = 0;
    try { size = (await fsp.stat(full)).size; } catch { /* leave it at zero */ }
    acc.push({ full, rel: path.relative(dir, full), size });
  }
}

/**
 * The binary to remember. A name the detection table already knows wins; if the
 * release renamed it, the largest program that is not obviously an installer.
 */
async function findExe(dir, id) {
  const known = ((emulators.EMULATORS[id] || {}).exe || []).map((n) => n.toLowerCase());
  const files = [];
  await collectExes(dir, 0, files);
  if (!files.length) return null;

  for (const name of known) {
    const hit = files.find((f) => path.basename(f.rel).toLowerCase() === name);
    if (hit) return hit.full;
  }

  const usable = files.filter((f) => !NOT_THE_EMULATOR.test(f.rel));
  const pool = (usable.length ? usable : files).sort((a, b) => b.size - a.size);
  return pool[0].full;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * Fetch, unpack and register one emulator.
 *
 * `ctx.signal` is honoured throughout: the download is torn down mid-stream,
 * extraction stops between entries, and either way the partial tree is removed
 * rather than left for detection to find. Returns `{ ok: false, manual: true }`
 * for an entry that only has a page to open.
 */
async function install(id, ctx = {}) {
  const entry = byId.get(id);
  if (!entry) throw new Error('That is not one of the emulators Apex knows about.');

  const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};
  const onLog = typeof ctx.onLog === 'function' ? ctx.onLog : () => {};

  if (!entry.repo && !entry.url) {
    return { ok: false, manual: true, page: entry.page, error: `${entry.name} is not published in a release feed — open its page to download it.` };
  }

  let release;
  try {
    release = await resolve(entry);
  } catch (err) {
    // A feed that cannot be read is not a dead end when the project also has a
    // page to open: hand that over instead of an error nobody can act on.
    // Ryujinx is the entry this exists for - its forge does not answer from
    // every network, and a download button that only produces a stack trace is
    // worse than one that sends the user somewhere useful.
    if (!entry.page) throw err;
    onLog('warn', `${entry.name}: ${(err && err.message) || 'the release feed could not be read'}`);
    return {
      ok: false,
      manual: true,
      page: entry.page,
      error: `${entry.name} could not be reached at ${feedHost(entry)} — opening its download page instead.`
    };
  }
  const root = emulators.emulatorRoot();
  const dest = path.join(root, id);
  const stash = path.join(root, '_downloads');
  await fsp.mkdir(stash, { recursive: true });
  const file = path.join(stash, safeName(release.name));

  const signal = ctx.signal || null;
  const cancelled = () => !!(signal && signal.aborted);
  const stopped = () => new Error('Download cancelled.');

  onLog('info', `${entry.name} ${release.version || ''}`.trim());

  // Only set once the existing copy has actually been cleared, so a download
  // that fails early cannot take a working install down with it.
  let replaced = false;

  try {
    await download(release.url, file, {
      signal,
      onProgress: (got, total) => onProgress({ phase: 'download', got, total })
    });
    if (cancelled()) throw stopped();

    // A re-download replaces the old copy outright, so nothing stale can be
    // left behind for detection to find.
    await fsp.rm(dest, { recursive: true, force: true });
    replaced = true;
    await fsp.mkdir(dest, { recursive: true });

    onLog('info', `Unpacking ${release.name}`);
    await archives.extract(file, dest, {
      onLog,
      cancelled,
      onProgress: (pct) => onProgress({ phase: 'extract', pct })
    });
    if (cancelled()) throw stopped();
  } catch (err) {
    // Cancelling has to mean cancelled: a half-unpacked tree left on disk would
    // be found by detection and reported as a working install.
    if (replaced) await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }

  await liftSingleFolder(dest);

  const exe = await findExe(dest, id);
  if (!exe) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${entry.name} unpacked, but no emulator program was found inside it.`);
  }

  emulators.writeManaged(id, exe);
  // Which build this is, kept so a later check can tell whether the project has
  // moved on (see checkUpdates below).
  emulators.writeVersion(id, release.version || '');
  // The cached answer still describes the build that was just replaced. Drop it
  // here, or the next check inside the cache window replays the same offer and
  // asks about an update that is already installed.
  updateCache = { at: 0, result: null };
  onLog('info', `${entry.name} ready at ${exe}`);
  return { ok: true, id, name: entry.name, exe, version: release.version || '' };
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
// Emulators are published far more often than the launcher is - KytyPS5 alone
// ships several builds a day - so a version pinned in this file would be wrong
// by tomorrow. What Apex records instead is the release tag it installed, and
// this compares that against the newest release now.
//
// Only emulators Apex installed itself are asked about, one request each, so the
// cost is proportional to what the user actually has - and nothing at all when
// they have none. Answers are held for a few minutes so moving around the page
// cannot burn GitHub's unauthenticated rate limit.
//
// An entry with a fixed download and no feed (Dolphin, BlastEm, Kega Fusion,
// RetroArch) is included too, and costs nothing: there is no request to make,
// its newest build is the one this file already names, so a newer launcher
// catalogue is what moves it on.

const UPDATE_TTL = 10 * 60 * 1000;
let updateCache = { at: 0, result: null };

/** The date out of a rolling tag such as `KytyPS5-2026-10-19-0cad467`. */
function tagDate(tag) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(tag || ''));
  return m ? m[1] : '';
}

/** The numbers in a tag, in order: `v.0.20.0` reads as [0, 20, 0]. */
function tagNumbers(tag) {
  return String(tag || '').split(/[^0-9]+/).filter(Boolean).map(Number);
}

/**
 * Compares two tags that are made of numbers - `v1.20.4`, `v.0.20.0`, `1.1.1403`.
 *
 * `null` means the numbers cannot separate them, which is the honest answer for
 * two different build hashes published the same day. A plain string comparison is
 * what this replaces, and it gets the ordinary case backwards: `0.10.0` sorts
 * before `0.9.0` as text, and it is the newer one.
 */
function compareTagNumbers(a, b) {
  const x = tagNumbers(a);
  const y = tagNumbers(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p !== q) return p < q;
  }
  return null;
}

/**
 * Whether the release GitHub calls newest is really newer than what is on disk.
 *
 * `null` means "cannot tell", which is the honest answer for an install with no
 * recorded version: it came from a build of Apex that did not record one, and
 * guessing here would nag the user about a release they already have. The caller
 * decides what that means - see checkUpdates.
 */
function isNewer(installed, latest) {
  if (!installed || !latest) return null;
  if (installed === latest) return false;
  // A date in the tag is the build's own ordering, so it settles the question
  // outright - including the occasional rebuild published out of order.
  const a = tagDate(installed);
  const b = tagDate(latest);
  if (a && b && a !== b) return b > a;
  // Same day, or no date to read: all that is left is the tag's last segment.
  const tail = (s) => String(s).split('-').pop() || '';
  const ta = tail(installed);
  const tb = tail(latest);
  if (ta && tb && ta !== tb) {
    const byNumber = compareTagNumbers(ta, tb);
    return byNumber === null ? tb > ta : byNumber;
  }
  return true;
}

/** Is the binary on disk one of the names this catalogue entry ships? */
function shipsBinary(entry, exe) {
  const names = (emulators.EMULATORS[entry.id] || {}).exe || [];
  const base = path.basename(String(exe || '')).toLowerCase();
  return names.some((n) => n.toLowerCase() === base);
}

/**
 * Which installed emulators have a newer build waiting, checked now.
 *
 * Returns `{ ok, checked, updates: [...] }`, each update carrying both the build
 * on disk and the one on offer, so the interface can say plainly what an update
 * would replace. A project whose release page cannot be reached is collected
 * into `error` rather than thrown: one unreachable API must not hide an update
 * for another emulator.
 */
/**
 * A cached answer with the offers that have since been installed taken out.
 *
 * The cache holds what the release pages said, not what is on disk, so it can
 * outlive an install by a few minutes. Filtering it against the recorded build
 * is what stops the shelf offering the version it is already running - which is
 * what a second prompt right after updating would be asking about.
 */
function pruneUpdates(result) {
  if (!result || !Array.isArray(result.updates) || !result.updates.length) return result;
  const versions = emulators.readVersions();
  const keep = result.updates.filter((u) => {
    const record = versions[u.id] || {};
    // Nothing on record: the check already decided this one needs an answer.
    if (!record.version) return true;
    return isNewer(record.version, u.latest) === true;
  });
  if (keep.length === result.updates.length) return result;
  const pruned = { ...result, updates: keep };
  updateCache = { at: updateCache.at, result: pruned };
  return pruned;
}

async function checkUpdates(force) {
  if (!force && updateCache.result && Date.now() - updateCache.at < UPDATE_TTL) {
    return pruneUpdates(updateCache.result);
  }

  const managed = emulators.readManaged();
  const versions = emulators.readVersions();
  const targets = CATALOG.filter((e) => (e.repo || e.url) && managed[e.id]);

  const updates = [];
  const errors = [];
  for (const entry of targets) {
    try {
      const release = await resolve(entry);
      const record = versions[entry.id] || {};
      const latest = release.version || '';
      let newer = record.version ? isNewer(record.version, latest) : null;

      // No version on record. If the file on disk is one of this entry's own
      // binaries the install is plausible as it stands, so the current tag is
      // adopted and the user is asked nothing. If it is some other program - an
      // older build from a different repository, which is exactly what the
      // original Kyty left behind - then it is a build Apex cannot place, and
      // the current release is offered as the way to put it right.
      if (newer === null) {
        if (shipsBinary(entry, managed[entry.id])) emulators.writeVersion(entry.id, latest);
        else newer = true;
      }

      if (!newer) continue;
      updates.push({
        id: entry.id,
        name: entry.name,
        version: record.version || '',
        latest,
        size: release.size || 0,
        url: release.url,
        page: entry.page,
        systems: (entry.systems || []).slice()
      });
    } catch (err) {
      errors.push(`${entry.name}: ${(err && err.message) || 'could not be reached'}`);
    }
  }

  const result = { ok: true, checked: targets.length, updates, error: errors.join(' \u00b7 ') };
  updateCache = { at: Date.now(), result };
  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The shelf itself. This is static metadata on purpose: whether each one is
 * installed is already known to the renderer from its detection pass, so the
 * page does not pay for a second disk scan to draw a button.
 */
function list() {
  const versions = emulators.readVersions();
  return CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    group: entry.group,
    systems: entry.systems.slice(),
    blurb: entry.blurb,
    page: entry.page,
    note: entry.note || '',
    auto: !!(entry.repo || entry.url),
    mb: entry.mb || 0,
    // The build Apex installed, when it installed one: a project that ships a
    // build a day should be able to say which one you have.
    version: (versions[entry.id] || {}).version || ''
  }));
}

module.exports = { list, install, resolve, checkUpdates, isNewer, shipsBinary, CATALOG, GROUPS, findExe, NOT_THE_EMULATOR, feedEndpoint };
