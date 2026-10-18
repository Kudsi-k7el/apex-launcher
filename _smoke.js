'use strict';
/*
 * Throwaway smoke test for the v2.6.0 itch.io / catalogue / card-layout work.
 *
 * Boots the real main process against a throwaway userData directory, stubs
 * every IPC channel that would touch the network or the disk, then drives the
 * actual renderer and asserts on the DOM.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, ipcMain, BrowserWindow } = require('electron');

const userData = path.join(os.tmpdir(), `apex-smoke-${Date.now()}`);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const done = (code) => {
  console.log(`\nEXIT ${code}`);
  setTimeout(() => app.exit(code), 40);
};

require(path.join(__dirname, 'main.js'));
const newsMod = require(path.join(__dirname, 'news'));

// --- stub the channels that reach outside the machine -----------------------
/**
 * Payloads the renderer hands to the main process for the writes we do not want
 * to actually perform. The stubs append here and the assertions read them back,
 * which beats poking at the frozen `window.api` bridge from the renderer.
 */
const CALLS = { dlStart: [], applyFix: [], steamlessReplace: [] };

const STUBS = {
  'art:resolve': () => ({ ok: false }),
  'store:search': () => ({ ok: true, items: [LIVE_STEAM] }),
  'store:details': () => ({ ok: false }),
  'news:list': () => ({ ok: true, items: [] }),
  'games:detect': () => ({ roots: {}, count: 0, matched: {}, local: {}, owned: {}, reports: {} }),
  'games:verify': () => ({}),
  'game:launch': () => ({ ok: true }),
  'game:stop': () => ({ ok: true }),
  'game:running': () => [],
  'install:start': () => ({ ok: false, error: 'stubbed' }),
  'steam:addLibrary': () => ({ ok: false }),
  'steam:seedManifest': () => ({ ok: false }),
  'steam:progress': () => ({ ok: true, apps: {} }),
  'steam:running': () => false,
  'drives:list': () => [],
  'drives:space': () => null,
  'folder:scanGames': () => ({ games: [] }),
  'app:info': () => ({ name: 'Apex', version: '2.6.0', paths: {} }),
  'shell:openExternal': () => true,
  'shell:openPath': () => true,
  // --- itch.io: the browse surface is driven by these -------------------------
  'itch:feeds': () => ([
    { id: 'free', label: 'Free games', ico: 'gift' },
    { id: 'popular', label: 'New & popular', ico: 'sparkles' }
  ]),
  'itch:browse': () => ({ ok: true, feed: 'free', page: 1, items: [ITCH_ITEM] }),
  'itch:search': () => ({ ok: true, query: 'x', items: [ITCH_ITEM] }),
  'itch:detail': () => ({ ok: true, ...ITCH_DETAIL }),
  'itch:connect': () => ({ ok: true, username: 'tester' }),
  'itch:uploads': () => ({ ok: true, uploads: [{ id: 'u1', filename: 'game-win.zip', size: 52428800, platform: 'windows', demo: false, preorder: false }] }),
  'dl:start': (_e, target) => { CALLS.dlStart.push(target); return { ok: false, error: 'stubbed' }; },
  // --- Project Lightning: the Nexus catalogue and the Tools catalogues -------
  'lightning:search': () => ({ ok: true, items: [LT_ITEM] }),
  'lightning:details': () => ({ ok: true, ...LT_DETAIL }),
  'pl:status': () => ({ ok: true, bypass: 1, onlinefix: 1, fixSource: '', steamlessSource: '' }),
  'pl:catalogs': () => ({
    ok: true,
    bypass: { total: 1, publishers: ['Rockstar'], source: 'bundled' },
    onlinefix: { total: 1, source: 'bundled' }
  }),
  'pl:bypass': () => ({ ok: true, items: [PL_BYPASS_ITEM], publishers: ['Rockstar'], total: 1 }),
  'pl:onlinefix': () => ({ ok: true, items: [PL_ONLINEFIX_ITEM], total: 1 }),
  'pl:refresh': () => ({ ok: true, counts: { bypass: 1, onlinefix: 1 } }),
  'pl:applyFix': (_e, payload) => {
    CALLS.applyFix.push(payload);
    return { ok: true, applied: ['steam_api64.dll'], backedUp: [], downloaded: ['fix.zip'], backupDir: 'C:/apex/backups/271590', errors: [] };
  },
  'pl:steamlessScan': () => ({
    ok: true, dir: 'C:/picked',
    items: [{ path: 'C:/picked/steam_api64.dll', relative: 'steam_api64.dll', size: 137920, sha256: 'abcdef0123456789abcdef' }]
  }),
  'pl:steamlessReplace': (_e, payload) => {
    CALLS.steamlessReplace.push(payload);
    return { ok: true, replaced: [payload.targets[0]], errors: [] };
  },
  'dialog:folder': () => 'C:/picked'
};

const TINY_PNG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** A live Steam storefront result, so the live search paths have something real. */
const LIVE_STEAM = {
  appId: '424242',
  name: 'Live Steam Test',
  priceLabel: '$9.99',
  listPrice: '$19.99',
  discountPct: 50,
  metascore: 88,
  url: 'https://store.steampowered.com/app/424242/',
  art: { wide: TINY_PNG, hero: TINY_PNG, cover: TINY_PNG },
  tinyImage: TINY_PNG
};

const ITCH_ITEM = {
  id: 'itch:teststudio/test-game',
  title: 'Test Game',
  author: 'Test Studio',
  authorUrl: 'https://teststudio.itch.io',
  url: 'https://teststudio.itch.io/test-game',
  cover: TINY_PNG,
  price: 'Free',
  priceNote: null,
  tags: ['Platformer', 'Pixel Art'],
  platforms: { windows: true, osx: false, linux: false, android: false },
  blurb: 'A test title from the itch.io feeds.',
  demo: false
};

const ITCH_DETAIL = {
  id: 'itch:teststudio/test-game',
  gameId: 123456,
  title: 'Test Game',
  author: 'Test Studio',
  authorUrl: 'https://teststudio.itch.io',
  url: 'https://teststudio.itch.io/test-game',
  cover: TINY_PNG,
  screenshots: [TINY_PNG],
  tags: ['Platformer'],
  price: 'Free',
  suggestedPrice: null
};

/** A Lightning Nexus catalogue entry (multi-provider mirrors). */
const LT_ITEM = {
  id: 'lightning:271590',
  title: 'Lightning Heist Test',
  url: 'https://gofile.io/d/abc123',
  size: '1.2 GB',
  sizeBytes: 1288490189,
  cover: TINY_PNG,
  steamAppId: '271590',
  logo: null,
  mirrors: ['https://gofile.io/d/abc123', 'https://buzzheavier.com/xyz']
};

const LT_DETAIL = {
  id: 'lightning:271590',
  title: 'Lightning Heist Test',
  mirrors: ['https://gofile.io/d/abc123', 'https://buzzheavier.com/xyz'],
  mirrorList: [
    { url: 'https://gofile.io/d/abc123', provider: 'gofile', label: 'GOFILE DOWNLOAD HERE' },
    { url: 'https://buzzheavier.com/xyz', provider: 'buzzheavier', label: 'BZZHR DOWNLOAD HERE' }
  ],
  steamAppId: '271590'
};

/** A Bypass catalogue record (publisher -> appId record, normalised flat). */
const PL_BYPASS_ITEM = {
  appId: '271590',
  name: 'Lightning Heist Test',
  publisher: 'Rockstar',
  fixName: 'bypass-v1',
  comments: 'Needs the online bypass.',
  required: ['Steam', 'WinRAR'],
  errors: ['Cannot connect to Rockstar services.', 'Rockstar launcher loops.'],
  launchSteam: true,
  launchExe: false
};

/** An OnlineFix catalogue record. */
const PL_ONLINEFIX_ITEM = {
  appId: '271590',
  name: 'Lightning Heist Test',
  fixName: 'onlinefix-v1',
  image: TINY_PNG
};

app.whenReady().then(() => {
  for (const [channel, fn] of Object.entries(STUBS)) {
    try { ipcMain.removeHandler(channel); } catch { /* not registered yet */ }
    ipcMain.handle(channel, fn);
  }

  setTimeout(run, 1200);
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function run() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('no window'); return done(2); }

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);

  // A real controller may be attached to this machine (which is how the poll
  // bug was found). The harness must be deterministic, so live hardware is
  // ignored and the pad assertions inject their own fake instead.
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

  try {
    // wait for the renderer's init() to have painted something
    for (let i = 0; i < 60; i++) {
      const ready = await js('return !!document.querySelector("#content").children.length && typeof BP !== "undefined";');
      if (ready) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // --- 1. modules present -------------------------------------------------
    check('sfx/controller/bigpicture modules loaded',
      await js('return typeof SFX === "object" && typeof BP === "object" && typeof GP === "object" && typeof Focus === "object";'));

    check('new icons present',
      await js('return icon("fullscreen",16).includes("svg") && icon("fullscreenExit",16).includes("svg") && icon("volume",16).includes("svg") && icon("volumeOff",16).includes("svg");'));

    // --- 2. sound engine ----------------------------------------------------
    check('SFX.play runs and reports success',
      (await js('return SFX.play("select");')) === true);

    check('SFX mute toggles and reports',
      (await js('const a = SFX.toggleMute(); const b = SFX.isMuted(); SFX.toggleMute(); return a === true && b === true;')) === true);

    // --- 3. seed a library so the shelf has content -------------------------
    await js(`
      State.custom = [{ id: 'smoke:one', title: 'Smoke Test One', developer: 'Apex QA', genre: 'Test' },
                      { id: 'smoke:two', title: 'Smoke Test Two', developer: 'Apex QA', genre: 'Test' }];
      State.installed['smoke:one'] = true;
      State.installed['smoke:two'] = true;
      State.owned['smoke:one'] = true;
      State.owned['smoke:two'] = true;
      return true;`);

    // --- 4. Big Picture entry ----------------------------------------------
    const entered = await js(`
      BP.tab = 'library';
      BP.enter();
      const root = document.getElementById('bigpic');
      return {
        bodyClass: document.body.classList.contains('big-picture'),
        shown: !root.classList.contains('hidden'),
        aria: root.getAttribute('aria-hidden'),
        tabs: document.querySelectorAll('#bp-tabs .bp-tab').length,
        onTab: document.querySelectorAll('#bp-tabs .bp-tab.on').length,
        tiles: document.querySelectorAll('#bp-shelf .bp-tile').length,
        foot: document.getElementById('bp-foot').textContent,
        heroTitle: (document.querySelector('#bp-hero h1') || {}).textContent || '',
        heroActions: document.querySelectorAll('#bp-hero .bp-actions .btn').length,
        ring: !!document.querySelector('#bp-shelf .bp-tile.gp-focus'),
        focusIsTile: !!(Focus.el && Focus.el.classList.contains('bp-tile')),
        logoWrap: document.querySelectorAll('#bp-hero .bp-logo-wrap').length,
        logoImg: document.querySelectorAll('#bp-hero .bp-logo[data-logo-id]').length,
        animating: root.classList.contains('bp-in')
      };`);
    check('Big Picture opens and takes over the window',
      entered.bodyClass && entered.shown && entered.aria === 'false', JSON.stringify({ shown: entered.shown }));
    check('six sections render, first one active', entered.tabs === 6 && entered.onTab === 1, `tabs=${entered.tabs}`);
    check('library shelf shows the two seeded games', entered.tiles === 2, `tiles=${entered.tiles}`);
    check('hero shows the selected game and its action cluster',
      /Smoke Test One/.test(entered.heroTitle) && entered.heroActions > 0,
      `hero="${entered.heroTitle}" buttons=${entered.heroActions}`);
    check('the hero uses the same wordmark slot as the detail view',
      entered.logoWrap === 1 && entered.logoImg === 1,
      `wrap=${entered.logoWrap} img=${entered.logoImg}`);
    check('opening Big Picture plays the entrance animation',
      entered.animating === true, `bp-in=${entered.animating}`);

    // The detail hero and the Big Picture hero share one logo slot, so resolving
    // a wordmark has to reach both or the hero would sit on its text fallback.
    const logoPaint = await js(`
      const host = document.createElement('div');
      host.className = 'dt-logo-wrap';
      host.innerHTML = '<img class="dt-logo" data-logo-id="smoke:one">';
      document.body.appendChild(host);

      State.logoAuto['smoke:one'] = '${TINY_PNG}';
      paintResolvedLogo('smoke:one');

      const bpImg = document.querySelector('#bp-hero .bp-logo[data-logo-id="smoke:one"]');
      const dtImg = host.querySelector('.dt-logo');
      const out = {
        bp: !!(bpImg && bpImg.getAttribute('src')),
        detail: !!(dtImg && dtImg.getAttribute('src'))
      };
      host.remove();
      delete State.logoAuto['smoke:one'];
      return out;`);
    check('resolving a wordmark reaches both the detail hero and Big Picture',
      logoPaint.bp === true && logoPaint.detail === true, JSON.stringify(logoPaint));

    // Asserting on the class alone would pass even if the keyframes were never
    // written, and reading computed styles would fail under reduced motion, so
    // the rule is looked up in the stylesheet instead.
    check('the entrance keyframes exist in CSS',
      (await js(`
        for (const sheet of document.styleSheets) {
          try {
            for (const r of sheet.cssRules) {
              if (r.type === CSSRule.KEYFRAMES_RULE && (r.name === 'bpInRise' || r.name === 'bpInTop')) return true;
            }
          } catch { /* cross-origin sheet */ }
        }
        return false;`)) === true);
    check('focus ring starts on a tile', entered.ring && entered.focusIsTile);
    check('footer legend names the keyboard controls',
      /Enter/.test(entered.foot) && /Select/.test(entered.foot) && /Menu/.test(entered.foot) && /Tab/.test(entered.foot),
      entered.foot.trim().replace(/\s+/g, ' ').slice(0, 80));

    // --- 5. navigation ------------------------------------------------------
    const nav = await js(`
      const before = Focus.el;
      Focus.move('right');
      const after = Focus.el;
      const movedOn = after && after !== before;
      const heroFollowed = (document.querySelector('#bp-hero h1') || {}).textContent || '';
      const sel = document.querySelectorAll('#bp-shelf .bp-tile.sel').length;
      // walk back and forth to be sure nothing throws
      Focus.move('left'); Focus.move('up'); Focus.move('down');
      const inScope = Focus.candidates().every((el) => !el.closest('#modal-root') || document.querySelector('#modal-root .modal-backdrop.show'));
      return { movedOn, heroFollowed, sel, inScope, count: Focus.candidates().length };`);
    check('focus ring moves right onto the next tile',
      nav.movedOn && /Smoke Test Two/.test(nav.heroFollowed),
      `hero="${nav.heroFollowed}" candidates=${nav.count}`);
    check('exactly one tile is marked selected', nav.sel === 1, `sel=${nav.sel}`);
    check('navigation stays inside the active layer', nav.inScope === true);

    // --- 6. candidate hygiene ----------------------------------------------
    const hygiene = await js(`
      const list = Focus.candidates();
      const hidden = list.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 4 || r.height < 4;
      }).length;
      const zeroSizeInLayout = list.filter((el) => el.closest('.menu:not(.open)')).length;
      return { total: list.length, hidden, zeroSizeInLayout };`);
    check('no zero-sized or hidden candidates in the ring',
      hygiene.hidden === 0 && hygiene.zeroSizeInLayout === 0, JSON.stringify(hygiene));

    // --- 7. section switching ----------------------------------------------
    const tabbed = await js(`
      BP.cycleTab(1);
      const t = document.querySelector('#bp-tabs .bp-tab.on').textContent.trim();
      BP.setTab('store');
      const store = document.querySelector('#bp-tabs .bp-tab.on').textContent.trim();
      BP.setTab('library');
      return { t, store, back: document.querySelector('#bp-tabs .bp-tab.on').textContent.trim() };`);
    check('sections cycle and switch',
      tabbed.t === 'Store' && tabbed.store === 'Store' && tabbed.back === 'Library', JSON.stringify(tabbed));

    // --- 8. power overlay ---------------------------------------------------
    const overlay = await js(`
      BP.openOverlay();
      const menu = document.getElementById('bp-power-menu');
      const rows = menu.querySelectorAll('.bp-prow').length;
      const open = BP.overlayOpen();
      const ringInOverlay = !!(Focus.el && Focus.el.closest('#bp-power-menu'));
      const scoped = Focus.scope() === menu;
      BP.closeOverlay();
      return { rows, open, ringInOverlay, scoped, closed: !BP.overlayOpen(), hidden: menu.classList.contains('hidden') };`);
    check('power overlay opens, is the nav scope, and closes',
      overlay.rows === 6 && overlay.open && overlay.ringInOverlay && overlay.scoped && overlay.closed && overlay.hidden,
      JSON.stringify(overlay));

    // --- 9. uiBack unwinds one layer at a time ------------------------------
    const back = await js(`
      BP.openOverlay();
      const first = uiBack();               // should close the overlay only
      const stillOpen = BP.isOpen();
      const second = uiBack();              // should now leave Big Picture
      const closed = !BP.isOpen();
      const third = uiBack();               // nothing left to unwind
      return { first, stillOpen, second, closed, third,
               body: document.body.classList.contains('big-picture') };`);
    check('uiBack unwinds overlay, then Big Picture, then reports nothing to do',
      back.first && back.stillOpen && back.second && back.closed && back.third === false && !back.body,
      JSON.stringify(back));

    // --- 10. full screen round-trip ----------------------------------------
    const fsOn = await js('window.api.toggleFullscreen(true); await new Promise(r => setTimeout(r, 500)); return await window.api.isFullscreen();');
    const clsOn = await js('await new Promise(r => setTimeout(r, 250)); return document.body.classList.contains("is-fullscreen");');
    check('F11-style full screen reaches the window and the chrome', fsOn === true && clsOn === true,
      `window=${fsOn} chrome=${clsOn}`);

    const hintOn = await js('return document.getElementById("fs-hint").classList.contains("show");');
    check('full-screen hint appears', hintOn === true);

    const fsOff = await js('window.api.toggleFullscreen(false); await new Promise(r => setTimeout(r, 600)); return await window.api.isFullscreen();');
    const clsOff = await js('await new Promise(r => setTimeout(r, 250)); return document.body.classList.contains("is-fullscreen");');
    check('full screen turns back off cleanly', fsOff === false && clsOff === false, `window=${fsOff} chrome=${clsOff}`);

    // --- 11. Big Picture + full screen bookkeeping --------------------------
    const bpFs = await js(`
      State.settings.bigPictureFullscreen = true;
      BP.enter();
      await new Promise(r => setTimeout(r, 500));
      const inside = document.body.classList.contains('big-picture') && await window.api.isFullscreen();
      BP.exit();
      await new Promise(r => setTimeout(r, 600));
      const after = !document.body.classList.contains('big-picture') && !(await window.api.isFullscreen());
      return { inside, after };`);
    check('Big Picture takes the screen and gives it back', bpFs.inside && bpFs.after, JSON.stringify(bpFs));

    // --- 12. controller card -------------------------------------------------
    const padCard = await js(`
      GP.pads.clear(); window.__allowPad = true;
      const fake = { index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)', mapping: 'standard', buttons: [], axes: [0,0] };
      gpConnected(fake);
      const el = document.getElementById('pad-toast');
      const txt = el.textContent.replace(/\\s+/g, ' ').trim();
      const shown = el.classList.contains('show');
      const status = document.getElementById('pad-status');
      const info = GP.first();
      const statusOn = status.classList.contains('on');
      gpDisconnected(0);
      window.__allowPad = false;
      return { txt, shown, statusOn,
               name: info && info.name, family: info && info.family,
               offShown: el.classList.contains('show'),
               padCount: GP.pads.size };`);
    check('connecting a pad announces it with its real name',
      padCard.shown && padCard.statusOn && padCard.name === 'Xbox Wireless Controller' && padCard.family === 'xbox',
      `${padCard.name} / ${padCard.family}`);
    check('the notice names the layout and the first button',
      /Controller connected/.test(padCard.txt) && /Xbox layout/.test(padCard.txt) && /press A to select/.test(padCard.txt),
      padCard.txt.slice(0, 96));
    check('disconnecting announces it and clears the status light',
      padCard.offShown && padCard.padCount === 0);

    const psInfo = await js(`
      const p = padInfo({ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', mapping: 'standard' });
      const n = padInfo({ id: 'Wireless Controller (Vendor: 054c Product: 09cc)', mapping: '' });
      const y = padInfo({ id: 'Some Random Pad', mapping: '' });
      return { p: [p.name, p.family, p.a, p.b], n: [n.name, n.family], y: [y.family, y.a, y.b] };`);
    check('PlayStation pads are named and labelled with their own glyphs',
      psInfo.p[1] === 'playstation' && psInfo.p[0] === 'DualSense Wireless Controller'
      && psInfo.p[2] === '\u2715' && psInfo.p[3] === '\u25CB',
      JSON.stringify(psInfo.p));
    check('a bare "Wireless Controller" is recognised as PlayStation',
      psInfo.n[0] === 'PlayStation controller' && psInfo.n[1] === 'playstation', JSON.stringify(psInfo.n));
    check('an unknown pad falls back to the generic layout',
      psInfo.y[0] === 'generic' && psInfo.y[1] === '1' && psInfo.y[2] === '2', JSON.stringify(psInfo.y));

    // --- 13. settings surface ----------------------------------------------
    const settings = await js(`
      gotoView('settings');
      await new Promise(r => setTimeout(r, 120));
      const rows = document.querySelectorAll('.keymap .km-row').length;
      const hasVol = !!document.querySelector('#ui-volume');
      const hasOpen = !!document.querySelector('#open-bigpic');
      const hasPadReadout = !!document.querySelector('#pad-readout');
      const toggles = ['controller','uiSounds','bigPictureFullscreen']
        .every((k) => document.querySelector('input[data-key="' + k + '"]'));
      const noHoverToggle = !document.querySelector('input[data-key="uiHoverSound"]');
      const hasPadLive = !!document.querySelector('#pad-live') && !!document.querySelector('#pad-axes');
      const labels = document.querySelector('.keymap').textContent.replace(/\\s+/g,' ').trim();
      return { rows, hasVol, hasOpen, hasPadReadout, toggles, noHoverToggle, hasPadLive, labels };`);
    check('settings exposes the controller, sound and Big Picture controls',
      settings.rows === 7 && settings.hasVol && settings.hasOpen && settings.hasPadReadout && settings.toggles,
      JSON.stringify({ rows: settings.rows, vol: settings.hasVol, toggles: settings.toggles }));
    check('the hover-sound toggle is gone and a live input read-out took its place',
      settings.noHoverToggle && settings.hasPadLive,
      JSON.stringify({ noHoverToggle: settings.noHoverToggle, hasPadLive: settings.hasPadLive }));
    check('the controls reference lists both input methods',
      /Select/.test(settings.labels) && /Enter/.test(settings.labels) && /D-pad/.test(settings.labels),
      settings.labels.slice(0, 90));

    // The Lightning Nexus resolver reads its GoFile token from settings.pl.
    const plSettings = await js(`
      gotoView('settings');
      await new Promise(r => setTimeout(r, 120));
      const input = document.querySelector('#pl-gofile-token');
      const save = document.querySelector('#pl-gofile-save');
      if (!input || !save) return { ok: false };
      input.value = 'smoke-gofile-token';
      save.click();
      await new Promise(r => setTimeout(r, 60));
      return { ok: true, saved: (State.settings.pl || {}).gofileToken };`);
    check('the Project Lightning tools panel saves a GoFile token',
      plSettings.ok && plSettings.saved === 'smoke-gofile-token',
      JSON.stringify(plSettings));

    // --- 14. artwork for imported titles -----------------------------------
    const artChecks = await js(`
      const fg = knownArt({ title: 'Fall Guys' });
      const mc = knownArt({ title: 'Minecraft for Windows' });
      const none = knownArt({ title: 'Totally Made Up Game' });
      const tes = UPCOMING.find((g) => /Elder Scrolls VI/i.test(g.title));
      const coverHtml = art(tes, 'cover');
      return {
        fg: fg && fg.cover, mc: mc && mc.cover, none,
        bannerImg: tes && tes.bannerImage,
        hasBannerImgCss: coverHtml.includes('url("https://i.ytimg.com'),
        logoCover: coverHtml.includes('logo_transparentbg'),
        declared: declaredArt({ title: 'Fall Guys' })
      };`);
    check('Fall Guys and Minecraft resolve real publisher/platform art',
      String(artChecks.fg || '').includes('1097150')
      && String(artChecks.mc || '').includes('store-images.s-microsoft.com')
      && artChecks.none === null,
      JSON.stringify({ fg: !!artChecks.fg, mc: !!artChecks.mc, none: artChecks.none }));
    check('TES VI draws its wordmark over a real key visual',
      artChecks.hasBannerImgCss && artChecks.logoCover
      && String(artChecks.bannerImg || '').includes('ytimg.com'),
      JSON.stringify({ css: artChecks.hasBannerImgCss, logo: artChecks.logoCover }));

    // --- 15. news covers ----------------------------------------------------
    const newsArt = await js(`
      const before = State.news;
      State.news = { fetchedAt: Date.now(), lang: 'fr', items: [{ id: 'n1', title: 'Test story',
        url: 'https://x/', date: null, summary: 's', slug: 'test',
        image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', imageLarge: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }] };
      gotoView('news');
      await new Promise(r => setTimeout(r, 150));
      const img = document.querySelector('.news-card .news-thumb img');
      const src = img ? img.getAttribute('src') : null;
      const listHtml = (document.querySelector('#news-list') || {}).innerHTML || '';
      State.news = before;
      return { src, listLen: listHtml.length };`);
    check('news cards render the article cover',
      newsArt.src === TINY_PNG, JSON.stringify(newsArt));

    // --- 16. news parser reads covers out of the SSR payload ----------------
    const payload = JSON.stringify({
      latestNews: [{
        id: 42, title: 'Hello World', seo_name: 'hello',
        cover_listing_default_path: 'https://gaming-cdn.com/images/news/articles/42/cover/350x197/hello-coverabc.jpg'
      }]
    });
    const newsHtml = `<html><body><script>window.appData.content = ${payload};</script>`
      + '<li><h3><a href="https://news.instant-gaming.com/fr/articles/42-hello">Hello World</a></h3>'
      + '<time datetime="2026-01-01T00:00:00Z">x</time><p>Summary</p></li></body></html>';
    const parsed = newsMod.parseArticles(newsHtml);
    check('the news parser attaches the cover and a larger hero crop',
      parsed.length === 1
      && String(parsed[0].image || '').includes('/cover/350x197/')
      && String(parsed[0].imageLarge || '').includes('/cover/1000x563/'),
      JSON.stringify(parsed[0] && { i: parsed[0].image, l: parsed[0].imageLarge }));

    // --- 17. live pad snapshot ---------------------------------------------
    const snap = await js(`
      GP.pads.clear(); window.__allowPad = true;
      const fake = { index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
        mapping: 'standard',
        buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0 }],
        axes: [0.5, -0.25, 0, 0] };
      clearTimeout(gpTimer);
      gpConnected(fake);
      const s = padSnapshot();
      gpDisconnected(0);
      window.__allowPad = false;
      return s && { name: s.name, buttons: s.buttons, left: s.left, right: s.right };`);
    check('the live snapshot reports buttons and stick positions',
      snap && snap.name === 'Xbox Wireless Controller' && snap.buttons.indexOf('A') >= 0
      && snap.left.indexOf('0.50') >= 0,
      JSON.stringify(snap));

    // --- 18. itch.io browse surface ----------------------------------------
    const itch = await js(`
      gotoView('itch');
      await new Promise(r => setTimeout(r, 500));
      const navTab = !!document.querySelector('.tab[data-view="itch"]');
      const chips = document.querySelectorAll('#itch-feeds .itch-chip').length;
      const cards = document.querySelectorAll('#itch-grid .itch-card').length;
      const badge = !!document.querySelector('#itch-grid .itch-card .plat-itch');
      const price = !!document.querySelector('#itch-grid .itch-card .itch-price');
      const search = !!document.querySelector('#itch-search');
      const title = (document.querySelector('#itch-grid .itch-card h4') || {}).textContent || '';
      const artImg = !!document.querySelector('#itch-grid .itch-card .card-art img');
      return { navTab, chips, cards, badge, price, search, title, artImg,
               feed: itchFeed, fn: typeof renderItch === 'function', view: current };`);
    check('the itch.io tab renders the browse surface from the public feeds',
      itch.navTab && itch.fn && itch.view === 'itch' && itch.chips === 2 && itch.cards === 1 && itch.search,
      JSON.stringify({ chips: itch.chips, cards: itch.cards, view: itch.view }));
    check('itch.io cards carry the origin badge, a price chip and real artwork',
      itch.badge && itch.price && itch.artImg && itch.title === 'Test Game',
      JSON.stringify({ badge: itch.badge, price: itch.price, title: itch.title }));

    // --- 19. itch.io title dialog and install wiring ------------------------
    await js('State.settings.itch = { apiKey: "", username: "" }; return true;');
    const itchDialog = await js(`
      document.querySelector('#itch-grid .itch-card [data-itch-open]').click();
      await new Promise(r => setTimeout(r, 600));
      const modal = !!document.querySelector('#modal-root .modal-backdrop.show');
      const needKey = !!document.querySelector('#modal-root .itch-need');
      const hero = !!document.querySelector('#modal-root .itch-det-hero .art');
      const shots = document.querySelectorAll('#modal-root .itch-shots img').length;
      const openItem = itchOpenItem && itchOpenItem.id;
      closeModal();
      return { modal, needKey, hero, shots, openItem };`);
    check('opening an itch.io title shows its dialog with artwork and screenshots',
      itchDialog.modal && itchDialog.hero && itchDialog.shots === 1
      && itchDialog.openItem === 'itch:teststudio/test-game',
      JSON.stringify(itchDialog));
    check('without a key the dialog asks for one instead of offering a build',
      itchDialog.needKey === true);

    await js('State.settings.itch = { apiKey: "test-key", username: "tester" }; return true;');
    const itchBuilds = await js(`
      itchOpenDialog(itchItems[0]);
      await new Promise(r => setTimeout(r, 600));
      const builds = document.querySelectorAll('#modal-root .itch-build').length;
      const plat = (document.querySelector('#modal-root .itch-build-plat') || {}).textContent || '';
      const btn = !!document.querySelector('#modal-root [data-itch-install]');
      closeModal();
      return { builds, plat: plat.trim(), btn };`);
    check('with a key the dialog lists the real builds with their platform',
      itchBuilds.builds === 1 && itchBuilds.plat === 'Windows' && itchBuilds.btn,
      JSON.stringify(itchBuilds));

    const itchReg = await js(`
      const it = itchItems[0];
      const g = registerItchGame(it, { gameId: 123456 });
      State.owned[g.id] = true;
      const found = byId(g.id);
      return { id: g.id, platform: platformTag(g), inAll: !!found, custom: !!g.custom,
               url: g.itch && g.itch.url, gameId: g.itch && g.itch.gameId,
               price: g.price, cover: !!g.cover, tags: g.tags, owned: isOwned(g.id) };`);
    check('an itch.io title registers as a real, itch-labelled, owned library record',
      itchReg.id === 'itch:teststudio/test-game' && itchReg.platform === 'itch'
      && itchReg.inAll && itchReg.custom && itchReg.owned
      && itchReg.url === 'https://teststudio.itch.io/test-game' && itchReg.gameId === 123456
      && itchReg.price === 'Free' && itchReg.cover,
      JSON.stringify(itchReg));

    // --- 20. platform source badges ----------------------------------------
    const plats = await js(`
      const steamG = byId('cyberpunk');
      const itchG = byId('itch:teststudio/test-game');
      const localG = { id: 'custom:x', title: 'Y', custom: true };
      const bare = { id: 'z', title: 'Z' };
      return {
        steam: platformTag(steamG), itch: platformTag(itchG),
        local: platformTag(localG), bare: platformTag(bare),
        steamBadge: platformBadge(steamG), itchBadge: platformBadge(itchG),
        bareBadge: platformBadge(bare)
      };`);
    check('the platform badge names Steam, itch.io and Local, and stays silent otherwise',
      plats.steam === 'steam' && plats.itch === 'itch' && plats.local === 'local' && plats.bare === null
      && plats.steamBadge.includes('plat-steam') && plats.steamBadge.includes('Steam')
      && plats.itchBadge.includes('plat-itch') && plats.itchBadge.includes('itch.io')
      && plats.bareBadge === '',
      JSON.stringify({ steam: plats.steam, itch: plats.itch, local: plats.local, bare: plats.bare }));

    // --- 20b. GOG install matching -----------------------------------------
    // GOG keys its registry installs by product id, so the hint carries one and
    // the main process matches on it instead of on the display name.
    const gog = await js(`
      const hints = [gameHint(byId('cyberpunk')), gameHint(byId('witcher3')), gameHint(byId('terraria'))];
      return {
        cyberpunk: (hints[0].gogIds || []).join(','),
        witcher3: hints[1].gogIds,
        terraria: (hints[2].gogIds || []).join(','),
        declared: GAMES.filter((g) => g.gogIds && g.gogIds.length).length
      };`);
    check('a GOG product id rides along in the detection hint',
      gog.cyberpunk === '1423049311' && gog.terraria === '1207665503' && gog.witcher3 === null,
      `cyberpunk=${gog.cyberpunk} terraria=${gog.terraria} witcher3=${gog.witcher3}`);
    check('only checked GOG ids are declared, and they are numeric product ids',
      gog.declared === 10 && (await js(`
        return GAMES.filter((g) => g.gogIds && g.gogIds.length)
          .every((g) => g.gogIds.every((x) => /^[0-9]{6,}$/.test(String(x))));`)) === true,
      `declared=${gog.declared}`);

    // --- 21. expanded catalogue --------------------------------------------
    const cat = await js(`
      const missing = CATALOG.filter((id) => !byId(id));
      const newIds = ['hades','celeste','balatro','helldivers2','blackmyth','godofwar','valheim',
                      'factorio','vampiresurvivors','slaythespire','rimworld','lethalcompany'];
      const rowsMissing = STORE_ROWS.flatMap((r) => r.ids).filter((id) => !byId(id));
      return {
        games: GAMES.length, catalog: CATALOG.filter((id) => byId(id)).length, missing,
        rows: STORE_ROWS.length, rowsMissing,
        newCount: newIds.filter((id) => !!byId(id)).length,
        featured: FEATURED.filter((id) => !!byId(id)).length,
        artOk: newIds.filter((id) => { const g = byId(id); return g && g.steamAppId && g.cover && g.wide && g.hero; }).length
      };`);
    check('the catalogue grew, every curated id resolves, and each new title has full art',
      cat.missing.length === 0 && cat.rowsMissing.length === 0 && cat.games >= 60
      && cat.catalog >= 50 && cat.rows === 5 && cat.newCount === 12
      && cat.featured === 6 && cat.artOk === 12,
      JSON.stringify({ games: cat.games, catalog: cat.catalog, rows: cat.rows, new: cat.newCount, art: cat.artOk }));

    // --- 22. Store front page ----------------------------------------------
    const storePage = await js(`
      gotoView('store');
      await new Promise(r => setTimeout(r, 400));
      const rows = document.querySelectorAll('#content .store-row').length;
      const cards = document.querySelectorAll('#content .store-row .scard').length;
      const withArt = document.querySelectorAll('#content .store-row .scard .scard-art img').length;
      const badges = document.querySelectorAll('#content .store-row .scard .plat').length;
      const up = document.querySelectorAll('#content .upcoming-card').length;
      const upArt = document.querySelector('#content .upcoming-card .up-art');
      const r = upArt ? upArt.getBoundingClientRect() : null;
      const ar = r && r.height ? r.width / r.height : 0;
      const overlayFlag = document.querySelector('#content .upcoming-card .up-art .up-flag');
      const meta = document.querySelector('#content .upcoming-card .up-meta');
      return { rows, cards, withArt, badges, up,
               ar: Math.round(ar * 100) / 100,
               overlayText: overlayFlag ? overlayFlag.textContent.trim() : '',
               metaText: meta ? meta.textContent.replace(/\\s+/g, ' ').trim() : '' };`);
    check('the Store renders all five curated rows with artwork on every card',
      storePage.rows === 5 && storePage.cards > 40 && storePage.withArt === storePage.cards,
      JSON.stringify({ rows: storePage.rows, cards: storePage.cards, art: storePage.withArt }));
    check('store cards carry a platform badge',
      storePage.badges > storePage.cards * 0.9,
      `badges=${storePage.badges} of ${storePage.cards}`);
    check('the upcoming card leads with a 16:9 header, not a tall thumbnail',
      storePage.up >= 2 && Math.abs(storePage.ar - 16 / 9) < 0.06,
      `cards=${storePage.up} aspect=${storePage.ar}`);
    check('the long release line moved out of the art overlay into the info column',
      !storePage.overlayText.includes('PS5') && !storePage.overlayText.includes('Xbox')
      && storePage.metaText.length > 0,
      JSON.stringify({ overlay: storePage.overlayText, meta: storePage.metaText.slice(0, 64) }));

    // --- 22b. typing in the Store does not rebuild the catalogue per key ----
    // Everything below the hero is five carousels plus the All Games grid - the
    // same ~60 cards rendered twice - so a synchronous repaint per keystroke is
    // the single largest source of jank in this view. A burst of typing must
    // leave the body untouched, and exactly one repaint must land afterwards.
    const storeTyping = await js(`
      const input = document.getElementById('store-search');
      const body = document.getElementById('store-body');
      const cards = () => body.querySelectorAll('.scard').length;
      const before = cards();
      for (const v of ['c', 'cy', 'cyb']) {
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const duringBurst = cards();
      await new Promise(r => setTimeout(r, 260));
      const afterBurst = cards();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 260));
      return { before, duringBurst, afterBurst, restored: cards() };`);
    check('a burst of typing in the Store repaints once, not once per keystroke',
      storeTyping.before > 40
      && storeTyping.duringBurst === storeTyping.before
      && storeTyping.afterBurst < storeTyping.before
      && storeTyping.restored === storeTyping.before,
      JSON.stringify(storeTyping));

    // --- 23. GTA VI keeps its whole composition ----------------------------
    const gta = await js(`
      const g = byId('gta6');
      const card = upcomingCard(g);
      const po = poCard(g);
      const hero = art(g, 'hero');
      const fS = card.indexOf('up-flag');
      const flagText = fS < 0 ? '' : card.slice(fS, card.indexOf('</span>', fS));
      const mS = card.indexOf('up-meta');
      const metaText = mS < 0 ? '' : card.slice(mS, card.indexOf('</div>', mS));
      return {
        exists: !!g,
        cardMeta: card.includes('up-meta') && card.includes('cd-row'),
        flagText, metaText,
        po16: po.includes('card-art'),
        heroArt: hero.includes('<img')
      };`);
    check('the GTA VI pre-order card keeps its release line beside the countdown',
      gta.exists && gta.cardMeta && gta.heroArt
      && !gta.flagText.includes('19 Nov') && gta.metaText.includes('19 Nov 2026'),
      JSON.stringify({ flag: gta.flagText, meta: gta.metaText.slice(0, 64) }));

    // --- 24. sidebar wiring -------------------------------------------------
    const tabs = await js(`
      const names = [...document.querySelectorAll('#sidebar .tab[data-view]')].map((t) => t.dataset.view);
      return { names, has: names.includes('itch') };`);
    check('the sidebar lists itch.io among the browse tabs',
      tabs.has && tabs.names.length >= 6, JSON.stringify(tabs.names));

    // --- 26. profile + achievements + account panel ------------------------
    const profilePage = await js(`
      gotoView('profile');
      await new Promise(r => setTimeout(r, 500));
      const ach = document.querySelectorAll('#content .ach-tile').length;
      const got = document.querySelectorAll('#content .ach-tile.got').length;
      const account = !!document.querySelector('#content #account-body');
      const statTiles = document.querySelectorAll('#content .stat-tile').length;
      const name = (document.querySelector('#content .profile-idtext h2') || {}).textContent || '';
      return { ach, got, account, statTiles, name };`);
    check('the profile page renders stats, achievements and the account panel',
      profilePage.ach >= 12 && profilePage.statTiles >= 6 && profilePage.account,
      JSON.stringify(profilePage));

    // --- 26b. gallery: screenshots + the achievement shelf ------------------
    const gal = await js(`
      gotoView('gallery');
      await new Promise(r => setTimeout(r, 700));
      const tabs = document.querySelectorAll('#content .gl-tab').length;
      const head = (document.querySelector('#content .page-head h1') || {}).textContent || '';
      const shotTab = document.querySelector('#content .gl-tab[data-tab="screenshots"]');
      const achTab = document.querySelector('#content .gl-tab[data-tab="achievements"]');
      if (achTab) achTab.click();
      await new Promise(r => setTimeout(r, 500));
      const tiles = document.querySelectorAll('#content .ach-tile').length;
      const steam = !!document.getElementById('gl-steam');
      return { tabs, head, shotTab: !!shotTab, tiles, steam };`);
    check('the gallery offers both shelves and renders the full achievement list',
      gal.tabs === 2 && gal.head === 'Gallery' && gal.shotTab && gal.tiles >= 12 && gal.steam,
      JSON.stringify(gal));

    // --- 26c. achievement toast ---------------------------------------------
    const achToast = await js(`
      notifyAchievement({ label: 'Smoke test unlock', desc: 'nothing real' });
      await new Promise(r => setTimeout(r, 150));
      const el = document.querySelector('#ach-host .ach-toast');
      const text = el ? el.textContent : '';
      achQueue.length = 0;
      return { shown: !!el, named: text.includes('Smoke test unlock'), steamLabel: text.includes('Achievement unlocked') };`);
    check('an unlock slides in as a Steam-style toast',
      achToast.shown && achToast.named && achToast.steamLabel, JSON.stringify(achToast));

    // --- 26d. bundled changelog ---------------------------------------------
    const cl = await js(`
      const data = await loadChangelog();
      const list = data.entries || [];
      return { ok: !!data.ok, entries: list.length, version: data.version || '',
               sections: (list[0] && list[0].sections || []).length,
               newest: (list[0] && list[0].version) || '' };`);
    check('the changelog ships with the app and parses into structured entries',
      cl.ok && cl.entries >= 2 && cl.sections > 0 && !!cl.newest, JSON.stringify(cl));

    // --- 26e. contact page + build stamp ------------------------------------
    const contact = await js(`
      gotoView('contact');
      await new Promise(r => setTimeout(r, 400));
      const handles = [...document.querySelectorAll('#content .cc-handle')].map((h) => h.textContent.trim());
      const cards = document.querySelectorAll('#content .cc-card').length;
      const marks = document.querySelectorAll('#content .cc-ico svg path').length;
      const copy = document.querySelectorAll('#content [data-copy]').length;
      const open = document.querySelectorAll('#content [data-open]').length;
      const stamp = ((document.getElementById('build-stamp') || {}).textContent || '').trim();
      const sign = ((document.querySelector('#sidebar .side-sign') || {}).textContent || '').trim();
      const nav = !!document.querySelector('#sidebar .tab[data-view="contact"]');
      gotoView('store');
      return { handles, cards, marks, copy, open, stamp, sign, nav };`);
    check('the Contact page shows both handles, each with a copy and an open button',
      contact.cards === 2 && contact.handles.includes('z1.f') && contact.handles.includes('@kudsoo')
      && contact.marks === 2 && contact.copy === 2 && contact.open === 2 && contact.nav,
      JSON.stringify(contact));
    check('the sidebar build stamp names the exact build and carries the maker mark',
      /^apexlauncher developer build \d+\.\d+\.\d+$/.test(contact.stamp)
      && /kudasai/i.test(contact.sign) && contact.sign.includes('@kudsoo'),
      JSON.stringify({ stamp: contact.stamp, sign: contact.sign }));

    // --- 27. unified search (Steam catalogue + itch.io, real time) ----------
    const uni = await js(`
      const input = document.getElementById('global-search');
      const present = !!input;
      input.value = 'cyber';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      return {
        present,
        onSearch: current === 'search',
        title: (document.querySelector('#content .page-title') || {}).textContent || '',
        steamCards: document.querySelectorAll('#uni-results .scard').length,
        cyber: !!document.querySelector('#uni-results [data-card="cyberpunk"]'),
        q: uniQuery
      };`);
    check('the title-bar box opens a unified results view and filters the Steam catalogue',
      uni.present && uni.onSearch && /Search/.test(uni.title) && uni.cyber && uni.steamCards > 0,
      JSON.stringify({ onSearch: uni.onSearch, steam: uni.steamCards, cyber: uni.cyber }));

    const uniItch = await js(`
      const input = document.getElementById('global-search');
      input.value = 'test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));   // debounce + stubbed IPC
      const cards = document.querySelectorAll('#uni-results .itch-card').length;
      const live = Array.isArray(uniItch) ? uniItch.length : -1;
      const found = typeof uniItchFind === 'function' ? !!uniItchFind('itch:teststudio/test-game') : false;
      return { cards, live, found };`);
    check('the unified view shows itch.io results (loaded + live) and can open them',
      uniItch.cards === 1 && uniItch.found,
      JSON.stringify(uniItch));

    const uniOpen = await js(`
      const btn = document.querySelector('#uni-results .itch-card [data-itch-open]');
      if (!btn) return { clicked: false };
      btn.click();
      await new Promise(r => setTimeout(r, 600));
      const modal = !!document.querySelector('#modal-root .modal-backdrop.show');
      const item = itchOpenItem && itchOpenItem.id;
      closeModal();
      return { clicked: true, modal, item };`);
    check('clicking an itch card from the unified view opens its dialog',
      uniOpen.clicked && uniOpen.modal && uniOpen.item === 'itch:teststudio/test-game',
      JSON.stringify(uniOpen));

    const uniClear = await js(`
      document.querySelector('#sidebar .tab[data-view="store"]').click();
      await new Promise(r => setTimeout(r, 120));
      const input = document.getElementById('global-search');
      return { value: input.value, q: uniQuery, view: current };`);
    check('leaving the results view clears the query',
      uniClear.value === '' && uniClear.q === '' && uniClear.view === 'store',
      JSON.stringify(uniClear));

    // --- 28. Big Picture: Escape stays put, search hits the storefronts -----
    const bpEsc = await js(`
      const fsPref = State.settings.bigPictureFullscreen;
      State.settings.bigPictureFullscreen = false;
      BP.tab = 'library'; BP.enter();
      await new Promise(r => setTimeout(r, 200));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const stillOpen = BP.isOpen();
      BP.exit();
      State.settings.bigPictureFullscreen = fsPref;
      return { stillOpen };`);
    check('Escape no longer leaves Big Picture',
      bpEsc.stillOpen === true, JSON.stringify(bpEsc));

    const bpSteamSearch = await js(`
      State.settings.bigPictureFullscreen = false;
      BP.tab = 'store'; BP.enter();
      await new Promise(r => setTimeout(r, 200));
      const input = document.getElementById('bp-search-input');
      input.value = 'live';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      const live = BP.entries.some((e) => e.kind === 'steam');
      const tiles = document.querySelectorAll('#bp-shelf .bp-tile').length;
      const liveCount = BP.liveSteam.length;
      BP.exit();
      return { live, tiles, liveCount };`);
    check("the Store section's search reaches the live Steam storefront",
      bpSteamSearch.live && bpSteamSearch.liveCount > 0 && bpSteamSearch.tiles > 0,
      JSON.stringify(bpSteamSearch));

    const bpItchSearch = await js(`
      State.settings.bigPictureFullscreen = false;
      const saved = State.custom;
      State.custom = (State.custom || []).filter((g) => !(g.platform === 'itch' || g.itch));
      BP.tab = 'itch'; BP.enter();
      await new Promise(r => setTimeout(r, 200));
      const input = document.getElementById('bp-search-input');
      input.value = 'test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      const live = BP.entries.some((e) => e.kind === 'itch');
      const heroGet = !!document.querySelector('#bp-hero [data-bp-itch]');
      const liveCount = BP.liveItch.length;
      BP.exit();
      State.custom = saved;
      return { live, heroGet, liveCount };`);
    check("the itch.io section's search reaches the live itch.io storefront",
      bpItchSearch.live && bpItchSearch.liveCount > 0 && bpItchSearch.heroGet,
      JSON.stringify(bpItchSearch));

    // --- 29. library vs itch.io section, dock, Discord, scanner icons -------
    const itchHome = await js(`
      const id = 'itch:smoke/installed-game';
      State.custom = State.custom || [];
      if (!State.custom.some((g) => g.id === id)) {
        State.custom.push({ id: id, title: 'Smoke Installed Itch', developer: 'Smoke', release: 2025, genre: 'Imported',
          tags: ['itch.io'], size: 0, price: 'Free', rating: 0, blurb: '', colors: null, cover: null, hero: null, wide: null,
          platform: 'itch', itch: { url: 'https://smoke.itch.io/installed-game' }, custom: true });
      }
      State.installed[id] = true; State.owned[id] = true;

      current = 'library'; render(false);
      const inLibrary = !!document.querySelector('[data-card="' + id + '"]');

      State.settings.bigPictureFullscreen = false;
      BP.tab = 'itch'; BP.enter();
      await new Promise((r) => setTimeout(r, 250));
      const inItchShelf = BP.entries.some((e) => e.id === id);
      BP.exit();

      State.custom = State.custom.filter((g) => g.id !== id);
      delete State.installed[id]; delete State.owned[id];
      return { inLibrary, inItchShelf };`);
    check('an installed itch.io title lives in the Library, not the itch.io section',
      itchHome.inLibrary && !itchHome.inItchShelf, JSON.stringify(itchHome));

    const dock = await js(`
      const savedFav = State.favorites;
      // One installed title (a real Play action) and one catalogue title that
      // carries a Steam AppID (a real source badge).
      const installed = allGames().find((g) => isInstalled(g.id));
      const steamGame = allGames().find((g) => g.steamAppId && !isInstalled(g.id));
      State.favorites = {};
      State.favorites[installed.id] = true;
      State.favorites[steamGame.id] = true;
      current = 'store'; render(false);
      const el = document.getElementById('fav-dock');
      const tiles = el ? el.querySelectorAll('.dock-card').length : 0;
      const act = !!(el && el.querySelector('.dock-act .btn'));
      const badge = !!(el && el.querySelector('.dock-plat'));
      const clickable = !!(el && el.querySelector('[data-card="' + installed.id + '"]'));
      State.favorites = savedFav;
      return { tiles, act, badge, clickable };`);
    check('the quick-launch dock shows pinned favourites with their real action',
      dock.tiles === 2 && dock.act && dock.badge && dock.clickable, JSON.stringify(dock));

    const disc = await js(`
      const st0 = await window.api.presenceStatus();
      const cfg = await window.api.presenceConfigure({ enabled: true, clientId: '1234567890' });
      window.api.presenceSet({ details: 'Smoke', state: 'Testing' });
      const st1 = await window.api.presenceStatus();
      await window.api.presenceConfigure({ enabled: false, clientId: '' });
      const st2 = await window.api.presenceStatus();
      return { hasStatus: !!(st0 && 'connected' in st0), enabled: st1.enabled, id: st1.clientId, off: st2.enabled };`);
    check('Discord Rich Presence configures through the bridge',
      disc.hasStatus && disc.enabled === true && disc.id === '1234567890' && disc.off === false,
      JSON.stringify(disc));

    const scanIcon = await js(`
      await importGameEntry({ name: 'Smoke Icon Game', exe: 'C:/fake/game.exe', dir: 'C:/fake', size: 4096, icon: '${TINY_PNG}' });
      const g = State.custom[State.custom.length - 1];
      const stored = !!(g && g.icon);
      current = 'library'; render(false);
      const cardIco = !!document.querySelector('.card-ico');
      State.custom = State.custom.filter((x) => x.id !== (g && g.id));
      if (g) { delete State.installed[g.id]; delete State.owned[g.id]; if (State.local && State.local.installs) delete State.local.installs[g.id]; }
      return { stored, cardIco };`);
    check('an imported executable keeps its own icon on the library card',
      scanIcon.stored && scanIcon.cardIco, JSON.stringify(scanIcon));

    // --- 25. library collections, playtime sort and layout toggle -----------
    const lib = await js(`
      State.installed['smoke:one'] = true;
      State.owned['smoke:one'] = true;
      State.collections = {};
      const cid = createCollection('Backlog');
      toggleInCollection(cid, 'smoke:one');
      libFilter = 'col:' + cid;
      libSort = 'time';
      current = 'library';
      render(false);

      const chipOn = !!document.querySelector('.col-bar .chip.active');
      const newBtn = !!document.querySelector('.col-bar [data-act="new-collection"]');
      // Filtering hides non-matching cards instead of removing them, so the
      // visible set (and libraryList itself) is what proves the filter applied.
      const visible = [...document.querySelectorAll('#lib-grid [data-card]')]
        .filter((c) => c.style.display !== 'none').length;
      const listed = libraryList().length;
      const collectBtn = document.querySelector('.card .col-btn[data-act="collect"]');
      const collectOn = !!(collectBtn && collectBtn.classList.contains('on'));

      // The layout toggle is only a class on the grid, so no card is rebuilt
      // and the artwork stays decoded when the user flips between the two.
      const grid = document.getElementById('lib-grid');
      const before = grid.firstElementChild;
      grid.classList.add('list');
      const keptCards = grid.firstElementChild === before;
      const listRows = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      grid.classList.remove('list');

      const sortKeys = Object.keys(SORTS).join(',');
      const collected = gamesInCollection(cid).slice();

      libFilter = 'all'; libSort = 'az'; deleteCollection(cid);
      return { chipOn, newBtn, visible, listed, collectOn, keptCards, listRows, sortKeys, collected };`);
    check('a collection can be created, filed into and filtered on',
      lib.chipOn && lib.newBtn && lib.visible === 1 && lib.listed === 1 && lib.collected.length === 1,
      `visible=${lib.visible} listed=${lib.listed} ids=${lib.collected.join('|')}`);
    check('cards carry an add-to-collection button that lights up when filed',
      lib.collectOn === true);
    check('the list layout is one column and rebuilds nothing',
      lib.keptCards === true && lib.listRows === 1, `cols=${lib.listRows}`);
    check('the library sorts by most played as well as recently played',
      lib.sortKeys.includes('time') && lib.sortKeys.includes('played'), lib.sortKeys);

    // --- 30. Lightning Nexus view ------------------------------------------
    const ltSidebar = await js(`
      const names = [...document.querySelectorAll('#sidebar .tab[data-view]')].map((t) => t.dataset.view);
      return { lt: names.includes('lightning'), tools: names.includes('tools') };`);
    check('the sidebar exposes the Nexus and Tools tabs',
      ltSidebar.lt && ltSidebar.tools, JSON.stringify(ltSidebar));

    const ltView = await js(`
      gotoView('lightning');
      await new Promise(r => setTimeout(r, 500));
      const cards = document.querySelectorAll('#lt-grid .lt-card').length;
      const badge = !!document.querySelector('#lt-grid .lt-origin');
      const search = !!document.getElementById('lt-search');
      const mirrors = document.querySelectorAll('#lt-grid .lt-card .tags span').length;
      const hasTitle = /Nexus/.test((document.querySelector('#content .page-title') || {}).textContent || '');
      return { cards, badge, search, mirrors, hasTitle };`);
    check('the Nexus view renders the catalogue with its origin badge and mirrors',
      ltView.cards === 1 && ltView.badge && ltView.search && ltView.mirrors >= 2 && ltView.hasTitle,
      JSON.stringify(ltView));

    const ltOpen = await js(`
      document.querySelector('#lt-grid .lt-card [data-lt-open]').click();
      await new Promise(r => setTimeout(r, 350));
      const modal = !!document.querySelector('#modal-root .modal-backdrop.show');
      const install = !!document.querySelector('#lt-det-install [data-lt-install]');
      const note = (document.querySelector('#lt-det-install .lt-note') || {}).textContent || '';
      return { modal, install, note: note.trim().slice(0, 120) };`);
    check('opening a Nexus card names the mirrors providers and offers an install button',
      ltOpen.modal && ltOpen.install && /mirror/i.test(ltOpen.note)
        && /GOFILE/i.test(ltOpen.note) && /BZZHR/i.test(ltOpen.note), JSON.stringify(ltOpen));

    const ltInstallDom = await js(`
      document.querySelector('#lt-det-install [data-lt-install]').click();
      await new Promise(r => setTimeout(r, 500));
      const id = 'lightning:271590';
      const g = (typeof byId === 'function') ? byId(id) : null;
      const tags = (g && g.tags) || [];
      return { registered: !!g, owned: !!State.owned[id], tag: tags.includes('Nexus') };`);
    const ltStart = CALLS.dlStart[CALLS.dlStart.length - 1] || {};
    check('installing a Nexus title registers it in the library and starts a Nexus download',
      ltInstallDom.registered && ltInstallDom.owned && ltInstallDom.tag
      && ltStart.provider === 'lightning' && ltStart.extract === true
      && ltStart.url === 'https://gofile.io/d/abc123',
      JSON.stringify({ ...ltInstallDom, provider: ltStart.provider, extract: ltStart.extract }));

    // --- 29b. Big Picture: the Nexus category ------------------------------
    const bpNexus = await js(`
      const fsPref = State.settings.bigPictureFullscreen;
      State.settings.bigPictureFullscreen = false;
      BP.tab = 'library';
      BP.enter();
      BP.setTab('nexus');
      await new Promise(r => setTimeout(r, 700));
      const names = [...document.querySelectorAll('#bp-tabs .bp-tab')].map((t) => t.textContent.trim());
      const tiles = document.querySelectorAll('#bp-shelf .bp-tile').length;
      const heroBtn = document.querySelector('#bp-hero [data-bp-nexus]');
      const tag = ((document.querySelector('#bp-shelf .bp-tag') || {}).textContent || '').trim();
      const active = ((document.querySelector('#bp-tabs .bp-tab.on') || {}).textContent || '').trim();
      BP.exit();
      State.settings.bigPictureFullscreen = fsPref;
      return { names, tiles, hero: !!heroBtn, tag, active };`);
    check('Big Picture has a Nexus category that lists the catalogue with its own hero action',
      bpNexus.names.includes('Nexus') && bpNexus.active === 'Nexus'
      && bpNexus.tiles >= 1 && bpNexus.hero && /Nexus/i.test(bpNexus.tag),
      JSON.stringify(bpNexus));

    // --- 29c. Big Picture: its own settings sheet and cue palette ----------
    const bpSet = await js(`
      const fsPref = State.settings.bigPictureFullscreen;
      State.settings.bigPictureFullscreen = false;
      State.settings.uiVolume = 50;
      BP.tab = 'library';
      BP.enter();
      BP.openOverlay();
      const row = [...document.querySelectorAll('#bp-power-menu [data-bp-act]')]
        .find((b) => b.dataset.bpAct === 'settings');
      row.click();
      await new Promise(r => setTimeout(r, 140));
      const sheet = document.getElementById('bp-settings');
      const open = !sheet.classList.contains('hidden');
      const rows = sheet.querySelectorAll('.bps-row').length;
      const controls = sheet.querySelectorAll('[data-bpset]').length;
      sheet.querySelector('[data-bpset="uiVolume"][data-step="10"]').click();
      const vol = State.settings.uiVolume;
      const onBtn = sheet.querySelector('[data-bpset="uiSounds"]');
      const beforeSounds = State.settings.uiSounds !== false;
      onBtn.click();
      const afterSounds = State.settings.uiSounds !== false;
      State.settings.uiSounds = beforeSounds;   // cues are silent while muted
      const cues = ['move', 'select', 'back', 'tab', 'open', 'close',
                    'toggle', 'enter', 'exit'].every((n) => SFX.play(n) !== false);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const stillOpen = BP.settingsOpen();
      State.settings.uiSounds = beforeSounds;
      BP.exit();
      State.settings.bigPictureFullscreen = fsPref;
      return { open, rows, controls, vol, soundsFlipped: beforeSounds !== afterSounds, cues, stillOpen };`);
    check('Big Picture has its own controller-friendly settings sheet',
      bpSet.open && bpSet.rows >= 6 && bpSet.controls >= 6 && bpSet.vol === 60
      && bpSet.soundsFlipped && bpSet.stillOpen === false,
      JSON.stringify(bpSet));
    check('Big Picture plays the shared UI cue palette', bpSet.cues === true, `cues=${bpSet.cues}`);

    // --- 31. Tools view: Bypass / OnlineFix / SteamLess --------------------
    const fxView = await js(`
      gotoView('tools');
      await new Promise(r => setTimeout(r, 600));
      const tabs = document.querySelectorAll('#content .fx-tab').length;
      const active = (document.querySelector('#content .fx-tab.active') || {}).dataset?.fxTab;
      const bypassRows = document.querySelectorAll('#content .fx-row[data-fx-kind="bypass"]').length;
      const chips = document.querySelectorAll('#content .fx-chip').length;
      const title = (document.querySelector('#content .page-title') || {}).textContent || '';
      return { tabs, active, bypassRows, chips, title };`);
    check('the Tools view renders the three tabs and the Bypass catalogue',
      fxView.tabs === 3 && fxView.active === 'bypass' && fxView.bypassRows === 1
      && fxView.chips >= 2 && /Tools/.test(fxView.title),
      JSON.stringify(fxView));

    const fxInfo = await js(`
      document.querySelector('#content [data-fx-info][data-fx-kind="bypass"]').click();
      await new Promise(r => setTimeout(r, 300));
      const modal = !!document.querySelector('#modal-root .modal-backdrop.show');
      const rows = document.querySelectorAll('#modal-root .fx-info-row').length;
      const errors = document.querySelectorAll('#modal-root .fx-info-errors li').length;
      const applyBtn = !!document.querySelector('#modal-root [data-fx-apply]');
      closeModal();
      return { modal, rows, errors, applyBtn };`);
    check('a Bypass entry opens an info dialog with its metadata and known errors',
      fxInfo.modal && fxInfo.rows >= 4 && fxInfo.errors === 2 && fxInfo.applyBtn,
      JSON.stringify(fxInfo));

    const fxApplyOpen = await js(`
      document.querySelector('#content [data-fx-apply][data-fx-kind="bypass"]').click();
      await new Promise(r => setTimeout(r, 300));
      const modal = !!document.querySelector('#modal-root .modal-backdrop.show');
      const fields = ['fx-dest', 'fx-src', 'fx-urls', 'fx-apply-go'].every((id) => !!document.getElementById(id));

      // A missing destination is refused without touching the disk or the bridge.
      document.getElementById('fx-dest').value = '';
      document.getElementById('fx-src').value = '';
      document.getElementById('fx-apply-go').click();
      await new Promise(r => setTimeout(r, 200));
      const refused = (document.getElementById('fx-result') || {}).innerHTML === '';
      return { modal, fields, refused };`);

    const fxApplyRun = await js(`
      document.getElementById('fx-dest').value = 'C:/games/heist';
      document.getElementById('fx-src').value = 'C:/fixes/heist';
      document.getElementById('fx-apply-go').click();
      await new Promise(r => setTimeout(r, 450));
      const reported = !!document.querySelector('#modal-root .fx-result-ok');
      closeModal();
      return { reported };`);
    const fxApplyCall = CALLS.applyFix[CALLS.applyFix.length - 1] || {};

    check('the apply-fix dialog validates its inputs, then sends the chosen folder to the main process',
      fxApplyOpen.modal && fxApplyOpen.fields && fxApplyOpen.refused && fxApplyRun.reported
      && fxApplyCall.appId === '271590' && fxApplyCall.dest === 'C:/games/heist'
      && fxApplyCall.sourceDir === 'C:/fixes/heist' && fxApplyCall.backup === true,
      JSON.stringify({ ...fxApplyOpen, reported: fxApplyRun.reported, dest: fxApplyCall.dest, src: fxApplyCall.sourceDir }));

    const fxOnline = await js(`
      document.querySelector('#content [data-fx-tab="onlinefix"]').click();
      await new Promise(r => setTimeout(r, 600));
      const cards = document.querySelectorAll('#content .fx-card[data-fx-kind="onlinefix"]').length;
      const active = (document.querySelector('#content .fx-tab.active') || {}).dataset?.fxTab;
      return { cards, active };`);
    check('the OnlineFix tab loads its catalogue as cards',
      fxOnline.cards === 1 && fxOnline.active === 'onlinefix', JSON.stringify(fxOnline));

    const fxSl = await js(`
      document.querySelector('#content [data-fx-tab="steamless"]').click();
      await new Promise(r => setTimeout(r, 350));
      const panel = !!document.querySelector('#content .fx-sl');
      const steps = document.querySelectorAll('#content .fx-step').length;
      const scanBtn = document.getElementById('fx-sl-scan');
      const gated = !!(scanBtn && scanBtn.disabled);

      // Choosing a folder un-gates the scan; running it lists the DLLs it found.
      document.getElementById('fx-sl-pick').click();
      await new Promise(r => setTimeout(r, 250));
      const dirText = (document.getElementById('fx-sl-dir') || {}).textContent || '';
      const enabled = !!(document.getElementById('fx-sl-scan') && !document.getElementById('fx-sl-scan').disabled);
      if (enabled) { document.getElementById('fx-sl-scan').click(); await new Promise(r => setTimeout(r, 450)); }
      const dlls = document.querySelectorAll('#content .fx-dll').length;
      return { panel, steps, gated, dirText, enabled, dlls };`);
    check('the SteamLess tab scans a folder and lists the Steamworks DLLs it finds',
      fxSl.panel && fxSl.steps === 4 && fxSl.gated
      && /picked/.test(fxSl.dirText) && fxSl.enabled && fxSl.dlls === 1,
      JSON.stringify(fxSl));

    const fxReplaceDom = await js(`
      document.getElementById('fx-sl-src-pick').click();
      await new Promise(r => setTimeout(r, 250));
      const replaceBtn = document.getElementById('fx-sl-replace');
      const hadBtn = !!replaceBtn;
      if (replaceBtn) { replaceBtn.click(); await new Promise(r => setTimeout(r, 450)); }
      return { hadBtn };`);
    const fxReplaceCall = CALLS.steamlessReplace[CALLS.steamlessReplace.length - 1] || {};
    check('the SteamLess replace button sends the chosen DLLs and backup flag to the main process',
      fxReplaceDom.hadBtn && Array.isArray(fxReplaceCall.targets) && fxReplaceCall.targets.length === 1
      && /picked/.test(fxReplaceCall.sourceDir || '') && fxReplaceCall.backup === true,
      JSON.stringify({ hadBtn: fxReplaceDom.hadBtn, targets: fxReplaceCall.targets, src: fxReplaceCall.sourceDir }));

    // --- 32. the download stage and its percentage --------------------------
    const dlStage = await js(`
      const g = { id: 'smoke:dl-stage', title: 'Stage Probe', developer: 'Apex QA', genre: 'Test' };
      State.custom.push(g);
      State.owned[g.id] = true;

      applyDownloadEvent({ id: g.id, kind: 'install', state: 'downloading', phase: 'Downloading', pct: 50, speedBps: 4 * 1024 * 1024 });
      const row = () => (document.querySelector('.dl-row[data-dl-row="' + g.id + '"]') || {}).textContent || '';
      const downloading = row();

      // Extraction reports its own percentage; the transfer numbers must step
      // aside rather than sit at a stale zero.
      applyDownloadEvent({ id: g.id, kind: 'install', state: 'extracting', phase: 'Extracting', pct: 42, speedBps: 0 });
      const extracting = row();

      openDownloadModal(g.id);
      applyDownloadEvent({ id: g.id, kind: 'install', state: 'extracting', phase: 'Extracting', pct: 42, speedBps: 0 });
      const modal = (document.querySelector('#dl-modal .dlm-progress') || {}).textContent || '';
      closeDownloadModal();

      delete DL[g.id];
      drawerSig = '__init__';
      renderDrawer(true);
      return { downloading, extracting, modal };`);
    check('the drawer row and the download manager name the stage and follow its percentage',
      /Downloading/.test(dlStage.downloading) && /4 MB\/s/.test(dlStage.downloading)
      && /Extracting/.test(dlStage.extracting) && /42%/.test(dlStage.extracting)
      && !/MB\/s/.test(dlStage.extracting)
      && /Extracting/.test(dlStage.modal) && /42%/.test(dlStage.modal),
      JSON.stringify(dlStage));

    // --- 26. the sign-in gate ----------------------------------------------
    // The harnesses boot this main process and drive the real renderer without
    // signing in, so the gate is disarmed for them by name (see HARNESS in
    // main.js). Everything else about it still has to work: the markup, the
    // lock, and the IPC refusal.
    const authMod = require(path.join(__dirname, 'auth'));

    check('the test harness is recognised and the gate is disarmed for it',
      authMod.snapshot().required === false && authMod.allow() === true,
      JSON.stringify({ required: authMod.snapshot().required, allow: authMod.allow() }));

    const gateDom = await js(`
      const g = document.getElementById('auth-gate');
      return {
        present: !!g,
        unlocked: !!(g && g.hidden),
        lockedClass: document.body.classList.contains('auth-locked'),
        signInForm: !!document.getElementById('ag-form-in'),
        signUpForm: !!document.getElementById('ag-form-up'),
        noServerField: !document.getElementById('ag-url')
          && !document.getElementById('ag-start-server')
          && !document.getElementById('ag-save-url'),
        tabIn: !!document.querySelector('[data-ag-tab="in"]')
      };`);
    check('the gate is in the document but out of the way while signed in, with no server field',
      gateDom.present && gateDom.unlocked && !gateDom.lockedClass
      && gateDom.signInForm && gateDom.signUpForm && gateDom.noServerField
      && gateDom.tabIn,
      JSON.stringify(gateDom));

    // Painting it by hand is exactly what the renderer does when the main
    // process reports the session is gone, so it has to lock the window.
    const locked = await js(`
      AuthGate.apply({ required: true, signedIn: false, status: 'signedOut', baseUrl: 'http://127.0.0.1:8787', user: null });
      const g = document.getElementById('auth-gate');
      const shown = !g.hidden;
      const cls = document.body.classList.contains('auth-locked');
      const onSignup = !document.getElementById('ag-form-up').hidden;
      const status = document.getElementById('ag-status').textContent;
      AuthGate.apply({ required: false, signedIn: true, status: 'signedIn', user: { username: 'tester', email: 't@example.com' } });
      return { shown, cls, onSignup, status, afterHide: g.hidden, lockedNow: AuthGate.isLocked() };`);
    check('a signed-out snapshot locks the whole window and offers to create an account',
      locked.shown && locked.cls && locked.onSignup, JSON.stringify(locked));
    check('a signed-in snapshot hands the window back',
      locked.afterHide && locked.lockedNow === false, JSON.stringify(locked));

    // The gate itself: arm it in the main process and watch a privileged
    // channel answer with a refusal rather than doing the work.
    authMod.require();
    const refused = await js(`return await window.api.uninstallPlan('anything');`);
    const refusedQueue = await js(`return await window.api.dlqEnqueue({ url: 'https://example.com/x.zip', name: 'x' });`);
    check('a privileged channel refuses to work while the gate is armed',
      refused && refused.ok === false && refused.authRequired === true
      && refusedQueue && refusedQueue.ok === false && refusedQueue.authRequired === true,
      JSON.stringify({ refused, refusedQueue }));

    const armed = await js(`return await window.api.authState();`);
    check('the renderer is told the gate is armed, and the token never travels with it',
      armed && armed.required === true && armed.signedIn === false && armed.token === undefined
      && !('token' in (armed || {})), JSON.stringify(armed));

    authMod.relax();
    check('disarming the gate hands the app straight back',
      authMod.snapshot().required === false && authMod.allow() === true,
      JSON.stringify(authMod.snapshot()));

    const noTokenLeak = await js(`
      const st = await window.api.loadState();
      return { api: (st && st.settings && st.settings.api) || null, auth: (st && st.settings && st.settings.auth) || null };`);
    check('the renderer\u2019s state file carries no session token',
      !!noTokenLeak.api && !('token' in noTokenLeak.api) && typeof noTokenLeak.api.signedIn === 'boolean'
      && noTokenLeak.api.baseUrl === require('./auth').DEFAULT_SERVER
      && !!noTokenLeak.auth && noTokenLeak.auth.required === false,
      JSON.stringify(noTokenLeak));

    // --- 27. nothing exploded in the renderer ------------------------------
    check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  } catch (err) {
    check('smoke test ran to completion', false, err && err.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  done(failed.length ? 1 : 0);
}
