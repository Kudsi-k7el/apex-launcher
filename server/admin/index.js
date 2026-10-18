'use strict';

/**
 * The admin console.
 * ---------------------------------------------------------------------------
 * A second surface on the same server, mounted under `/admin`, that answers
 * questions about the accounts database: who signed up, who is signed in right
 * now, what the server has been asked to do, and - when words are not enough -
 * a read-only SQL console.
 *
 * Three rules shape everything in here.
 *
 *   1. There is no admin password. Access is decided by one thing: is the
 *      email of the session making this request listed in `APEX_ADMIN_EMAIL`?
 *      No separate secret to leak, no second login to forget, and revoking
 *      access is a config edit plus a restart.
 *
 *   2. Nothing is reachable unsigned. The page shell is public - it has to be,
 *      a browser cannot log in without something to log into - but every
 *      `/admin/api/*` route resolves the session first and 401s before it
 *      touches the store. An unknown path under `/admin` is a 404, so the
 *      console does not advertise which routes exist.
 *
 *   3. The password hash never leaves the database. The store hands back
 *      `adminUserRow()`s with the hash and salt already dropped, and the SQL
 *      console runs on a separate connection SQLite itself has opened
 *      read-only, so a `DELETE` is refused by the engine and not by a keyword
 *      filter that could be talked around.
 *
 * When no admin is configured the whole module is inert: `createAdmin` returns
 * null and the server never mounts a route, so `/admin` is an ordinary 404 and
 * there is no code path to reach any of this at all.
 */

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;

/** Files under `server/admin/` that may be served, and the type to serve them as. */
const ASSETS = {
  '/admin': { file: 'ui.html', type: 'text/html; charset=utf-8' },
  '/admin/ui.js': { file: 'ui.js', type: 'text/javascript; charset=utf-8' },
  '/admin/ui.css': { file: 'ui.css', type: 'text/css; charset=utf-8' }
};

// The console is a single self-contained page, so it gets the tightest policy
// that still works: no inline script, no inline style, no framing, no outbound
// requests. Anything the page needs it fetches from this same origin.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

/**
 * @param {object}   deps
 * @param {object}   deps.store      the accounts store
 * @param {string[]} deps.emails     administrator emails, already trusted config
 * @param {function} deps.send       (res, status, body, headers?) -> void
 * @param {function} deps.fail       (res, status, message) -> void
 * @param {function} deps.readJson   (req) -> Promise<{ value } | { error }>
 * @param {function} deps.tokenOf    (req) -> session token
 * @param {function} deps.clientIp   (req) -> client address, proxy-aware
 * @param {string}   [deps.name]
 * @param {string}   [deps.version]
 * @returns {null | { handle(req, res, url): Promise<boolean>, emails: string[] }}
 */
function createAdmin({ store, emails, send, fail, readJson, tokenOf, clientIp, name, version }) {
  const admins = new Set(
    (emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)
  );
  // No administrator in the config means no console. Not a locked door - no
  // door, and no way to tell from outside that there ever was one.
  if (!admins.size) return null;

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  function serveFile(res, file, type) {
    let body;
    try {
      body = fs.readFileSync(path.join(HERE, file));
    } catch {
      // A half-copied deployment should say so plainly rather than hand back an
      // empty 200 that the browser renders as a blank white page.
      return fail(res, 500, `The admin console is missing ${file}.`);
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP
    });
    res.end(body);
  }

  /**
   * Resolves the caller to an administrator.
   *
   * Returns `{ g }` on success, or `{ status, message }` - deliberately shaped
   * so the endpoint can hand the result straight to `fail`.
   */
  function authorize(req) {
    const session = store.resolveSession(tokenOf(req));
    if (!session) return { status: 401, message: 'Sign in first.' };
    const email = String(session.user.email || '').trim().toLowerCase();
    if (!admins.has(email)) {
      return { status: 403, message: 'That account is not an administrator.' };
    }
    return { g: { user: session.user, email } };
  }

  /** What every store call records against its audit line. */
  function ctxOf(g, req) {
    return { by: g.email, ip: clientIp(req) };
  }

  function intOr(value, fallback, min, max) {
    // `Number(null)` is 0, not NaN, so an absent query parameter would quietly
    // become the smallest allowed value - a page size of one. Treat "not given"
    // as "not given" before trusting the number.
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  const api = {
    /** Who am I, and am I allowed in here? The page's first question. */
    'GET /admin/api/whoami': async (req, res, g) => {
      send(res, 200, {
        ok: true,
        admin: { id: g.user.id, username: g.user.username, email: g.user.email },
        server: { name, version, admins: Array.from(admins) }
      });
    },

    'GET /admin/api/overview': async (req, res, g) => {
      const data = store.adminOverview();
      send(res, 200, {
        ok: true,
        ...data,
        database: { file: path.basename(store.file || ''), accounts: store.count() },
        admin: { email: g.email },
        server: { name, version }
      });
    },

    'GET /admin/api/users': async (req, res, g, url) => {
      const term = url.searchParams.get('q') || '';
      const limit = intOr(url.searchParams.get('limit'), 50, 1, 200);
      const offset = intOr(url.searchParams.get('offset'), 0, 0, 1e9);
      const users = store.adminUsers({ q: term, limit, offset });
      send(res, 200, { ok: true, users, limit, offset, q: term });
    },

    'GET /admin/api/users/:id': async (req, res, g, url) => {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id)) return fail(res, 400, 'That account id is not a number.');
      const data = store.adminUser(id);
      if (!data) return fail(res, 404, 'No such account.');
      send(res, 200, { ok: true, ...data });
    },

    'POST /admin/api/users/:id/disabled': async (req, res, g, url) => {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id)) return fail(res, 400, 'That account id is not a number.');

      const target = store.adminUser(id);
      if (!target) return fail(res, 404, 'No such account.');
      // An admin locking themselves - or the other admin - out of the console
      // is never what was meant, so the config owns that decision: take the
      // address out of APEX_ADMIN_EMAIL, do not press this button.
      if (admins.has(String(target.user.email || '').toLowerCase())) {
        return fail(res, 400, 'That account is an administrator. Change APEX_ADMIN_EMAIL instead.');
      }

      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const disabled = !!((body.value || {}).disabled);
      const r = store.adminSetDisabled(id, disabled, ctxOf(g, req));
      if (r.error) return fail(res, 400, r.error);
      send(res, 200, { ok: true, ...r });
    },

    'POST /admin/api/users/:id/password': async (req, res, g, url) => {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id)) return fail(res, 400, 'That account id is not a number.');
      if (!store.adminUser(id)) return fail(res, 404, 'No such account.');

      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const r = store.adminSetPassword(id, (body.value || {}).password, ctxOf(g, req));
      if (r.error) return fail(res, 400, r.error);
      send(res, 200, { ok: true, ...r });
    },

    'POST /admin/api/users/:id/delete': async (req, res, g, url) => {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id)) return fail(res, 400, 'That account id is not a number.');

      const target = store.adminUser(id);
      if (!target) return fail(res, 404, 'No such account.');
      if (admins.has(String(target.user.email || '').toLowerCase())) {
        return fail(res, 400, 'That account is an administrator. Change APEX_ADMIN_EMAIL instead.');
      }

      // Deleting is the one irreversible button here, so the client has to name
      // the account it means. A stray click on a stale row cannot wipe somebody.
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const said = String((body.value || {}).username || '').trim();
      if (said.toLowerCase() !== String(target.user.username || '').toLowerCase()) {
        return fail(res, 400, `Type ${target.user.username} to confirm the delete.`);
      }

      const r = store.adminDelete(id, ctxOf(g, req));
      if (r.error) return fail(res, 400, r.error);
      send(res, 200, { ok: true, ...r });
    },

    'GET /admin/api/sessions': async (req, res) => {
      send(res, 200, { ok: true, sessions: store.adminSessions(), now: Date.now() });
    },

    'POST /admin/api/sessions/revoke': async (req, res, g) => {
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const r = store.adminRevoke((body.value || {}).id, ctxOf(g, req));
      if (r.error) return fail(res, 400, r.error);
      send(res, 200, { ok: true, ...r });
    },

    'GET /admin/api/events': async (req, res, g, url) => {
      const kind = url.searchParams.get('kind') || '';
      const limit = intOr(url.searchParams.get('limit'), 100, 1, 500);
      const offset = intOr(url.searchParams.get('offset'), 0, 0, 1e9);
      send(res, 200, {
        ok: true,
        events: store.adminEvents({ kind, limit, offset }),
        kind, limit, offset
      });
    },

    'POST /admin/api/sql': async (req, res, g) => {
      const body = await readJson(req);
      if (body.error) return fail(res, 400, body.error);
      const r = store.sql((body.value || {}).sql);
      // One line per attempt, failures included: what was run and whether it
      // worked is exactly the sort of thing an audit log exists to remember.
      store.note('admin-sql', `${(body.value || {}).sql || ''}`.replace(/\s+/g, ' ').slice(0, 200)
        + (r.error ? ' -- refused' : ` -- ${r.total} row(s)`), ctxOf(g, req));
      if (r.error) return fail(res, 400, r.error);
      send(res, 200, { ok: true, ...r });
    }
  };

  // `GET /admin/api/users/:id` and `POST /admin/api/users/:id/<action>` carry a
  // variable segment, so the table above cannot be a plain dictionary lookup the
  // way the main server's routes are.
  const USER_ONE = /^\/admin\/api\/users\/(\d+)$/;
  const USER_ACTION = /^\/admin\/api\/users\/(\d+)\/(disabled|password|delete)$/;

  /**
   * @returns {Promise<boolean>} true when this module answered the request.
   *   A false means "not mine", and the caller falls through to the site.
   */
  async function handle(req, res, url) {
    let pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '') || '/';

    // The page shell. Public on purpose: every byte of data it shows arrives
    // from an /admin/api route that checks the session first.
    const asset = ASSETS[pathname];
    if (asset) {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': CSP
        });
        res.end();
        return true;
      }
      if (req.method !== 'GET') {
        fail(res, 405, 'That is a GET.');
        return true;
      }
      serveFile(res, asset.file, asset.type);
      return true;
    }

    const action = USER_ACTION.exec(pathname);
    const single = action ? null : USER_ONE.exec(pathname);
    const lookup = action
      ? `${req.method} /admin/api/users/:id/${action[2]}`
      : (single && req.method === 'GET' ? 'GET /admin/api/users/:id' : `${req.method} ${pathname}`);
    if (action) url.searchParams.set('id', action[1]);
    else if (single) url.searchParams.set('id', single[1]);

    const handler = api[lookup];
    if (!handler) {
      // Anything else under /admin is simply not there. Same answer whether the
      // path is a typo or a route that exists but not for this verb, so probing
      // teaches nothing.
      if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        fail(res, 404, 'Not found.');
        return true;
      }
      return false;
    }

    const gate = authorize(req);
    if (!gate.g) {
      fail(res, gate.status, gate.message);
      return true;
    }

    try {
      await handler(req, res, gate.g, url);
    } catch (err) {
      console.error(`[apex-admin] ${lookup} failed:`, (err && err.stack) || err);
      if (!res.headersSent) fail(res, 500, 'The admin console hit an unexpected error.');
    }
    return true;
  }

  return { handle, emails: Array.from(admins), name, version };
}

module.exports = { createAdmin, CSP };
