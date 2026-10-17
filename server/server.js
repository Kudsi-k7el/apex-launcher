'use strict';

/**
 * Apex Launcher backend.
 * ---------------------------------------------------------------------------
 * One process, two jobs:
 *
 *   1. It is the accounts API (`/auth/*`, `/profile`) that both the companion
 *      website and the launcher itself talk to.
 *   2. It serves the companion website, so the site and the API share an origin
 *      and the session cookie works without any CORS dance.
 *
 * There is no framework and no dependency: `node:http` for the wire, the
 * built-in `node:sqlite` for the data. That means `node server/server.js` is the
 * whole install step.
 *
 *   node server/server.js                 # http://127.0.0.1:8787
 *   node server/server.js --port 9000     # somewhere else
 *   node server/server.js --host 0.0.0.0  # reachable from the LAN
 *   node server/server.js --trust-proxy   # behind Cloudflare Tunnel / Caddy
 *   node server/server.js --allow-origin https://example.com   # site elsewhere
 *
 * Every flag also reads an environment variable - APEX_PORT, APEX_HOST, APEX_DB,
 * APEX_TRUST_PROXY, APEX_ALLOW_ORIGINS - which is far easier to set for a
 * Windows service or scheduled task than a quoted command line.
 *
 * Safety posture: loopback by default (binding to 0.0.0.0 has to be asked for on
 * purpose), a 30-day sliding session, per-IP rate limits on the credential
 * endpoints, and no account enumeration - "wrong password" and "no such user"
 * give the same answer.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store');

const REPO = path.join(__dirname, '..');
const SITE = path.join(REPO, 'website');
const DIST = path.join(REPO, 'dist');

const NAME = 'Apex Launcher backend';
const VERSION = '1.0.0';
const COOKIE = 'apex_session';
const DAY = 24 * 60 * 60 * 1000;
const MAX_BODY = 256 * 1024;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  const out = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  };
  if (payload) out['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(status, out);
  res.end(payload);
}

function fail(res, status, message, headers) {
  send(res, status, { ok: false, error: message }, headers);
}

/** Reads and parses a JSON body, refusing anything oversized. */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve({ error: 'That request was too large.' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({ value: {} });
      try { resolve({ value: JSON.parse(raw) }); }
      catch { resolve({ error: 'That request was not valid JSON.' }); }
    });
    req.on('error', () => resolve({ error: 'The request was interrupted.' }));
  });
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** The token a request carries: `Authorization: Bearer` first, then cookie. */
function tokenOf(req) {
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return parseCookies(req.headers.cookie)[COOKIE] || '';
}

function sessionCookie(token, maxAgeSec, secure) {
  // SameSite=Lax keeps the cookie off cross-site POSTs; it is only ever a
  // convenience for the website, since the launcher uses the bearer header.
  //
  // `Secure` is added only when the browser really did reach us over TLS. On the
  // local loopback setup that is not the case, and a Secure cookie on plain HTTP
  // is silently dropped by the browser - which would look exactly like the
  // session not persisting.
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/**
 * Was this request made over HTTPS?
 *
 * Once the server sits behind a TLS terminator (Cloudflare Tunnel, Caddy, nginx)
 * the connection to us is plain HTTP, so the scheme has to come from the proxy -
 * and only when that proxy is trusted. Without the check a client could forge
 * `X-Forwarded-Proto` and talk us into telling the browser to pin a cookie to a
 * scheme that was never used.
 */
function isSecureReq(req, opts = {}) {
  if (opts.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';
  }
  return !!(req.socket && req.socket.encrypted);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
/**
 * A tiny fixed-window counter. `peek` answers without counting (so a check
 * before an attempt does not itself consume budget), `hit` records an attempt,
 * and `clear` forgets a key - which is what a successful sign-in does.
 */
function makeLimiter(limit, windowMs) {
  const hits = new Map();

  function peek(key) {
    const rec = hits.get(key);
    const now = Date.now();
    if (!rec || now > rec.reset) return { ok: true, left: limit };
    if (rec.n >= limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((rec.reset - now) / 1000)) };
    }
    return { ok: true, left: limit - rec.n };
  }

  function hit(key) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now > rec.reset) hits.set(key, { n: 1, reset: now + windowMs });
    else rec.n += 1;
    return peek(key);
  }

  function clear(key) {
    hits.delete(key);
  }

  return { peek, hit, clear, size: () => hits.size };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8'
};

// Only two directories are ever readable: the site and the installers. The
// repository itself (state files, main.js, .env-ish config) is not on the menu,
// which is why `/` is not simply mapped onto the repo root.
function resolveStatic(pathname, { site = SITE, dist = DIST } = {}) {
  let clean;
  try { clean = decodeURIComponent(pathname); }
  catch { return null; }
  clean = clean.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

  const tries = [];
  if (clean === '/' || clean === '/index.html' || clean === '/website' || clean === '/website/') {
    tries.push(path.join(site, 'index.html'));
  } else if (clean.startsWith('/website/')) {
    tries.push(path.join(site, clean.slice('/website/'.length)));
  } else if (clean.startsWith('/dist/')) {
    tries.push(path.join(dist, clean.slice('/dist/'.length)));
  } else {
    tries.push(path.join(site, clean.slice(1)));
  }

  for (const abs of tries) {
    const full = path.resolve(abs);
    const base = full.startsWith(path.resolve(dist)) ? path.resolve(dist)
      : (full.startsWith(path.resolve(site)) ? path.resolve(site) : null);
    if (!base) continue;                                  // escaped the roots
    if (!full.startsWith(base + path.sep) && full !== base) continue;
    let stat = null;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const ext = path.extname(full).toLowerCase();
    if (!MIME[ext]) continue;                             // unknown type: not served
    return { full, size: stat.size, mime: MIME[ext], mtime: stat.mtime.toUTCString() };
  }
  return null;
}

/** True when the response was handled (file found, sent) - false means 404. */
function serveStatic(req, res, opts) {
  const url = new URL(req.url, 'http://localhost');
  const hit = resolveStatic(url.pathname, opts);
  if (!hit) return false;

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  const head = { 'Content-Type': hit.mime, 'Last-Modified': hit.mtime, 'Accept-Ranges': 'bytes' };

  if (range) {
    // Single range only - enough for a resumable installer download, and the
    // multi-range form is never used by a browser fetching one file.
    let start = range[1] === '' ? hit.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? hit.size - 1 : Number(range[2]);
    start = Math.max(0, Math.min(start, hit.size - 1));
    end = Math.max(start, Math.min(end, hit.size - 1));
    head['Content-Range'] = `bytes ${start}-${end}/${hit.size}`;
    head['Content-Length'] = end - start + 1;
    res.writeHead(206, head);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(hit.full, { start, end }).pipe(res);
    return true;
  }

  head['Content-Length'] = hit.size;
  res.writeHead(200, head);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(hit.full).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {string} [opts.dbFile]      path to the SQLite file
 * @param {boolean} [opts.rateLimit]  false turns the credential limits off (tests)
 * @param {boolean} [opts.static]     false serves the API only (tests)
 */
function createServer(opts = {}) {
  const dbFile = opts.dbFile || path.join(__dirname, 'data', 'apex.db');
  const store = openStore(dbFile);
  const useLimits = opts.rateLimit !== false;
  const withStatic = opts.static !== false;
  const staticOpts = { site: opts.site || SITE, dist: opts.dist || DIST };
  const trustProxy = opts.trustProxy === true;

  // Which origins may read responses cross-origin. Empty by default: the website
  // is served from this same origin, and the launcher sends no Origin header at
  // all, so nothing needs it. Reflecting back whatever a caller sends - with
  // credentials allowed - is the classic way an API ends up readable by any page
  // on the web.
  const allowOrigins = (opts.allowOrigins || [])
    .map((o) => String(o).trim().replace(/\/+$/, ''))
    .filter(Boolean);

  // The cookie has to know whether the request arrived over TLS, so this closes
  // over the trust-proxy setting once instead of at each call site.
  const cookieFor = (req, token, maxAgeSec) => sessionCookie(token, maxAgeSec, isSecureReq(req, { trustProxy }));

  const ipLimit = makeLimiter(40, 10 * 60 * 1000);    // per IP, all /auth traffic
  const userLimit = makeLimiter(10, 15 * 60 * 1000);  // per email, failed logins

  const sweep = setInterval(() => { try { store.sweep(); } catch { /* ignore */ } }, 30 * 60 * 1000);
  sweep.unref();

  const routes = {
    'GET /health': (req, res) => send(res, 200, {
      ok: true, name: NAME, version: VERSION, time: Date.now(), accounts: store.count()
    }),

    'POST /auth/register': async (req, res) => {
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const r = store.createUser(body.value, ctxOf(req));
      if (r.error) return fail(res, 400, r.error);
      send(res, 201, { ok: true, token: r.token, user: r.user }, {
        'Set-Cookie': cookieFor(req, r.token, 30 * 24 * 3600)
      });
    },

    'POST /auth/login': async (req, res) => {
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const email = String((body.value || {}).email || '').trim().toLowerCase();

      if (useLimits) {
        const perEmail = userLimit.peek(email || 'anonymous');
        if (!perEmail.ok) {
          return fail(res, 429, `Too many attempts. Try again in ${Math.ceil(perEmail.retryAfter / 60)} minute(s).`,
            { 'Retry-After': String(perEmail.retryAfter) });
        }
      }

      const r = store.authenticate(body.value, ctxOf(req));
      if (r.error) {
        // Only failures spend the budget, so a forgotten password cannot lock
        // out somebody who signs in correctly on the next try.
        if (useLimits) userLimit.hit(email || 'anonymous');
        return fail(res, 401, r.error);
      }
      if (useLimits) userLimit.clear(email);
      send(res, 200, { ok: true, token: r.token, user: r.user }, {
        'Set-Cookie': cookieFor(req, r.token, 30 * 24 * 3600)
      });
    },

    'POST /auth/logout': (req, res) => {
      store.endSession(tokenOf(req));
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, isSecureReq(req, { trustProxy })) });
    },

    'GET /auth/me': (req, res) => {
      const session = store.resolveSession(tokenOf(req));
      if (!session) return fail(res, 401, 'Not signed in.');
      send(res, 200, { ok: true, user: session.user, events: store.events(session.user.id, 10) });
    },

    'POST /auth/password': async (req, res) => {
      const session = store.resolveSession(tokenOf(req));
      if (!session) return fail(res, 401, 'Not signed in.');
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);

      const { current, next } = body.value || {};
      if (!store.verifyForUser(session.user.id, current)) {
        return fail(res, 400, 'That is not your current password.');
      }
      const r = store.setPassword(session.user.id, next, ctxOf(req));
      if (r.error) return fail(res, 400, r.error);
      // Changing the password ends every session, so hand this one a fresh one.
      const again = store.authenticate({ email: session.user.email, password: next }, ctxOf(req));
      if (again.error) return fail(res, 400, again.error);
      send(res, 200, { ok: true, token: again.token, user: again.user }, {
        'Set-Cookie': cookieFor(req, again.token, 30 * 24 * 3600)
      });
    },

    'GET /profile': (req, res) => {
      const session = store.resolveSession(tokenOf(req));
      if (!session) return fail(res, 401, 'Not signed in.');
      const { profile, updatedAt } = store.getProfile(session.user.id);
      send(res, 200, { ...(profile || {}), syncedAt: (profile && profile.syncedAt) || updatedAt || 0 });
    },

    'PUT /profile': async (req, res) => {
      const session = store.resolveSession(tokenOf(req));
      if (!session) return fail(res, 401, 'Not signed in.');
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const r = store.putProfile(session.user.id, body.value);
      send(res, 200, { ok: true, syncedAt: r.updatedAt });
    }
  };

  function ctxOf(req) {
    return {
      kind: 'launcher',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      ip: clientIp(req, opts)
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    // A HEAD is a GET whose body is thrown away, so it takes the same route. The
    // response helpers already skip the body for HEAD; without this, an uptime
    // monitor or the site's installer size probe would get a 404 from a server
    // that is perfectly healthy.
    const lookup = req.method === 'HEAD' ? route.replace(/^HEAD /, 'GET ') : route;

    // CORS: the launcher is an Electron app (no Origin header), and the website
    // is served from this very origin, so neither of them needs a CORS grant.
    // Only an explicitly allowed origin gets one - see `--allow-origin`, for the
    // case where the site is hosted somewhere other than beside its API.
    const origin = String(req.headers.origin || '').replace(/\/+$/, '');
    if (origin && allowOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600'
      });
      return res.end();
    }

    if (lookup === 'GET /' || lookup === 'GET /index.html') {
      if (!withStatic) return fail(res, 404, 'Not found.');
      if (serveStatic(req, res, staticOpts)) return undefined;
      return fail(res, 404, 'Not found.');
    }

    const handler = routes[lookup];
    if (handler) {
      if (useLimits && route.startsWith('POST /auth/')) {
        const perIp = ipLimit.hit(clientIp(req, opts));
        if (!perIp.ok) {
          return fail(res, 429, 'Too many sign-in attempts from this machine. Try again shortly.',
            { 'Retry-After': String(perIp.retryAfter) });
        }
      }
      try {
        return await handler(req, res);
      } catch (err) {
        // The client gets a generic message; the detail goes to the console,
        // where the person running the server can actually see it.
        console.error(`[apex-server] ${route} failed:`, (err && err.stack) || err);
        return fail(res, 500, 'The server hit an unexpected error.');
      }
    }

    if (withStatic && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, staticOpts)) return undefined;
    return fail(res, 404, 'Not found.');
  });

  server.store = store;
  server.dbFile = dbFile;
  return server;
}

function clientIp(req, opts = {}) {
  if (opts.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'local';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  // Environment first, flags second. A scheduled task or service has no natural
  // place to put a long quoted command line, so the environment is the friendlier
  // way to configure a deployed server; anything on the command line still wins.
  const env = process.env;
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = {
    port: Number(env.APEX_PORT) || 8787,
    host: String(env.APEX_HOST || '').trim() || '127.0.0.1',
    dbFile: String(env.APEX_DB || '').trim() || null,
    trustProxy: /^(1|true|yes)$/i.test(String(env.APEX_TRUST_PROXY || '')),
    allowOrigins: list(env.APEX_ALLOW_ORIGINS)
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--host' || a === '-h') out.host = String(argv[++i] || out.host);
    else if (a === '--db') out.dbFile = String(argv[++i] || '');
    else if (a === '--trust-proxy') out.trustProxy = true;
    else if (a === '--allow-origin') out.allowOrigins = out.allowOrigins.concat(list(argv[++i]));
  }
  return out;
}

function start() {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer(args);
  server.listen(args.port, args.host, () => {
    const shown = args.host === '0.0.0.0' ? 'localhost' : args.host;
    const where = args.host === '0.0.0.0' ? ' (reachable from your network)' : '';
    console.log(`\n  ${NAME} ${VERSION}`);
    console.log(`  website + API   http://${shown}:${args.port}${where}`);
    console.log(`  launcher URL    http://${shown}:${args.port}`);
    console.log(`  database        ${server.dbFile}`);
    console.log(`  accounts        ${server.store.count()}`);
    if (args.trustProxy) {
      console.log('  proxy           trusted (x-forwarded-* honoured; cookies marked Secure over https)');
    }
    if (args.allowOrigins.length) console.log(`  cors origins    ${args.allowOrigins.join(', ')}`);
    console.log('');
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${args.port} is already in use - the server may already be running.\n`);
      process.exit(1);
    }
    console.error(`\n  ${(err && err.message) || err}\n`);
    process.exit(1);
  });

  const stop = () => {
    try { server.store.close(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, resolveStatic, VERSION, NAME };
