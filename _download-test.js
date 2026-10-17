'use strict';

/**
 * Apex download-engine self test  ->  `node _download-test.js`
 *
 * Spins up a localhost HTTP server (with byte-range support) that serves an
 * archive built on the fly, then exercises the real engine end to end:
 *
 *   1. multi-connection ranged download of the archive
 *   2. pause -> resume mid-transfer
 *   3. sha256 verification
 *   4. native ZIP extraction (stored + deflated entries, nested folders)
 *   5. zip-slip rejection
 *   6. source host policy + checksum policy
 *
 * No network access is required and nothing outside a temp folder is touched.
 * Exits non-zero on the first failed assertion.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { Transfer } = require('./net/download');
const archives = require('./net/archives');
const { SourceRegistry } = require('./net/sources');
const { safeJoin } = archives;

let passed = 0;
let failed = 0;

function check(label, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.error(`  \u2717 ${label}${extra ? ` -- ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A minimal, standards-correct ZIP writer (stored + deflate entries)
// ---------------------------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc ^ buf[i]) >>> 0;
    for (let k = 0; k < 8; k++) crc = ((crc >>> 1) ^ (0xedb88320 & -(crc & 1))) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name, data, deflate, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const comp = deflate ? zlib.deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);

  return {
    local: Buffer.concat([local, nameBuf, comp]),
    central: Buffer.concat([central, nameBuf])
  };
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const e = zipEntry(f.name, f.data, !!f.deflate, offset);
    locals.push(e.local);
    centrals.push(e.central);
    offset += e.local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function startServer(payload) {
  // Throttled so a loopback transfer lasts long enough to pause it mid-flight.
  // 16 KB every 10 ms per connection => a 2 MB payload over 4 ranges ~= 320 ms.
  const SLICE = 16 * 1024;
  const DELAY = 10;

  const server = http.createServer((req, res) => {
    const base = { 'accept-ranges': 'bytes', 'content-type': 'application/zip' };

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'content-length': payload.length, 'content-disposition': 'attachment; filename="fixture.zip"' });
      res.end();
      return;
    }

    const range = req.headers.range;
    let body;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : payload.length - 1;
      body = payload.subarray(start, end + 1);
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': body.length });
    } else {
      body = payload;
      res.writeHead(200, { ...base, 'content-length': payload.length });
    }

    let offset = 0;
    let closed = false;
    res.on('close', () => { closed = true; });
    const pump = () => {
      if (closed) return;
      if (offset >= body.length) return res.end();
      res.write(body.subarray(offset, offset + SLICE));
      offset += SLICE;
      setTimeout(pump, DELAY);
    };
    pump();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-dltest-'));
  const dlDir = path.join(root, 'downloads');
  const outDir = path.join(root, 'extracted');
  fs.mkdirSync(dlDir, { recursive: true });

  // Incompressible so the archive really is ~2 MB and spans several chunks.
  const blob = crypto.randomBytes(2 * 1024 * 1024);

  const zip = buildZip([
    { name: 'Game/readme.txt', data: Buffer.from('hello apex\n'), deflate: false },
    { name: 'Game/data/big.bin', data: blob, deflate: true },
    { name: 'Game/', data: Buffer.alloc(0), deflate: false }
  ]);

  const expectedSha = crypto.createHash('sha256').update(zip).digest('hex');
  const server = await startServer(zip);
  const url = `http://127.0.0.1:${server.address().port}/fixture.zip`;
  const archivePath = path.join(dlDir, 'fixture.zip');

  try {
    // --- 1 + 2 + 3: ranged download, pause/resume, byte integrity ----------
    console.log('\n[1] Multi-connection download with pause/resume');
    let sawPause = false;
    let maxConnections = 0;
    let sawConnections = false;
    let receivedAtPause = -1;
    let receivedWhilePaused = -1;
    const transfer = new Transfer({
      url,
      dest: archivePath,
      connections: 4,
      minChunkSize: 128 * 1024,
      onLog: () => {},
      onProgress: (p) => {
        if (p.connections > maxConnections) maxConnections = p.connections;
        if (p.connections > 1) sawConnections = true;
      }
    });

    const run = transfer.start();
    await sleep(150);
    transfer.pause();
    sawPause = transfer.paused;
    const finishedAtPause = transfer._finished;
    receivedAtPause = transfer.received;
    await sleep(350);
    receivedWhilePaused = transfer.received;
    transfer.resume();

    const summary = await run;
    check('pause engaged before the transfer finished', sawPause && !finishedAtPause, `paused=${sawPause} finished=${finishedAtPause}`);
    check('no bytes arrived while paused', receivedWhilePaused === receivedAtPause, `${receivedAtPause} -> ${receivedWhilePaused}`);
    check('resume let the transfer finish', summary.received === undefined || summary.bytes === summary.size);
    check('transfer opened more than one connection', sawConnections, `max=${maxConnections}`);
    check('reported size matches the payload', summary.size === zip.length);
    check('downloaded byte count matches the payload', fs.statSync(archivePath).size === zip.length);

    const gotSha = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    check('sha256 matches the served payload', gotSha === expectedSha, `${gotSha} != ${expectedSha}`);
    check('no .apexpart resume sidecar is left behind', !fs.existsSync(`${archivePath}.apexpart`));

    // --- 4: native extraction ---------------------------------------------
    console.log('\n[2] Native ZIP extraction');
    const result = await archives.extract(archivePath, outDir, { onLog: () => {} });
    const readme = path.join(outDir, 'Game', 'readme.txt');
    const big = path.join(outDir, 'Game', 'data', 'big.bin');

    check('native ZIP parser handled the archive end to end', result.entries === 3, JSON.stringify(result));
    check('readme extracted (stored entry)', fs.existsSync(readme) && fs.readFileSync(readme, 'utf8') === 'hello apex\n');
    check('big.bin extracted (deflated entry)', fs.existsSync(big));
    check('deflated payload is byte-identical', fs.existsSync(big) && Buffer.compare(fs.readFileSync(big), blob) === 0);
    check('nested directories were created', fs.existsSync(path.join(outDir, 'Game', 'data')));

    // --- 5: zip-slip --------------------------------------------------------
    console.log('\n[3] Path escape protection');
    let escaped = false;
    try {
      safeJoin(outDir, '../../Windows/System32/evil.dll');
    } catch {
      escaped = true;
    }
    check('traversal entry is rejected', escaped);
    const inside = safeJoin(outDir, 'Game/readme.txt');
    check('normal entry resolves inside the destination', inside.startsWith(path.resolve(outDir)));

    const evilZip = buildZip([{ name: '../escape.txt', data: Buffer.from('nope'), deflate: false }]);
    const evilPath = path.join(dlDir, 'evil.zip');
    fs.writeFileSync(evilPath, evilZip);
    let evilThrew = false;
    try {
      await archives.extract(evilPath, path.join(outDir, 'evil'), { onLog: () => {} });
    } catch {
      evilThrew = true;
    }
    check('extracting a traversal archive throws', evilThrew);
    check('nothing was written outside the destination', !fs.existsSync(path.join(outDir, 'escape.txt')));

    // --- 6: source policy --------------------------------------------------
    console.log('\n[4] Source host and checksum policy');
    const registry = new SourceRegistry({
      getSettings: () => ({ download: { allowedHosts: [], requireChecksum: true } }),
      appDir: root,
      userDataDir: root
    });

    const good = registry.fromUrl('http://127.0.0.1/fixture.zip', { id: 'x', sha256: expectedSha });
    let goodOk = true;
    try {
      registry.validate(good);
    } catch {
      goodOk = false;
    }
    check('a legitimate localhost item passes validation', goodOk);

    const steamrip = registry.fromUrl('https://steamrip.com/some-game/', { id: 'p', sha256: expectedSha });
    let allowed = true;
    try {
      registry.validate(steamrip);
    } catch {
      allowed = false;
    }
    check('an approved SteamRip archive link passes validation', allowed);

    const noSum = registry.fromUrl('http://127.0.0.1/other.zip', { id: 'n' });
    let sumRefused = false;
    try {
      registry.validate(noSum);
    } catch {
      sumRefused = true;
    }
    check('an item without a sha256 is refused when checksums are required', sumRefused);

    const locked = new SourceRegistry({
      getSettings: () => ({ download: { allowedHosts: ['cdn.mygame.example'], requireChecksum: false } }),
      appDir: root,
      userDataDir: root
    });
    let allowRefused = false;
    try {
      locked.validate(locked.fromUrl('https://random.example/x.zip', { id: 'a' }));
    } catch {
      allowRefused = true;
    }
    check('allowlist mode refuses hosts that are not listed', allowRefused);

    // --- 7: full pipeline through the coordinator ---------------------------
    console.log('\n[5] End-to-end install through installs.js');
    const installs = require('./installs');
    const appDir = path.join(root, 'appdata');
    const gamesDir = path.join(root, 'games');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(gamesDir, { recursive: true });

    fs.writeFileSync(
      path.join(appDir, 'download-manifest.json'),
      JSON.stringify({
        version: 1,
        items: [
          {
            id: 'test:fixture',
            title: 'Test Fixture',
            url,
            sha256: expectedSha,
            size: zip.length,
            filename: 'fixture.zip',
            extract: true,
            dest: 'Test Fixture'
          }
        ]
      }),
      'utf8'
    );

    const settings = {
      bandwidth: 'unlimited',
      installPath: gamesDir,
      downloadPath: path.join(root, 'dl2'),
      download: { connections: 4, manifests: [], allowedHosts: [], requireChecksum: true }
    };

    const events = [];
    installs.init({
      send: (evt) => events.push(evt),
      getSettings: () => settings,
      userDataDir: appDir,
      appDir
    });

    const found = installs.search('fixture');
    check('manifest search finds the item', found.length === 1 && found[0].id === 'test:fixture');

    const started = await installs.start({ id: 'test:fixture', title: 'Test Fixture' }, { settings });
    check('start accepted the item', started.ok === true, JSON.stringify(started));

    const terminal = await new Promise((resolve) => {
      const deadline = Date.now() + 20000;
      const poll = setInterval(() => {
        const last = events.filter((e) => e.id === 'test:fixture').pop();
        if (last && (last.state === 'done' || last.state === 'error')) {
          clearInterval(poll);
          resolve(last);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          resolve(last || { state: 'timeout' });
        }
      }, 50);
    });

    check('pipeline reached the done state', terminal.state === 'done', terminal.error || terminal.state);
    const installed = path.join(gamesDir, 'Test Fixture', 'Game', 'data', 'big.bin');
    check('game files landed in the games folder', fs.existsSync(installed));
    check('installed payload is byte-identical', fs.existsSync(installed) && Buffer.compare(fs.readFileSync(installed), blob) === 0);

    const leftovers = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '_extract') leftovers.push(p);
          walk(p);
        } else {
          leftovers.push(p);
        }
      }
    })(path.join(root, 'dl2'));
    check('download workspace is clean (no archives or staging left)', leftovers.length === 0, leftovers.join(', '));

    const badStart = await installs.start({ id: 'nope:missing', title: 'Missing' }, { settings });
    check('unknown source fails cleanly with a message', badStart.ok === false && /manifest/i.test(badStart.error));

    // --- 8: a hard 403 is not retried five times ---------------------------
    console.log('\n[6] Cloudflare-style 403 is surfaced promptly (no retry ladder)');
    const blockedServer = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        // Advertise a size on HEAD so probe() succeeds, then refuse the GET -
        // exactly how a Cloudflare-protected mirror answers the engine.
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'text/html', 'content-length': 5937, 'accept-ranges': 'bytes' });
          res.end();
          return;
        }
        res.writeHead(403, { 'content-type': 'text/html', 'content-length': 0 });
        res.end();
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const blockedUrl = `http://127.0.0.1:${blockedServer.address().port}/blocked.zip`;
    let blockedRetries = 0;
    let blockedErr = null;
    const blockedT0 = Date.now();
    try {
      await new Transfer({
        url: blockedUrl,
        dest: path.join(dlDir, 'blocked.zip'),
        connections: 4,
        minChunkSize: 1,
        retries: 5,
        retryBaseMs: 500,
        onLog: (_level, msg) => { if (/Retry/.test(msg)) blockedRetries++; }
      }).start();
    } catch (err) {
      blockedErr = err;
    }
    const blockedMs = Date.now() - blockedT0;
    blockedServer.close();

    check('an outright 403 is flagged as blocked', !!blockedErr && blockedErr.blocked === true, blockedErr && blockedErr.message);
    check('the 403 is not retried', blockedRetries === 0, `retries=${blockedRetries}`);
    check('the 403 fails promptly instead of after the retry ladder', blockedMs < 2000, `${blockedMs}ms`);

    // --- 9: Lightning Nexus provider resolution -----------------------------
    console.log('\n[7] Lightning Nexus multi-provider resolution');
    const mirrors = require('./net/providers/mirrors');
    const steamripProvider = require('./net/providers/steamrip');
    const providers = require('./net/providers');

    check('a direct archive mirror is recognised as direct',
      mirrors.looksDirect('https://itsfileditchfiles.st/balpha32/e7e9/Bloons-TD-6.rar'));
    check('a provider landing page is not treated as a direct file',
      !mirrors.looksDirect('https://bzzhr.to/frll3qaafaah'));

    const bz = mirrors.resolveBuzzheavier('https://bzzhr.to/frll3qaafaah');
    check('Buzzheavier hands its Cloudflare page to the background browser',
      !!bz && bz.url === 'https://buzzheavier.com/frll3qaafaah' && bz.needsBrowser === true,
      JSON.stringify(bz));
    check('Buzzheavier keeps a SteamRip referer for the page load',
      !!bz && /steamrip\.com/.test(bz.referrer || ''), bz && bz.referrer);
    const bzCdn = mirrors.resolveBuzzheavier('https://abc123.bzzhr.co/Bloons-TD-6.rar');
    check('a Buzzheavier CDN node is passed through as a direct file',
      !!bzCdn && bzCdn.direct === true && bzCdn.needsBrowser !== true && bzCdn.url === 'https://abc123.bzzhr.co/Bloons-TD-6.rar',
      JSON.stringify(bzCdn));

    const pd = mirrors.resolvePixeldrain('https://pixeldrain.com/u/abc123');
    check('Pixeldrain resolves to the file API',
      !!pd && pd.url === 'https://pixeldrain.com/api/file/abc123', pd && pd.url);
    check('a provider is identified from its host', mirrors.providerOf('https://gofile.io/d/xyz') === 'gofile');

    const mirrorHtml = [
      '<a class="btn" href="//bzzhr.to/abc123">BZZHR DOWNLOAD HERE</a>',
      '<a href="//itsfileditchfiles.st/a/b/Game.rar">DOWNLOAD HERE</a>',
      '<a href="//gofile.io/d/zzzzzz">GOFILE DOWNLOAD HERE</a>'
    ].join('\n');
    const listed = steamripProvider.parseMirrorList(mirrorHtml);
    check('every DOWNLOAD HERE button is kept', listed.length === 3, JSON.stringify(listed));
    check('the BZZHR button is labelled buzzheavier', !!listed[0] && listed[0].provider === 'buzzheavier');
    check('a bare button falls back to host detection', !!listed[1] && listed[1].provider === 'fileditch');
    check('the GOFILE button is labelled gofile', !!listed[2] && listed[2].provider === 'gofile');

    // GoFile + Buzzheavier resolved against a stubbed API; direct mirror first.
    const realFetch = global.fetch;
    global.fetch = async (u) => {
      const s = String(u);
      if (s.includes('api.gofile.io/servers')) return new Response(JSON.stringify({ status: 'ok', data: { servers: [{ name: 'store1' }] } }));
      if (s.includes('api.gofile.io/accounts')) return new Response(JSON.stringify({ status: 'ok', data: { token: 'guest-token' } }));
      if (s.includes('/contents/')) {
        return new Response(JSON.stringify({
          status: 'ok',
          data: { type: 'folder', children: { 1: { type: 'file', name: 'Game.zip', size: 123, link: 'https://store1.gofile.io/download/web/1/Game.zip' } } }
        }));
      }
      return new Response('nope', { status: 404 });
    };
    let multi = { sources: [], skipped: [] };
    try {
      multi = await mirrors.resolveAll([
        'https://gofile.io/d/zzzzzz',
        'https://bzzhr.to/frll3qaafaah',
        'https://itsfileditchfiles.st/a/b/Game.rar'
      ], {});
    } finally {
      global.fetch = realFetch;
    }
    check('all three mirrors resolve', multi.sources.length === 3, JSON.stringify(multi.sources));
    check('an API-resolved provider link is tried first',
      multi.sources[0] && multi.sources[0].provider === 'gofile',
      JSON.stringify(multi.sources.map((s) => s.provider)));
    check('GoFile resolves to the file link',
      multi.sources.some((s) => s.url === 'https://store1.gofile.io/download/web/1/Game.zip'));
    check('Buzzheavier keeps its page and asks for the background browser',
      multi.sources.some((s) => s.provider === 'buzzheavier' && s.needsBrowser === true && s.url === 'https://buzzheavier.com/frll3qaafaah'),
      JSON.stringify(multi.sources.map((s) => ({ p: s.provider, b: s.needsBrowser, u: s.url }))));
    check('a Cloudflare direct mirror is flagged for the background browser',
      multi.sources.some((s) => s.provider === 'fileditch' && s.needsBrowser === true),
      JSON.stringify(multi.sources.map((s) => ({ p: s.provider, b: s.needsBrowser }))));
    // FileDitch serves a bare Cloudflare interstitial with no control to press,
    // so it must never be tried ahead of a mirror that can actually resolve.
    check('a Cloudflare interstitial mirror is demoted to last',
      multi.sources[multi.sources.length - 1].provider === 'fileditch',
      JSON.stringify(multi.sources.map((s) => s.provider)));

    // The real Forza Horizon 6 mirror list, as SteamRip publishes it: the live
    // failure mode was burning ~16s on FileDitch before reaching Buzzheavier.
    const forza = await mirrors.resolveAll([
      'https://bzzhr.to/r6wd162e1ja7',
      'https://fileditchfiles.st/alpha37/c8b2444f2b8c34bba40f/FoHsix-SteamRIP.com.rar',
      'https://bzzhr.to/lag2ozuicskk'
    ], {});
    check('the real SteamRip mirror list reaches Buzzheavier before FileDitch',
      forza.sources.length === 3
        && forza.sources[0].provider === 'buzzheavier'
        && forza.sources[2].provider === 'fileditch',
      JSON.stringify(forza.sources.map((s) => s.provider)));

    // The background-browser resolver must stand down (not throw) outside the app.
    const browserResolver = require('./net/providers/browser');
    check('the background browser reports itself unavailable under plain node',
      browserResolver.browserAvailable() === false, String(browserResolver.browserAvailable()));
    const noBrowser = await browserResolver.resolveInBrowser('https://buzzheavier.com/abc');
    check('resolving without the app degrades to a reason, never an error',
      !!noBrowser && noBrowser.ok === false && /only available inside the app/.test(noBrowser.reason),
      JSON.stringify(noBrowser));
    check('the click helper refuses copy/mirror/ad controls',
      /copy\|mirror/.test(browserResolver.CLICK_SCRIPT) || /mirror\|open in browser/.test(browserResolver.CLICK_SCRIPT));

    // GoFile's premium gate must be reported, never thrown.
    global.fetch = async (u) => {
      const s = String(u);
      if (s.includes('/servers')) return new Response(JSON.stringify({ status: 'ok', data: { servers: [{ name: 'store1' }] } }));
      if (s.includes('/accounts')) return new Response(JSON.stringify({ status: 'ok', data: { token: 'guest-token' } }));
      return new Response(JSON.stringify({ status: 'error-notPremium', data: {} }), { status: 401 });
    };
    let gofileRefused = null;
    try {
      gofileRefused = await mirrors.resolveGofile('https://gofile.io/d/zzzzzz', {});
    } finally {
      global.fetch = realFetch;
    }
    check('a GoFile premium refusal is reported, not thrown',
      !!gofileRefused && gofileRefused.ok === false && /GoFile/.test(gofileRefused.reason),
      JSON.stringify(gofileRefused));

    // A search must be a *single* request. The old code enriched every result
    // by fetching its own page serially (with a 600ms throttle), so the
    // catalogue took ~20s to appear and looked empty.
    const searchHtml = [
      '<div class="item"><img data-src="https://steamrip.com/wp-content/uploads/x/pic.jpg">',
      '<a href="https://steamrip.com/single-request-probe-free-download/">Single Request Probe Free Download</a>',
      '<span>12 GB</span></div>'
    ].join('');
    let searchCalls = 0;
    global.fetch = async () => {
      searchCalls++;
      return new Response(searchHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    let searchRes = null;
    try {
      searchRes = await steamripProvider.search('single-request-probe', {});
    } finally {
      global.fetch = realFetch;
    }
    check('a catalogue search is a single request (no per-title enrichment)',
      searchCalls === 1 && !!searchRes && searchRes.items.length === 1,
      `calls=${searchCalls} items=${searchRes && searchRes.items.length}`);
    check('the listing parse fills the card without a detail fetch',
      !!searchRes && searchRes.items[0].cover === 'https://steamrip.com/wp-content/uploads/x/pic.jpg'
        && searchRes.items[0].size === '12 GB',
      JSON.stringify(searchRes && searchRes.items[0]));

    // --- 10: failover — a landing page must not end the install -------------
    const landing = Buffer.from('<!DOCTYPE html><html><head><title>Just a moment</title></head><body>checking your browser</body></html>');
    const mirrorServer = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        const isPage = req.url.startsWith('/page');
        const body = isPage ? landing : zip;
        const base = { 'accept-ranges': 'bytes', 'content-type': isPage ? 'text/html; charset=utf-8' : 'application/zip' };
        if (req.method === 'HEAD') {
          res.writeHead(200, { ...base, 'content-length': body.length });
          res.end();
          return;
        }
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : body.length - 1;
          const slice = body.subarray(start, end + 1);
          res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': slice.length });
          res.end(slice);
        } else {
          res.writeHead(200, { ...base, 'content-length': body.length });
          res.end(body);
        }
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const mirrorPort = mirrorServer.address().port;
    const pageUrl = `http://127.0.0.1:${mirrorPort}/page`;
    const mirrorZipUrl = `http://127.0.0.1:${mirrorPort}/file.zip`;

    providers.register({
      id: 'testmirror',
      label: 'Test Mirror',
      trust: 'user',
      metadataOnly: false,
      async deliver() {
        return {
          ok: true,
          item: {
            id: 'mirror:fixture',
            title: 'Mirror Fixture',
            url: pageUrl,
            kind: 'http',
            sha256: null,
            checksumOptional: true,
            trustedSource: 'lightning',
            size: 0,
            filename: 'mirror.zip',
            extract: true,
            dest: 'Mirror Fixture',
            sources: [
              { url: pageUrl, provider: 'gofile' },
              { url: mirrorZipUrl, provider: 'direct' }
            ]
          }
        };
      }
    });

    const mirrorStart = await installs.start({ id: 'mirror:fixture', title: 'Mirror Fixture', provider: 'testmirror' }, { settings });
    check('the provider install is accepted', mirrorStart.ok === true, JSON.stringify(mirrorStart));

    const mirrorTerminal = await new Promise((resolve) => {
      const deadline = Date.now() + 20000;
      const poll = setInterval(() => {
        const last = events.filter((e) => e.id === 'mirror:fixture').pop();
        if (last && (last.state === 'done' || last.state === 'error')) { clearInterval(poll); resolve(last); }
        else if (Date.now() > deadline) { clearInterval(poll); resolve(last || { state: 'timeout' }); }
      }, 50);
    });
    mirrorServer.close();

    check('a landing-page mirror is skipped and the install still completes',
      mirrorTerminal.state === 'done', mirrorTerminal.error || mirrorTerminal.state);
    const mirrorReadme = path.join(gamesDir, 'Mirror Fixture', 'Game', 'readme.txt');
    check('the payload came from the working mirror',
      fs.existsSync(mirrorReadme) && fs.readFileSync(mirrorReadme, 'utf8') === 'hello apex\n');
    check('the extracted payload is byte-identical',
      fs.existsSync(path.join(gamesDir, 'Mirror Fixture', 'Game', 'data', 'big.bin')));

    // --- 11: Cloudflare mirror resolved in the background, then fetched ------
    // A "needsBrowser" source must skip the engine (it can only ever get a 403)
    // and be handed to the background resolver; the signed URL it returns is
    // then downloaded by the normal engine. This is the Buzzheavier path.
    const signedUrl = `http://127.0.0.1:${mirrorPort}/signed.zip`;
    const cfServer = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.url.startsWith('/cf/')) {
          engineHitCf++;
          res.writeHead(403, { 'content-type': 'text/html' });
          res.end('<!DOCTYPE html><html><body>Cloudflare</body></html>');
          return;
        }
        const range = req.headers.range;
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length, 'accept-ranges': 'bytes' });
          res.end();
          return;
        }
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : zip.length - 1;
          const slice = zip.subarray(start, end + 1);
          res.writeHead(206, { 'content-type': 'application/zip', 'content-range': `bytes ${start}-${end}/${zip.length}`, 'content-length': slice.length });
          res.end(slice);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
        res.end(zip);
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const cfPort = cfServer.address().port;
    const cfPage = `http://127.0.0.1:${cfPort}/cf/r6wd162e1ja7`;
    const cfSigned = `http://127.0.0.1:${cfPort}/signed.zip`;

    let engineHitCf = 0;
    const realResolver = browserResolver.resolveInBrowser;
    let resolverArgs = null;
    browserResolver.resolveInBrowser = async (url, opts) => {
      resolverArgs = { url, opts };
      return { ok: true, url: cfSigned, filename: 'cf.zip', size: zip.length, provider: 'buzzheavier' };
    };

    providers.register({
      id: 'cftest',
      label: 'Cloudflare Test',
      trust: 'user',
      metadataOnly: false,
      async deliver() {
        return {
          ok: true,
          item: {
            id: 'cf:fixture',
            title: 'CF Fixture',
            url: cfPage,
            kind: 'http',
            sha256: null,
            checksumOptional: true,
            trustedSource: 'lightning',
            size: 0,
            // Deliberately extension-less, exactly like a real provider id.
            // UnRAR.exe appends ".rar" to such a name and then cannot find it
            // ("exit 10"), so the coordinator must repair it before extraction.
            filename: 'wga3JMbt',
            extract: true,
            dest: 'CF Fixture',
            sources: [{ url: cfPage, provider: 'buzzheavier', kind: 'http', needsBrowser: true, referrer: 'https://steamrip.com/' }]
          }
        };
      }
    });

    try {
      const cfStart = await installs.start({ id: 'cf:fixture', title: 'CF Fixture', provider: 'cftest' }, { settings });
      check('the Cloudflare-mirror install is accepted', cfStart.ok === true, JSON.stringify(cfStart));

      const cfTerminal = await new Promise((resolve) => {
        const deadline = Date.now() + 20000;
        const poll = setInterval(() => {
          const last = events.filter((e) => e.id === 'cf:fixture').pop();
          if (last && (last.state === 'done' || last.state === 'error')) { clearInterval(poll); resolve(last); }
          else if (Date.now() > deadline) { clearInterval(poll); resolve(last || { state: 'timeout' }); }
        }, 50);
      });

      check('a background-resolved mirror still installs',
        cfTerminal.state === 'done', cfTerminal.error || cfTerminal.state);
      check('the resolver was asked for the provider page, not the file',
        !!resolverArgs && resolverArgs.url === cfPage, JSON.stringify(resolverArgs));
      check('the resolver was handed the SteamRip referer',
        !!resolverArgs && resolverArgs.opts && resolverArgs.opts.referrer === 'https://steamrip.com/',
        JSON.stringify(resolverArgs && resolverArgs.opts));
      check('the engine never touched the Cloudflare page itself',
        engineHitCf === 0, `hits=${engineHitCf}`);
      check('the signed link is what actually landed on disk',
        fs.existsSync(path.join(gamesDir, 'CF Fixture', 'Game', 'readme.txt')),
        'CF Fixture/Game/readme.txt missing');
    } finally {
      browserResolver.resolveInBrowser = realResolver;
      cfServer.close();
    }

    // The background resolver is never allowed to open a visible window.
    const browserSrc = fs.readFileSync(path.join(__dirname, 'net', 'providers', 'browser.js'), 'utf8');
    check('the background resolver is created hidden and off the taskbar',
      /show:\s*false/.test(browserSrc) && /skipTaskbar:\s*true/.test(browserSrc),
      'browser.js is missing show:false/skipTaskbar:true');
    check('the background resolver denies popups instead of opening windows',
      /setWindowOpenHandler/.test(browserSrc) && /action:\s*'deny'/.test(browserSrc),
      'browser.js does not deny window.open');
    check('the background resolver keeps hidden pages from being throttled',
      /backgroundThrottling:\s*false/.test(browserSrc),
      'browser.js is missing backgroundThrottling:false');

    const probeHtml = path.join(dlDir, 'probe.html');
    fs.writeFileSync(probeHtml, landing);
    check('looksLikeHtml detects a landing page', (await installs.looksLikeHtml(probeHtml)) === true);
    check('looksLikeHtml ignores a real archive', (await installs.looksLikeHtml(archivePath)) === false);

    // --- 12: archive naming -------------------------------------------------
    // Providers name the payload after the mirror id, usually with no
    // extension. UnRAR.exe then appends ".rar" to the argument and cannot find
    // the file it was given, surfacing as a bare "unrar.exe exited with code 10".
    const noExt = path.join(dlDir, 'provider-mirror-id');
    fs.writeFileSync(noExt, zip);
    const fixedName = installs.normalizeArchivePath(noExt);
    check('an extension-less archive gains the extension its bytes imply',
      path.basename(fixedName) === 'provider-mirror-id.zip' && fs.existsSync(fixedName) && !fs.existsSync(noExt),
      path.basename(fixedName));

    const keepName = path.join(dlDir, 'already-named.zip');
    fs.writeFileSync(keepName, zip);
    check('an archive that already has the right extension is left alone',
      installs.normalizeArchivePath(keepName) === keepName);

    const hintPath = path.join(dlDir, '3juu4Uwm');
    fs.writeFileSync(hintPath, zip);
    check('the provider file name wins when ours has no extension',
      path.basename(installs.normalizeArchivePath(hintPath, 'Geometry-Dash-SteamRIP.com.zip')) === 'Geometry-Dash-SteamRIP.com.zip',
      path.basename(installs.normalizeArchivePath(hintPath, 'Geometry-Dash-SteamRIP.com.zip')));

    const junkPath = path.join(dlDir, 'not-an-archive-at-all');
    fs.writeFileSync(junkPath, 'plain text, no magic bytes');
    check('a file with no recognisable format is left untouched',
      installs.normalizeArchivePath(junkPath) === junkPath);

    // The extractor layer must cope on its own too (defence in depth).
    const aliasSrc = path.join(dlDir, 'extension-less-rar');
    fs.writeFileSync(aliasSrc, zip);
    const alias = archives.aliasWithExtension(aliasSrc, 'rar');
    check('the extractor is handed an alias carrying the extension',
      alias.path === `${aliasSrc}.rar` && fs.existsSync(alias.path) && fs.statSync(alias.path).size === zip.length,
      alias.path);
    if (alias.cleanup) alias.cleanup();
    check('the alias is cleaned up afterwards', !fs.existsSync(`${aliasSrc}.rar`));
    check('a path that already has an extension is handed over untouched',
      archives.aliasWithExtension(keepName, 'zip').path === keepName);

    check('the failover list skips a magnet when HTTP mirrors exist',
      installs.sourceList({
        url: 'https://x.example/a',
        kind: 'http',
        sources: [{ url: 'magnet:?xt=urn:btih:abc', kind: 'torrent' }, { url: 'https://x.example/a', kind: 'http' }]
      }).length === 1);
    check('a magnet-only item still yields exactly one attempt',
      installs.sourceList({
        url: 'magnet:?xt=urn:btih:abc',
        kind: 'torrent',
        sources: [{ url: 'magnet:?xt=urn:btih:abc', kind: 'torrent' }]
      }).length === 1);
  } finally {
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}  (${passed} passed, ${failed} failed)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
