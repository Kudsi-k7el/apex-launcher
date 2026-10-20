'use strict';
// Throwaway: screenshots of the news images, artwork and controller work.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, ipcMain, BrowserWindow } = require('electron');

const userData = path.join(os.tmpdir(), `apex-shot-${Date.now()}`);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const out = path.join(os.tmpdir(), process.env.APEX_SHOTS_OUT || 'apex-shots6');
fs.mkdirSync(out, { recursive: true });

/*
 * Which theme the captures are taken in. The marketing set is Neon so the site
 * imagery matches its own palette; naming another theme here (APEX_SHOTS_THEME)
 * is how a new shell gets reviewed without disturbing that set.
 */
const SHOT_THEME = process.env.APEX_SHOTS_THEME || 'neon';

require(path.join(__dirname, 'main.js'));
const newsMod = require(path.join(__dirname, 'news'));
const itchMod = require(path.join(__dirname, 'net', 'itch'));
const emuMod = require(path.join(__dirname, 'emulators'));

/**
 * A make-believe emulator install and ROM folder, so the Emulators view and the
 * Big Picture Emulators shelf have something on them. The titles are all
 * freeware or homebrew on purpose - a marketing screenshot is not the place to
 * advertise a commercial ROM shelf.
 */
const EMU_FOUND = ['mesen', 'mgba', 'project64', 'blastem', 'retroarch'];
const EMU_EXE = (id) => `C:\\Emulators\\${id}\\${id}.exe`;
const emuDetected = () => {
  const emulators = EMU_FOUND.map((id) => ({
    id,
    name: emuMod.EMULATORS[id].name,
    exe: EMU_EXE(id),
    systems: emuMod.EMULATORS[id].systems.slice(),
    via: 'folder'
  }));
  // The same rule the main process uses: the first installed emulator on a
  // console's preference list wins it.
  const systems = {};
  for (const [key, sys] of Object.entries(emuMod.SYSTEMS)) {
    const pick = sys.via.find((id) => EMU_FOUND.includes(id));
    systems[key] = pick
      ? { emulator: pick, name: emuMod.EMULATORS[pick].name, exe: EMU_EXE(pick) }
      : null;
  }
  return { ok: true, emulators, systems };
};

const ROM_ROWS = [
  ['Alter Ego', 'nes', '.nes', 40960],
  ['Streemerz', 'nes', '.nes', 65536],
  ['Super Boss Gaiden', 'snes', '.sfc', 524288],
  ['Miniplanets', 'genesis', '.md', 1048576],
  ['uCity', 'gb', '.gb', 65536],
  ['Anguna', 'gba', '.gba', 4194304],
  ['Portal 64', 'n64', '.z64', 8388608]
];
const ROMS = ROM_ROWS.map(([title, system, ext, size]) => ({
  name: `${title}${ext}`,
  title,
  system,
  path: `C:\\ROMs\\${system}\\${title}${ext}`,
  dir: `C:\\ROMs\\${system}`,
  size
}));
const ROM_SHELVES = ROMS.reduce((acc, r) => {
  (acc[r.system] = acc[r.system] || []).push(r);
  return acc;
}, {});
const ROM_SCAN = {
  ok: true, roms: ROMS, bySystem: ROM_SHELVES, count: ROMS.length,
  capped: false, folders: ['C:\\ROMs'], skippedTracks: 0
};

/** Screenshots for the Gallery view and the Big Picture Gallery shelf. */
const SHOT_ROWS = [
  ['Celeste', 'shot-0001.png', '1920x1080', 1843200],
  ['Hollow Knight', 'shot-0002.png', '2560x1440', 3211264],
  ['Stardew Valley', 'shot-0003.png', '1920x1080', 1572864],
  ['Fall Guys', 'shot-0004.png', '1920x1080', 2097152],
  ['Minecraft for Windows', 'shot-0005.png', '2560x1440', 2883584],
  ['Cyberpunk 2077', 'shot-0006.png', '3440x1440', 4718592]
];
const shotArt = (label, hue) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">
     <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
       <stop offset="0" stop-color="hsl(${hue} 70% 42%)"/>
       <stop offset="1" stop-color="hsl(${(hue + 48) % 360} 72% 18%)"/>
     </linearGradient></defs>
     <rect width="480" height="270" fill="url(#g)"/>
     <circle cx="368" cy="90" r="54" fill="rgba(255,255,255,.22)"/>
     <path d="M0 214 L118 150 L228 208 L332 158 L480 224 L480 270 L0 270 Z" fill="rgba(0,0,0,.34)"/>
     <text x="26" y="252" font-family="Segoe UI, sans-serif" font-size="24" font-weight="700"
       fill="rgba(255,255,255,.92)">${label}</text>
   </svg>`);
const SHOTS = SHOT_ROWS.map(([game, name, dims, bytes], i) => {
  const [w, h] = dims.split('x').map(Number);
  return { name, thumb: name, game, at: Date.now() - i * 86400000, width: w, height: h, bytes };
});

/** A stand-in for the PNG `app.getFileIcon` returns, for the import screenshot. */
const svgIco = (color) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="${color}"/><circle cx="32" cy="32" r="14" fill="rgba(0,0,0,.28)"/></svg>`);

const STUBS = {
  'store:search': () => ({ ok: true, items: [
    { appId: '1091500', name: 'Cyberpunk 2077', priceLabel: '$29.99', listPrice: '$59.99', discountPct: 50, metascore: 86,
      url: 'https://store.steampowered.com/app/1091500/',
      art: { wide: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/header.jpg' },
      tinyImage: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/header.jpg' }
  ] }),
  'store:details': () => ({ ok: false }),
  // Real headlines (with their covers) so the news views have images to show.
  'news:list': async () => { try { return await newsMod.list({ force: true }); } catch { return { ok: true, items: [], categories: [] }; } },
  'games:detect': () => ({ roots: {}, matched: {}, local: {}, owned: {}, reports: {} }),
  'games:verify': () => ({}), 'game:launch': () => ({}), 'game:stop': () => ({}),
  'game:running': () => [], 'install:start': () => ({}), 'steam:progress': () => ({ ok: true, apps: {} }),
  'steam:running': () => false, 'drives:list': () => [], 'drives:space': () => null,
  'folder:scanGames': () => ({ ok: true, root: 'C:\\Games\\Imports', games: [
    { name: 'Celeste', exe: 'C:\\Games\\Imports\\Celeste\\Celeste.exe', dir: 'C:\\Games\\Imports\\Celeste', size: 1258291200,
      icon: svgIco('#f2b8c6') },
    { name: 'Hollow Knight', exe: 'C:\\Games\\Imports\\HollowKnight\\hollow_knight.exe', dir: 'C:\\Games\\Imports\\HollowKnight', size: 2516582400,
      icon: svgIco('#7fd1e0') },
    { name: 'Stardew Valley', exe: 'C:\\Games\\Imports\\Stardew\\Stardew Valley.exe', dir: 'C:\\Games\\Imports\\Stardew', size: 838860800,
      icon: svgIco('#9be08b') },
    { name: 'Utility Tool', exe: 'C:\\Games\\Imports\\tools\\helper.exe', dir: 'C:\\Games\\Imports\\tools', size: 204800 }
  ] }),
  'dialog:folder': () => 'C:\\Games\\Imports',
  'shell:openExternal': () => true, 'shell:openPath': () => true,
  // --- emulators & ROM shelving ---------------------------------------------
  'emu:detect': () => emuDetected(),
  'emu:scan': () => ROM_SCAN,
  'emu:launch': (_e, system, romPath) => ({
    ok: true, emulator: 'RetroArch', exe: 'C:\\Emulators\\retroarch\\retroarch.exe',
    system, title: (romPath || '').replace(/^.*\\/, '').replace(/\.[^.]+$/, '')
  }),
  // --- screenshots ----------------------------------------------------------
  'shots:list': () => ({ shots: SHOTS.map((s) => ({
    ...s, path: `C:\\Shots\\${s.name}`, thumb: `C:\\Shots\\thumbs\\${s.name}`
  })), bytes: SHOTS.reduce((n, s) => n + s.bytes, 0) }),
  'shots:capture': () => null,
  'shots:open': () => true,
  'shots:remove': () => ({ ok: true }),
  'file:dataUrl': (_e, p) => {
    const name = String(p || '').replace(/^.*\\/, '');
    const i = Math.max(0, SHOTS.findIndex((s) => s.name === name));
    const s = SHOTS[i] || SHOTS[0];
    return shotArt(s.game || 'Screenshot', 200 + i * 32);
  },
  // --- the Bypass / OnlineFix catalogues ------------------------------------
  'pl:bypass': () => ({ ok: true, publishers: ['Rockstar Games', 'Ubisoft', 'EA'], total: 6, items: [
    { kind: 'bypass', appId: '271590', publisher: 'Rockstar Games', name: 'Grand Theft Auto V',
      fixName: 'GTA V - bypass', comments: 'Needs the online bypass.', required: ['Steam', 'WinRAR'],
      errors: ['Cannot connect to Rockstar services.', 'Rockstar launcher loops on startup.'],
      launchSteam: true, launchExe: false, exclusion: false, image: '' },
    { kind: 'bypass', appId: '1174180', publisher: 'Rockstar Games', name: 'Red Dead Redemption 2',
      fixName: 'RDR2 - bypass', comments: '', required: ['Steam'], errors: [],
      launchSteam: true, launchExe: false, exclusion: false, image: '' },
    { kind: 'bypass', appId: '2208920', publisher: 'Ubisoft', name: 'Assassin\u2019s Creed Mirage',
      fixName: 'Mirage - bypass', comments: '', required: ['Ubisoft Connect'], errors: ['Ubisoft Connect must be closed first.'],
      launchSteam: true, launchExe: false, exclusion: false, image: '' },
    { kind: 'bypass', appId: '1517290', publisher: 'EA', name: 'Battlefield 2042',
      fixName: 'BF2042 - bypass', comments: '', required: ['EA App'], errors: [],
      launchSteam: false, launchExe: true, exclusion: false, image: '' },
    { kind: 'bypass', appId: '582160', publisher: 'Ubisoft', name: 'Assassin\u2019s Creed Origins',
      fixName: 'Origins - bypass', comments: '', required: [], errors: [],
      launchSteam: true, launchExe: false, exclusion: false, image: '' },
    { kind: 'bypass', appId: '1237970', publisher: 'EA', name: 'Titanfall 2',
      fixName: 'Titanfall 2 - bypass', comments: '', required: [], errors: [],
      launchSteam: true, launchExe: false, exclusion: false, image: '' }
  ] }),
  'pl:onlinefix': () => ({ ok: true, total: 4, items: [
    { kind: 'onlinefix', appId: '1091500', name: 'Cyberpunk 2077', fixName: 'Cyberpunk - fix', image: '' },
    { kind: 'onlinefix', appId: '1245620', name: 'ELDEN RING', fixName: 'Elden Ring - fix', image: '' },
    { kind: 'onlinefix', appId: '1174180', name: 'Red Dead Redemption 2', fixName: 'RDR2 - fix', image: '' },
    { kind: 'onlinefix', appId: '292030', name: 'The Witcher 3: Wild Hunt', fixName: 'Witcher 3 - fix', image: '' }
  ] }),
  // --- itch.io: the real public feeds, so the shots show genuine titles -------
  'itch:feeds': () => itchMod.feeds(),
  // itch.io throttles bursty clients with a 429 every so often. A marketing
  // screenshot must never capture that error state, so retry before giving up.
  'itch:browse': async (_e, feed, page) => {
    let last = { ok: false, error: 'no attempt', items: [] };
    for (let i = 0; i < 4; i++) {
      try {
        const r = await itchMod.browse(feed, page);
        if (r && r.items && r.items.length) return r;
        last = r || last;
      } catch (err) { last = { ok: false, error: err.message, items: [] }; }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return last;
  },
  'itch:search': async (_e, q) => {
    try { return await itchMod.search(q); } catch (err) { return { ok: false, error: err.message, items: [] }; }
  },
  'itch:detail': async (_e, url) => {
    try { return await itchMod.detail(url); } catch (err) { return { ok: false, error: err.message }; }
  },
  'itch:connect': () => ({ ok: true, username: 'apex-tester' }),
  'itch:uploads': () => ({
    ok: true,
    uploads: [
      { id: 9001, filename: 'my-game-windows.zip', size: 148897792, platform: 'windows', demo: false, preorder: false },
      { id: 9002, filename: 'my-game-mac.zip', size: 151519232, platform: 'osx', demo: false, preorder: false },
      { id: 9003, filename: 'my-game-linux.tar.gz', size: 142606336, platform: 'linux', demo: true, preorder: false }
    ]
  })
};

app.whenReady().then(() => {
  for (const [c, f] of Object.entries(STUBS)) { try { ipcMain.removeHandler(c); } catch {} ipcMain.handle(c, f); }
  setTimeout(run, 1500);
});

async function shoot(win, name) {
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  await new Promise((r) => setTimeout(r, 260));
  const img = await win.capturePage();
  fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  console.log('shot', name);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const win = BrowserWindow.getAllWindows()[0];
  const [shotW, shotH] = (process.env.APEX_SHOTS_SIZE || '1440x900').split('x').map(Number);
  win.setSize(shotW, shotH);
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);

  // Hard watchdog: a flaky CDN must never leave the harness hanging forever.
  setTimeout(() => { console.log('WATCHDOG exit'); setTimeout(() => app.exit(0), 60); }, 900000);

  for (let i = 0; i < 40; i++) {
    if (await js('return typeof BP !== "undefined" && !!document.querySelector("#content").children.length;')) break;
    await wait(200);
  }

  // Ignore live hardware so the capture sequence is deterministic (a real pad is
  // connected on this machine, and a stray press would re-enter Big Picture).
  await js(`
    if (!window.__gpReal) {
      window.__gpReal = { on: gpConnected, off: gpDisconnected };
      gpConnected = (pad) => { if (window.__allowPad) window.__gpReal.on(pad); };
      gpDisconnected = (i) => { if (window.__allowPad) window.__gpReal.off(i); };
    }
    // The "What's new" sheet opens by itself the first time a build runs, which
    // would cover every capture below. Marketing shots are not the place for it.
    maybeShowChangelog = async () => false;
    try { closeModal(); } catch (e) { /* nothing open */ }
    GP.pads.clear();
    GP.enabled = () => false;
    refreshPadHints();
    return true;`);

  // A shelf of real catalogue titles plus the two imported games the user asked
  // about, so the fallback artwork is visible either side of the new art.
  await js(`
    const cat = allGames().filter((g) => g.steamAppId).slice(0, 5);
    State.installed = {}; State.owned = {}; State.custom = [];
    cat.forEach((g) => { State.installed[g.id] = true; State.owned[g.id] = true; });
    const imports = [
      { id: 'custom:fall-guys', title: 'Fall Guys', developer: 'Epic Games', genre: 'Imported', custom: true },
      { id: 'custom:minecraft-windows', title: 'Minecraft for Windows', developer: 'Xbox', genre: 'Imported', custom: true }
    ];
    imports.forEach((g) => { State.custom.push(g); State.installed[g.id] = true; State.owned[g.id] = true; });
    if (typeof UPCOMING !== 'undefined' && UPCOMING[0]) {
      State.preorders[UPCOMING[0].id] = { at: Date.now(), releaseDate: UPCOMING[0].releaseDate || '2026-11-19', url: 'https://example.com' };
    }
    const tes = UPCOMING.find((g) => /Elder Scrolls VI/i.test(g.title));
    if (tes) State.preorders[tes.id] = { at: Date.now(), releaseDate: '2027-01-01', url: 'https://example.com' };
    const first = Object.keys(State.installed)[0];
    if (first) DL[first] = { id: first, kind: 'install', pct: 46, paused: false, speed: 18.4, started: Date.now() };
    // A named profile and a signed-in account, so the Profile page and the
    // account panel show a person rather than an empty placeholder.
    State.profile = {
      ...(State.profile || {}),
      name: 'kudasai',
      bio: 'Building Apex in the open - mostly here for the emulators.'
    };
    State.stats = { ...(State.stats || {}), playtime: {}, launches: 128, screenshots: 6 };
    Object.keys(State.installed).forEach((id, i) => {
      if (State.installed[id]) State.stats.playtime[id] = (i + 2) * 5400000;
    });
    State.settings.api = {
      ...(State.settings.api || {}),
      // A documentation address, not a real inbox: these captures end up as
      // marketing images on a public page.
      signedIn: true, email: 'kudasai@example.com', name: 'kudasai'
    };
    // Keep every Big Picture shot windowed so the whole set shares one size.
    State.settings.bigPictureFullscreen = false;
    // Marketing shots all use the Neon Accent theme, so the site imagery
    // matches its own neon palette instead of the default blue.
    State.settings.theme = '${SHOT_THEME}';
    State.settings.accent = THEMES['${SHOT_THEME}'].accent;
    applySettings();
    return true;
  `);
  await wait(3200);   // let the CDN art and news covers arrive

  // Narrow runs: APEX_SHOTS_ONLY=tools captures just the Tools view, which is
  // what a change to the catalogue needs reviewed. Everything else is skipped.
  if (process.env.APEX_SHOTS_ONLY === 'tools') {
    await js(`
      closeNewsBoot();
      gotoView('tools');
      await new Promise((r) => setTimeout(r, 900));
      document.querySelector('#content [data-fx-tab="bypass"]').click();
      await new Promise((r) => setTimeout(r, 1400));
      document.getElementById('content').scrollTop = 0;
      return true;`);
    await wait(2200);
    await shoot(win, '30a-bypass');
    app.exit(0);
    return;
  }

  // 0. the startup panel, then close it so the rest of the set is the shell
  await js(`
    if (!document.querySelector('#news-boot')) await openNewsBoot();
    await new Promise((r) => setTimeout(r, 400));
    return true;`);
  await wait(600);
  await shoot(win, '00-last-news');
  await js('closeNewsBoot(); await new Promise((r) => setTimeout(r, 320)); return true;');
  await wait(400);

  // 1. Big Picture, news (article covers as tiles + hero backdrop)
  await js('BP.tab = "news"; BP.enter(); return true;');
  await wait(1800);
  await shoot(win, '01-bigpicture-news');

  // 2. Big Picture, library (Fall Guys / Minecraft tiles)
  await js('BP.setTab("library"); return true;');
  await wait(1500);
  await shoot(win, '02-bigpicture-library');

  // 3. Home
  await js('BP.exit(); gotoView("home"); return true;');
  await wait(1600);
  await shoot(win, '03-home');

  // 4. Store: upcoming & pre-orders (GTA VI + TES VI)
  await js('gotoView("store"); return true;');
  await wait(2400);
  await shoot(win, '04-store-upcoming');

  // 5. Library with the imported games
  await js('gotoView("library"); return true;');
  await wait(1800);
  await shoot(win, '05-library');

  // 6. Settings: the controller panel with a live pad attached
  await js(`
    gotoView('settings');
    await new Promise((r) => setTimeout(r, 200));
    GP.pads.clear();
    window.__allowPad = true;
    clearTimeout(gpTimer);
    gpConnected({ index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
      mapping: 'standard',
      buttons: [{ pressed: true, value: 1 }], axes: [0.42, -0.18, 0, 0] });
    window.__allowPad = false;
    return true;`);
  await wait(1000);
  await js(`
    const p = [...document.querySelectorAll('.panel')].find((x) => /Controller & Sound/.test(x.textContent));
    if (p) p.scrollIntoView({ block: 'start' });
    return !!p;`);
  await wait(600);
  await shoot(win, '06-settings-controller');

  // 7. Big Picture, store
  await js('BP.tab = "store"; BP.enter(); return true;');
  await wait(1600);
  await shoot(win, '07-bigpicture-store');

  // 8. Store: the enriched catalogue rows, all with platform badges
  await js(`
    BP.exit();
    gotoView('store');
    await new Promise((r) => setTimeout(r, 300));
    const tabs = document.querySelectorAll('#content .store-section');
    for (const t of tabs) {
      if (/Indie Gems/.test(t.textContent)) { t.scrollIntoView({ block: 'start' }); break; }
    }
    return true;`);
  await wait(2600);
  await shoot(win, '08-store-indie-row');

  // 9. itch.io browse (real public feeds)
  await js('gotoView("itch"); return true;');
  await wait(4200);
  await shoot(win, '09-itch-browse');

  // 10. the Store tab of the app with the new nav entry
  await js('gotoView("store"); return true;');
  await wait(1200);
  await shoot(win, '10-store-top');

  // 11. an itch.io title dialog with the account connected
  await js(`
    State.settings.itch = { apiKey: 'demo-key', username: 'apex-tester' };
    gotoView('itch');
    await new Promise((r) => setTimeout(r, 1200));
    if (!itchItems.length) return false;
    itchOpenDialog(itchItems[0]);
    await new Promise((r) => setTimeout(r, 2600));
    return true;`);
  await wait(1200);
  await shoot(win, '11-itch-dialog');

  // 12. the same dialog without a key: the connect prompt
  await js(`
    closeModal();
    State.settings.itch = { apiKey: '', username: '' };
    if (!itchItems.length) return false;
    itchOpenDialog(itchItems[2] || itchItems[0]);
    await new Promise((r) => setTimeout(r, 2600));
    return true;`);
  await wait(900);
  await shoot(win, '12-itch-needs-key');

  // 13. the itch.io settings panel
  await js(`
    closeModal();
    gotoView('settings');
    await new Promise((r) => setTimeout(r, 250));
    const p = [...document.querySelectorAll('.panel')].find((x) => /itch\\.io/.test(x.textContent));
    if (p) p.scrollIntoView({ block: 'start' });
    return !!p;`);
  await wait(900);
  await shoot(win, '13-settings-itch');

  // 14. full-page Store shot, for the catalogue as a whole
  await js(`
    State.settings.itch = { apiKey: '', username: '' };
    gotoView('store');
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(2600);
  await shoot(win, '14-store-hero');

  // 15. the Library, with the pre-ordered row and an itch.io install
  await js(`
    State.custom = State.custom || [];
    State.custom.push({
      id: 'itch:example/indie-demo', title: 'Example Indie', developer: 'Example Studio',
      release: 2025, genre: 'Platformer', tags: ['itch.io','Platformer'], size: 0.34,
      price: 'Free', rating: 0, blurb: 'Installed from itch.io.',
      colors: null, cover: null, hero: null, wide: null,
      platform: 'itch', itch: { url: 'https://example.itch.io/indie-demo', gameId: 42 }, custom: true
    });
    State.installed['itch:example/indie-demo'] = true;
    State.owned['itch:example/indie-demo'] = true;
    gotoView('library');
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(2600);
  await shoot(win, '15-library');

  // 16. the Profile page: stats, achievements, account panel
  await js(`
    gotoView('profile');
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(1200);
  await shoot(win, '16-profile');

  // 17. account panel scrolled into view
  await js(`
    const p = document.querySelector('#content #account-body');
    if (p) p.scrollIntoView({ block: 'start' });
    return true;`);
  await wait(600);
  await shoot(win, '17-profile-account');

  // 18. unified search across the Steam catalogue and itch.io
  await js(`
    gotoView('store');
    const input = document.getElementById('global-search');
    input.value = 'celeste';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(3400);
  await shoot(win, '18-search-unified');

  // 19. Big Picture: the Store section searching the live Steam storefront
  await js(`
    State.settings.bigPictureFullscreen = false;
    BP.tab = 'store'; BP.enter();
    await new Promise((r) => setTimeout(r, 400));
    const input = document.getElementById('bp-search-input');
    input.value = 'cyber';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    return true;`);
  await wait(2800);
  await shoot(win, '19-bigpicture-search-steam');

  // 20. Big Picture: the itch.io section searching itch.io
  await js(`
    BP.setTab('itch');
    await new Promise((r) => setTimeout(r, 300));
    const input = document.getElementById('bp-search-input');
    input.value = 'the';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1400));
    return true;`);
  await wait(3400);
  await shoot(win, '20-bigpicture-search-itch');

  // 21. the quick-launch dock on the home view
  await js(`
    closeModal();
    BP.exit();
    State.favorites = {};
    allGames().filter((g) => isInstalled(g.id)).slice(0, 6).forEach((g) => { State.favorites[g.id] = true; });
    const steam = allGames().find((g) => g.steamAppId && !isInstalled(g.id));
    if (steam) State.favorites[steam.id] = true;
    gotoView('store');
    await new Promise((r) => setTimeout(r, 500));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(2600);
  await shoot(win, '21-dock-favourites');

  // 22. the Discord Rich Presence settings panel
  await js(`
    gotoView('settings');
    await new Promise((r) => setTimeout(r, 350));
    const p = [...document.querySelectorAll('.panel')].find((x) => /Discord Rich Presence/.test(x.textContent));
    if (p) p.scrollIntoView({ block: 'start' });
    return !!p;`);
  await wait(900);
  await shoot(win, '22-settings-discord');

  // 23. importing a folder: the scanner's icons in the preview list
  await js(`
    gotoView('library');
    await new Promise((r) => setTimeout(r, 250));
    await importFolder();
    await new Promise((r) => setTimeout(r, 500));
    return true;`);
  await wait(900);
  await shoot(win, '23-import-icons');

  // -------------------------------------------------------------------------
  // The 2.8.0 sections: emulators, screenshots, the fix catalogue, and the two
  // Big Picture pages that are not shelves at all.
  // -------------------------------------------------------------------------

  // 24. Big Picture: the Emulators shelf, built from the (stubbed) ROM scan
  await js(`
    closeModal();
    State.emulators = { folders: ['C:\\\\ROMs'], exes: {} };
    emu.loaded = false;
    emuLoadState();
    State.settings.bigPictureFullscreen = false;
    BP.tab = 'emulators';
    BP.enter();
    BP.setTab('library');
    BP.setTab('emulators');
    await new Promise((r) => setTimeout(r, 1400));
    return document.querySelectorAll('#bp-shelf .bp-tile').length;`);
  await wait(1400);
  await shoot(win, '24-bigpicture-emulators');

  // 25. the Emulators view itself: consoles, ROM shelves, the free sources
  await js(`
    BP.exit();
    gotoView('emulators');
    await new Promise((r) => setTimeout(r, 1400));
    document.getElementById('content').scrollTop = 0;
    return document.querySelectorAll('#emu-grid-host .eshelf').length;`);
  await wait(1800);
  await shoot(win, '25-emulators');

  // 25b. an update that was answered with "Later": the card keeps both choices,
  // so the emulator is still playable and the newer build is one click away.
  await js(`
    emu.updates.retroarch = {
      id: 'retroarch', name: 'RetroArch', version: 'v1.19.0', latest: 'v1.20.0',
      size: 242221056, page: 'https://www.retroarch.com/?page=platforms',
      systems: ['nes', 'snes']
    };
    emu.skipped.retroarch = 'v1.20.0';
    emuSaveState();
    emuPaintNav();
    emuPaintAll(document.getElementById('content'));
    const card = document.querySelector('#emu-grid-host .emuget[data-emucard="retroarch"]');
    if (card) card.scrollIntoView({ block: 'center' });
    return !!card;`);
  await wait(900);
  await shoot(win, '25b-emulators-update-later');
  await js(`
    delete emu.updates.retroarch;
    delete emu.skipped.retroarch;
    emuSaveState();
    emuPaintNav();
    document.getElementById('content').scrollTop = 0;
    return true;`);

  // 26. the console table further down the same page
  await js(`
    const s = document.querySelector('#emu-grid-host .esources');
    if (s) s.scrollIntoView({ block: 'center' });
    return !!s;`);
  await wait(900);
  await shoot(win, '26-emulators-sources');

  // 27. Big Picture: the Gallery shelf
  await js(`
    State.settings.bigPictureFullscreen = false;
    BP.tab = 'library';
    BP.enter();
    BP.setTab('gallery');
    await new Promise((r) => setTimeout(r, 1200));
    return document.querySelectorAll('#bp-shelf .bp-tile').length;`);
  await wait(1400);
  await shoot(win, '27-bigpicture-gallery');

  // 28. the Gallery view with real (stubbed) captures
  await js(`
    BP.exit();
    gotoView('gallery');
    await new Promise((r) => setTimeout(r, 1600));
    document.getElementById('content').scrollTop = 0;
    return document.querySelectorAll('#content .gl-shot').length;`);
  await wait(1800);
  await shoot(win, '28-gallery');

  // 29. Big Picture: the Tools shelf
  await js(`
    State.settings.bigPictureFullscreen = false;
    BP.tab = 'library';
    BP.enter();
    BP.setTab('tools');
    await new Promise((r) => setTimeout(r, 1400));
    return document.querySelectorAll('#bp-shelf .bp-tile').length;`);
  await wait(1400);
  await shoot(win, '29-bigpicture-tools');

  // 30. Apex Tools: the dashboard
  await js(`
    BP.exit();
    gotoView('tools');
    await new Promise((r) => setTimeout(r, 1600));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(1800);
  await shoot(win, '30-apex-tools');

  // 30a. the Bypass catalogue behind its tab
  await js(`
    document.querySelector('#content [data-fx-tab="bypass"]').click();
    await new Promise((r) => setTimeout(r, 900));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(1200);
  await shoot(win, '30a-bypass');

  // 30b. Settings, Appearance: the theme grid and the 2.8.0 / 2.9.0 interface
  await js(`
    gotoView('settings');
    await new Promise((r) => setTimeout(r, 700));
    document.getElementById('content').scrollTop = 0;
    return document.querySelectorAll('#content [data-ui-pick]').length;`);
  await wait(900);
  await shoot(win, '30b-settings-interface');

  // 30c. the same window wearing the 2.8.0 shell, to show the switch moves the
  // nav back to the left rail instead of only changing a preview card.
  await js(`
    document.querySelector('#content [data-ui-pick="2.8"]').click();
    await new Promise((r) => setTimeout(r, 400));
    gotoView('store');
    await new Promise((r) => setTimeout(r, 900));
    return document.documentElement.dataset.ui;`);
  await wait(900);
  await shoot(win, '30c-ui-28');
  await js(`
    gotoView('settings');
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('#content [data-ui-pick="2.9"]').click();
    await new Promise((r) => setTimeout(r, 300));
    return document.documentElement.dataset.ui;`);

  // 31. Big Picture: the Profile page (no shelf at all)
  await js(`
    State.settings.bigPictureFullscreen = false;
    BP.tab = 'library';
    BP.enter();
    BP.setTab('profile');
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelectorAll('#bp-hero .bp-istat').length;`);
  await wait(1000);
  await shoot(win, '31-bigpicture-profile');

  // 32. Big Picture: the Contact page
  await js(`
    BP.setTab('contact');
    await new Promise((r) => setTimeout(r, 700));
    return document.querySelectorAll('#bp-hero .bp-channel').length;`);
  await wait(900);
  await shoot(win, '32-bigpicture-contact');

  // 33. the Contact page in the normal window
  await js(`
    BP.exit();
    gotoView('contact');
    await new Promise((r) => setTimeout(r, 900));
    document.getElementById('content').scrollTop = 0;
    return true;`);
  await wait(1000);
  await shoot(win, '33-contact');

  console.log(`\nshots in ${out}`);
  console.log('EXIT 0');
  setTimeout(() => app.exit(0), 60);
}
