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

require(path.join(__dirname, 'main.js'));
const newsMod = require(path.join(__dirname, 'news'));
const itchMod = require(path.join(__dirname, 'net', 'itch'));

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
  setTimeout(() => { console.log('WATCHDOG exit'); setTimeout(() => app.exit(0), 60); }, 300000);

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
    // Keep every Big Picture shot windowed so the whole set shares one size.
    State.settings.bigPictureFullscreen = false;
    // Marketing shots all use the Neon Accent theme, so the site imagery
    // matches its own neon palette instead of the default blue.
    State.settings.theme = 'neon';
    State.settings.accent = THEMES.neon.accent;
    applySettings();
    return true;
  `);
  await wait(3200);   // let the CDN art and news covers arrive

  // 1. Big Picture, news (article covers as tiles + hero backdrop)
  await js('BP.tab = "news"; BP.enter(); return true;');
  await wait(1800);
  await shoot(win, '01-bigpicture-news');

  // 2. Big Picture, library (Fall Guys / Minecraft tiles)
  await js('BP.setTab("library"); return true;');
  await wait(1500);
  await shoot(win, '02-bigpicture-library');

  // 3. the normal news view
  await js('BP.exit(); gotoView("news"); return true;');
  await wait(1600);
  await shoot(win, '03-news');

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

  console.log(`\nshots in ${out}`);
  console.log('EXIT 0');
  setTimeout(() => app.exit(0), 60);
}
