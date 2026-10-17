'use strict';

/**
 * Headless proof that the forced updater works (see updater.js).
 *
 * It stands up a throwaway HTTP feed on a loopback port, writes a `latest.yml`
 * claiming a version nobody will ever ship, and lets a real electron-updater
 * check + download run against it. Nothing is installed: APEX_UPDATE_NO_INSTALL
 * stops it one step short of running the installer, which is the one part of the
 * real flow a test must never do to the machine it is running on.
 *
 * This is the only way to exercise the updater without publishing a release,
 * because electron-updater refuses to do anything in an unpackaged app unless
 * the feed is overridden and dev mode is forced - which is exactly what the
 * environment variables below do.
 *
 * Run:  npx electron _update-test.js
 */

const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const FAKE_VERSION = '99.0.0';
const PAYLOAD = path.join(__dirname, 'dist', 'Apex-Launcher-Setup-2.7.0.exe');
const DEV_CONFIG = path.join(__dirname, 'dev-app-update.yml');
// Mirrors electron-updater's own ElectronAppAdapter.baseCachePath (see
// node_modules/electron-updater/out/AppAdapter.js) so the harness can look at
// what the download actually produced.
const CACHE_ROOT = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PENDING_DIR = path.join(CACHE_ROOT, 'apex-launcher-updater', 'pending');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
}

function sha512B64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

/** A tiny static feed: /latest.yml plus the payload, with Range support. */
function startFeed() {
  const payload = fs.readFileSync(PAYLOAD);
  const sha = sha512B64(PAYLOAD);
  const name = path.basename(PAYLOAD);
  const yml = [
    `version: ${FAKE_VERSION}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha}`,
    `    size: ${payload.length}`,
    `path: ${name}`,
    `sha512: ${sha}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n');
  const seen = [];

  const server = http.createServer((req, res) => {
    const url = String(req.url || '').split('?')[0];
    seen.push(`${req.method} ${url}`);
    if (url === '/latest.yml') {
      res.setHeader('Content-Type', 'text/yaml');
      res.setHeader('Content-Length', String(Buffer.byteLength(yml)));
      res.end(yml);
      return;
    }
    if (url === `/${name}`) {
      const total = payload.length;
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'application/octet-stream');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : total - 1;
        if (start > end || start >= total) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${total}`);
          res.end();
          return;
        }
        const last = Math.min(end, total - 1);
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${last}/${total}`);
        res.setHeader('Content-Length', String(last - start + 1));
        fs.createReadStream(PAYLOAD, { start, end: last }).pipe(res);
        return;
      }
      res.setHeader('Content-Length', String(total));
      fs.createReadStream(PAYLOAD).pipe(res);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen, sha, size: payload.length, name });
    });
  });
}

/** Waits for the updater to reach one of the given states. */
function waitFor(updater, states, timeoutMs) {
  return new Promise((resolve) => {
    const seen = [];
    const timer = setTimeout(() => { finish(null); }, timeoutMs);
    const finish = (hit) => {
      clearTimeout(timer);
      resolve({ hit, seen });
    };
    updater.onStatus((snap) => {
      if (!snap) return;
      const tag = `${snap.state}${snap.version ? `(${snap.version})` : ''}`;
      if (seen[seen.length - 1] !== tag) seen.push(tag);
      if (states.includes(snap.state)) finish(snap.state);
    });
  });
}

async function run() {
  console.log('--- forced updater harness (updater.js) ---');
  console.log(`  payload: ${PAYLOAD}`);

  check('the installer payload exists', fs.existsSync(PAYLOAD), PAYLOAD);
  if (!fs.existsSync(PAYLOAD)) { done(1); return; }

  // Always start from a cold cache so the download path is really exercised
  // rather than satisfied from a previous run by electron-updater's cache.
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });

  const feed = await startFeed();
  console.log(`  feed: http://127.0.0.1:${feed.port} (claims ${FAKE_VERSION})`);

  // A packaged build reads app-update.yml; a dev run with a forced feed still
  // needs this file on disk because the update *cache* directory is read from
  // it. It is written here and removed again at the end.
  fs.writeFileSync(DEV_CONFIG, [
    'provider: generic',
    `url: http://127.0.0.1:${feed.port}`,
    'updaterCacheDirName: apex-launcher-updater',
    ''
  ].join('\n'));

  process.env.APEX_UPDATE_DEV = '1';
  process.env.APEX_UPDATE_NO_INSTALL = '1';
  process.env.APEX_UPDATE_URL = `http://127.0.0.1:${feed.port}`;

  const updater = require('./updater');
  let busy = false;

  const snap = updater.init({ isBusy: () => busy, log: (m) => console.log(`  [log] ${m}`) });
  check('the updater started (not "unsupported")', snap.state !== 'unsupported', snap.state);
  check('it reports this build\u2019s version', !!snap.current, JSON.stringify(snap));

  // The launch-time check is deliberately delayed, so drive one by hand.
  const watching = waitFor(updater, ['downloaded', 'error'], 180000);
  void updater.check();

  const { hit, seen } = await watching;
  console.log(`  states: ${seen.join(' \u2192 ')}`);
  check('it read the feed and offered the new version', seen.some((x) => x.startsWith('available')), seen.join(','));
  check('it downloaded the new version', hit === 'downloaded', String(hit));

  const after = updater.status();
  check('the offered version is the one in latest.yml', after.version === FAKE_VERSION, String(after.version));
  check('progress finished at 100%', after.percent === 100, String(after.percent));

  // The downloaded file is verified by electron-updater against latest.yml's
  // sha512; check it landed in the cache at the right size as well.
  const pending = PENDING_DIR;
  let cached = null;
  try {
    cached = fs.readdirSync(pending).filter((f) => f.endsWith('.exe'))
      .map((f) => path.join(pending, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] || null;
  } catch { /* not there */ }
  check('the installer is cached on disk', !!cached, pending);
  check('the cached file is the full installer', !!cached && fs.statSync(cached).size === feed.size,
    cached ? String(fs.statSync(cached).size) : 'missing');
  check('the cached file matches latest.yml\u2019s sha512', !!cached && sha512B64(cached) === feed.sha);

  // Forced, but never at the cost of work in flight: while something is
  // downloading the install is deferred instead of restarting under it.
  busy = true;
  const deferred = updater.installNow('Test');
  check('an install is deferred while work is in flight', deferred && deferred.deferred === true, JSON.stringify(deferred));
  busy = false;
  const withheld = updater.installNow('Test');
  check('with APEX_UPDATE_NO_INSTALL=1 the installer is never run', withheld && withheld.skipped === true, JSON.stringify(withheld));

  // The feed was actually used, not bypassed.
  check('the feed served latest.yml', feed.seen.some((s) => s.includes('/latest.yml')), feed.seen.join(', '));
  check('the feed served the installer', feed.seen.some((s) => s.includes(`/${feed.name}`)), feed.seen.join(', '));

  updater.stop();
  try { feed.server.close(); } catch { /* ignore */ }
  done(fail ? 1 : 0);
}

function done(code) {
  try { fs.unlinkSync(DEV_CONFIG); } catch { /* it may never have been written */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(code);
}

app.whenReady().then(() => {
  run().catch((err) => {
    fail++;
    console.log(`  FAIL harness threw -> ${(err && err.stack) || err}`);
    done(1);
  });
});
