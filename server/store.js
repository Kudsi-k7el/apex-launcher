'use strict';

/**
 * Apex Launcher backend - the accounts store.
 * ---------------------------------------------------------------------------
 * A real SQLite database (Node's built-in `node:sqlite`, so the server has no
 * dependencies at all and nothing to `npm install`). One file holds accounts,
 * sessions, the synced profile blob and an audit trail of account events.
 *
 * Three rules shape everything here:
 *
 *   1. Passwords are never stored, only a scrypt digest with a per-user salt.
 *      scrypt is deliberately slow, which is the whole point: an attacker who
 *      walks off with the database still has to pay for every guess.
 *   2. Session tokens are stored hashed. The plaintext token exists exactly
 *      twice - in the response that minted it and in the client that holds it -
 *      so a copy of the database is not a pile of usable logins.
 *   3. Every statement is prepared once. Nothing is ever built by string
 *      concatenation, so there is no quoting bug to find.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// `node:sqlite` is built into Node, which is the whole reason this backend has
// no dependencies - but it only arrived in Node 22.5 and only became usable
// without a flag in Node 24. Saying so plainly beats the ERR_UNKNOWN_BUILTIN_MODULE
// a deployed server would otherwise die with.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  throw new Error(
    `This server needs Node 24 or newer - node:sqlite is not available in ${process.version}. ` +
    'Install the current Node LTS from https://nodejs.org and start the server with that.'
  );
}

// --- password hashing -------------------------------------------------------
// N=2^14 / r=8 / p=1 lands around 50-80 ms on a desktop CPU: slow enough to be
// a real cost per guess, fast enough that signing in still feels instant.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time check. A malformed stored hash is a failed login, not a crash. */
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    const got = crypto.scryptSync(String(password), salt, want.length, { N, r, p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// --- validation -------------------------------------------------------------
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

// Names that would be confusing in the UI (an account called "admin" implies
// powers it does not have) or collide with a route.
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'apex', 'support', 'null', 'undefined', 'me']);

function checkUsername(raw) {
  const name = String(raw || '').trim();
  if (!name) return { error: 'Pick a username.' };
  if (!USERNAME_RE.test(name)) {
    return { error: 'Usernames are 3-24 characters: letters, numbers, dot, dash or underscore.' };
  }
  if (RESERVED.has(name.toLowerCase())) return { error: 'That username is reserved.' };
  return { value: name };
}

function checkEmail(raw) {
  const mail = String(raw || '').trim().toLowerCase();
  if (!mail) return { error: 'Enter your email address.' };
  if (mail.length > 190 || !EMAIL_RE.test(mail)) return { error: 'That email address does not look right.' };
  return { value: mail };
}

function checkPassword(raw) {
  const pw = String(raw == null ? '' : raw);
  if (pw.length < MIN_PASSWORD) return { error: `Use at least ${MIN_PASSWORD} characters for the password.` };
  if (pw.length > MAX_PASSWORD) return { error: 'That password is too long.' };
  return { value: pw };
}

// --- the store --------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  email         TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  display_name  TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL DEFAULT 'launcher',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT    NOT NULL DEFAULT '',
  ip           TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS profiles (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind    TEXT    NOT NULL,
  detail  TEXT    NOT NULL DEFAULT '',
  ip      TEXT    NOT NULL DEFAULT '',
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
`;

const SESSION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Splits SQL into statements, ignoring semicolons that are inside a string or a
 * comment.
 *
 * This exists because `prepare()` silently runs only the first statement of a
 * multi-statement string. Quietly discarding half of what somebody typed in a
 * query box is worse than refusing it, and the refusal needs a real split.
 */
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let quote = null;

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        if (sql[i + 1] === quote) { cur += sql[i + 1]; i += 1; }   // '' inside ''
        else quote = null;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;            // line comment
      cur += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 1;                                                      // block comment
      cur += ' ';
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The admin view of a user. Note what is still absent: password_hash. */
function adminUserRow(r) {
  return {
    id: Number(r.id),
    username: r.username,
    email: r.email,
    displayName: r.display_name || r.username,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastLoginAt: r.last_login_at ? Number(r.last_login_at) : 0,
    disabled: !!r.disabled,
    sessions: r.sessions === undefined ? undefined : Number(r.sessions),
    liveSessions: r.live === undefined ? undefined : Number(r.live),
    eventCount: r.events === undefined ? undefined : Number(r.events)
  };
}

/**
 * A session row, identified by a prefix of its token hash.
 *
 * The full hash is what the database looks sessions up by, so it is left here
 * and only the first 16 characters travel. That is enough to revoke one session
 * and not enough to be a credential (it is a hash to begin with).
 */
function adminSessionRow(r) {
  const hash = String(r.token_hash || '');
  return {
    id: hash.slice(0, 16),
    kind: r.kind,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    expiresAt: Number(r.expires_at),
    userAgent: r.user_agent,
    ip: r.ip,
    user: r.username ? { id: Number(r.user_id), username: r.username, email: r.email } : undefined
  };
}

/** The public shape of a user. Note what is *not* here: no hash, no salt. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name || row.username,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || 0
  };
}

/**
 * Opens (and creates, on first run) the accounts database.
 * Returns an object rather than a class: there is exactly one store, and the
 * server talks to it through these methods.
 */
function openStore(file) {
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 4000;');
  db.exec(SCHEMA);

  const q = {
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    byUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    insertUser: db.prepare(`INSERT INTO users (username, email, display_name, password_hash, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?)`),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'),

    insertSession: db.prepare(`INSERT INTO sessions
      (token_hash, user_id, kind, created_at, last_seen_at, expires_at, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    byToken: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    dropUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sweepSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    getProfile: db.prepare('SELECT data, updated_at FROM profiles WHERE user_id = ?'),
    putProfile: db.prepare(`INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)
                           ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),

    addEvent: db.prepare('INSERT INTO events (user_id, kind, detail, ip, at) VALUES (?, ?, ?, ?, ?)'),
    recentEvents: db.prepare('SELECT kind, detail, ip, at FROM events WHERE user_id = ? ORDER BY at DESC LIMIT ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users')
  };

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------
  // Prepared on first use rather than at startup, and the read-only connection
  // is not opened until somebody actually runs a query. A server with no
  // administrator configured never touches any of this.
  let admin = null;
  function adminQ() {
    if (admin) return admin;
    admin = {
      listUsers: db.prepare(`
        SELECT u.id, u.username, u.email, u.display_name, u.created_at, u.updated_at,
               u.last_login_at, u.disabled,
               (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
               (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS live,
               (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id) AS events
        FROM users u
        WHERE ? = ''
           OR u.username     LIKE ?
           OR u.email        LIKE ?
           OR u.display_name LIKE ?
           OR CAST(u.id AS TEXT) = ?
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`),

      userById: db.prepare('SELECT * FROM users WHERE id = ?'),

      userSessions: db.prepare(`
        SELECT token_hash, kind, created_at, last_seen_at, expires_at, user_agent, ip
        FROM sessions WHERE user_id = ?
        ORDER BY last_seen_at DESC LIMIT 100`),

      liveSessions: db.prepare(`
        SELECT s.token_hash, s.kind, s.created_at, s.last_seen_at, s.expires_at,
               s.user_agent, s.ip, s.user_id, u.username, u.email
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > ?
        ORDER BY s.last_seen_at DESC LIMIT 200`),

      dropByPrefix: db.prepare("DELETE FROM sessions WHERE token_hash LIKE ?"),

      setDisabled: db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?'),
      deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
      profileOf: db.prepare('SELECT data, updated_at FROM profiles WHERE user_id = ?'),

      allEvents: db.prepare(`
        SELECT e.id, e.user_id, e.kind, e.detail, e.ip, e.at, u.username
        FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE ? = '' OR e.kind = ?
        ORDER BY e.at DESC LIMIT ? OFFSET ?`),

      eventKinds: db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC'),

      signupsByDay: db.prepare(`
        SELECT CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n
        FROM users WHERE created_at >= ?
        GROUP BY day ORDER BY day`),

      totals: db.prepare(`
        SELECT (SELECT COUNT(*) FROM users) AS users,
               (SELECT COUNT(*) FROM users WHERE disabled = 1) AS disabled,
               (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS live_sessions,
               (SELECT COUNT(*) FROM sessions) AS sessions,
               (SELECT COUNT(*) FROM events) AS events,
               (SELECT COUNT(*) FROM profiles) AS profiles`)
    };
    return admin;
  }

  /** The connection the SQL console runs on. Opened read-only, once. */
  let roDb = null;
  function readOnlyDb() {
    if (!roDb) roDb = new DatabaseSync(file, { readOnly: true });
    return roDb;
  }

  function log(userId, kind, detail, ip) {
    try { q.addEvent.run(userId == null ? null : userId, kind, String(detail || ''), String(ip || ''), Date.now()); }
    catch { /* an audit line that cannot be written must never fail the request */ }
  }

  /** Mints a session and returns the plaintext token - the only time it exists. */
  function mintSession(userId, { kind = 'launcher', userAgent = '', ip = '' } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    q.insertSession.run(sha256(token), userId, kind, now, now, now + SESSION_DAYS * DAY, userAgent, ip);
    return token;
  }

  return {
    file,
    db,

    count() {
      return q.countUsers.get().n;
    },

    findByEmail(email) {
      return publicUser(q.byEmail.get(String(email || '').trim().toLowerCase()));
    },

    /** Creates an account and signs it in. Throws a friendly error on a clash. */
    createUser({ username, email, password, displayName }, ctx = {}) {
      const name = checkUsername(username);
      if (name.error) return { error: name.error };
      const mail = checkEmail(email);
      if (mail.error) return { error: mail.error };
      const pw = checkPassword(password);
      if (pw.error) return { error: pw.error };

      const now = Date.now();
      let id;
      try {
        id = Number(q.insertUser.run(
          name.value, mail.value, String(displayName || name.value).slice(0, 60),
          hashPassword(pw.value), now, now
        ).lastInsertRowid);
      } catch (err) {
        // The UNIQUE indexes are the authority, not a prior SELECT: two signups
        // racing for the same name must not both win.
        const msg = String((err && err.message) || '');
        if (/users\.email/i.test(msg)) return { error: 'That email address already has an account.' };
        if (/users\.username/i.test(msg)) return { error: 'That username is taken.' };
        return { error: 'Could not create the account.' };
      }

      q.touchLogin.run(now, now, id);
      const token = mintSession(id, ctx);
      log(id, 'signup', `${name.value} <${mail.value}>`, ctx.ip);
      return { user: publicUser(q.byId.get(id)), token };
    },

    /** Verifies a password and mints a session. */
    authenticate({ email, password }, ctx = {}) {
      const row = q.byEmail.get(String(email || '').trim().toLowerCase());
      // One message for "no such account" and "wrong password", so the endpoint
      // cannot be used to test whether an email is registered.
      const bad = { error: 'That email and password do not match an account.' };
      if (!row) return bad;
      if (row.disabled) return { error: 'That account has been disabled.' };
      if (!verifyPassword(password, row.password_hash)) {
        log(row.id, 'login-failed', row.username, ctx.ip);
        return bad;
      }
      const now = Date.now();
      q.touchLogin.run(now, now, row.id);
      const token = mintSession(row.id, ctx);
      log(row.id, 'login', row.username, ctx.ip);
      return { user: publicUser(row), token };
    },

    /**
     * Re-checks a password for an account we are already holding a session for.
     * Used by "change password", where the email in the session is not proof
     * enough on its own.
     */
    verifyForUser(userId, password) {
      const row = q.byId.get(userId);
      if (!row || row.disabled) return false;
      return verifyPassword(password, row.password_hash);
    },

    /** Resolves a bearer token (or session cookie value) to its user. */
    resolveSession(token, { kind = 'launcher' } = {}) {
      const clean = String(token || '').trim();
      if (!clean) return null;
      const hash = sha256(clean);
      const row = q.byToken.get(hash);
      if (!row) return null;
      const now = Date.now();
      if (row.expires_at < now) { q.dropSession.run(hash); return null; }
      const user = q.byId.get(row.user_id);
      if (!user || user.disabled) { q.dropSession.run(hash); return null; }
      // Sliding expiry, but only written once an hour so a busy client does not
      // turn every request into a write.
      if (now - row.last_seen_at > 60 * 60 * 1000) q.touchSession.run(now, hash);
      return { user: publicUser(user), kind: kind || row.kind };
    },

    endSession(token) {
      const clean = String(token || '').trim();
      if (!clean) return false;
      q.dropSession.run(sha256(clean));
      return true;
    },

    /** Changing the password kicks every other session off the account. */
    setPassword(userId, password, ctx = {}) {
      const pw = checkPassword(password);
      if (pw.error) return { error: pw.error };
      const now = Date.now();
      q.setPassword.run(hashPassword(pw.value), now, userId);
      q.dropUserSessions.run(userId);
      log(userId, 'password', 'changed', ctx.ip);
      return { ok: true };
    },

    getProfile(userId) {
      const row = q.getProfile.get(userId);
      if (!row) return { profile: null, updatedAt: 0 };
      let data = null;
      try { data = JSON.parse(row.data); } catch { data = null; }
      return { profile: data, updatedAt: row.updated_at };
    },

    putProfile(userId, data) {
      const now = Date.now();
      q.putProfile.run(userId, JSON.stringify(data == null ? {} : data), now);
      return { ok: true, updatedAt: now };
    },

    events(userId, limit = 20) {
      return q.recentEvents.all(userId, Math.max(1, Math.min(100, limit)));
    },

    /** Housekeeping: expired sessions go, everything else stays. */
    sweep() {
      return q.sweepSessions.run(Date.now()).changes;
    },

    // --- admin ---------------------------------------------------------------
    // Every one of these hands back data with the password hash and the full
    // session hash stripped. Nothing here is reachable without an administrator.

    adminOverview() {
      const a = adminQ();
      const now = Date.now();
      const t = a.totals.get(now);
      return {
        totals: {
          users: Number(t.users),
          disabled: Number(t.disabled),
          liveSessions: Number(t.live_sessions),
          sessions: Number(t.sessions),
          events: Number(t.events),
          profiles: Number(t.profiles)
        },
        signups: a.signupsByDay.all(now - 14 * DAY).map((r) => ({ day: Number(r.day), n: Number(r.n) })),
        eventKinds: a.eventKinds.all().map((r) => ({ kind: r.kind, n: Number(r.n) })),
        now
      };
    },

    adminUsers({ q: term = '', limit = 50, offset = 0 } = {}) {
      const text = String(term || '').trim();
      const like = `%${text}%`;
      return adminQ().listUsers.all(
        Date.now(), text, like, like, like, text,
        Math.max(1, Math.min(200, Number(limit) || 50)),
        Math.max(0, Number(offset) || 0)
      ).map(adminUserRow);
    },

    adminUser(id) {
      const a = adminQ();
      const row = a.userById.get(id);
      if (!row) return null;

      let profile = null;
      const p = a.profileOf.get(id);
      if (p) {
        try { profile = { data: JSON.parse(p.data), updatedAt: Number(p.updated_at) }; }
        catch { profile = { data: null, updatedAt: Number(p.updated_at), note: 'This blob is not valid JSON.' }; }
      }

      return {
        user: adminUserRow(row),
        sessions: a.userSessions.all(id).map(adminSessionRow),
        profile,
        events: q.recentEvents.all(id, 100).map((e) => ({
          kind: e.kind, detail: e.detail, ip: e.ip, at: Number(e.at)
        }))
      };
    },

    adminSessions() {
      return adminQ().liveSessions.all(Date.now()).map(adminSessionRow);
    },

    adminEvents({ kind = '', limit = 100, offset = 0 } = {}) {
      const k = String(kind || '').trim();
      return adminQ().allEvents.all(
        k, k,
        Math.max(1, Math.min(500, Number(limit) || 100)),
        Math.max(0, Number(offset) || 0)
      ).map((r) => ({
        id: Number(r.id),
        userId: r.user_id == null ? null : Number(r.user_id),
        username: r.username || null,
        kind: r.kind,
        detail: r.detail,
        ip: r.ip,
        at: Number(r.at)
      }));
    },

    /** Revokes one session by the prefix the admin console was shown. */
    adminRevoke(prefix, ctx = {}) {
      const clean = String(prefix || '').trim().toLowerCase();
      if (!/^[0-9a-f]{8,64}$/.test(clean)) return { error: 'That session id does not look right.' };
      const n = Number(adminQ().dropByPrefix.run(`${clean}%`).changes);
      log(null, 'admin-revoke', `${n} session(s) revoked by ${ctx.by || 'an administrator'}`, ctx.ip);
      return { ok: true, revoked: n };
    },

    /**
     * Disabling refuses the next sign-in and also drops the account's live
     * sessions, because resolveSession re-checks the flag on every request - so
     * a ban takes effect immediately rather than in thirty days.
     */
    adminSetDisabled(id, disabled, ctx = {}) {
      const row = q.byId.get(id);
      if (!row) return { error: 'No such account.' };
      adminQ().setDisabled.run(disabled ? 1 : 0, Date.now(), id);
      if (disabled) q.dropUserSessions.run(id);
      log(id, disabled ? 'admin-disable' : 'admin-enable', `by ${ctx.by || 'an administrator'}`, ctx.ip);
      return { ok: true, disabled: !!disabled };
    },

    /** Sets a new password without knowing the old one, and signs them out. */
    adminSetPassword(id, password, ctx = {}) {
      const row = q.byId.get(id);
      if (!row) return { error: 'No such account.' };
      const pw = checkPassword(password);
      if (pw.error) return { error: pw.error };
      q.setPassword.run(hashPassword(pw.value), Date.now(), id);
      q.dropUserSessions.run(id);
      log(id, 'admin-password', `reset by ${ctx.by || 'an administrator'}`, ctx.ip);
      return { ok: true, signedOut: true };
    },

    adminDelete(id, ctx = {}) {
      const row = q.byId.get(id);
      if (!row) return { error: 'No such account.' };
      adminQ().deleteUser.run(id);
      // Logged against nobody on purpose. The account is gone, so a line that
      // names it reads better than an event pointing at a dead id.
      log(null, 'admin-delete', `${row.username} <${row.email}> deleted by ${ctx.by || 'an administrator'}`, ctx.ip);
      return { ok: true, deleted: row.username };
    },

    /**
     * Writes one line into the audit log on behalf of the admin console.
     *
     * Used for things that are not a change to an account - running a query, for
     * instance - where the interesting fact is that it happened at all.
     */
    note(kind, detail, ctx = {}) {
      log(null, String(kind || 'admin'), String(detail || '').slice(0, 300), ctx.ip);
      return { ok: true };
    },

    /**
     * One read-only statement, for the console.
     *
     * The connection is opened with SQLite's own read-only flag, so a write is
     * refused by SQLite itself rather than by looking for suspicious words in
     * the text - which is the only version of this that is genuinely safe. The
     * checks below are here to give a better error message, not to be the wall.
     */
    sql(text, { maxRows = 500 } = {}) {
      const parts = splitStatements(String(text || ''));
      if (!parts.length) return { error: 'Type a query first.' };
      if (parts.length > 1) return { error: 'Run one statement at a time.' };

      const src = parts[0];
      const verb = (src.match(/^[a-zA-Z]+/) || [''])[0].toLowerCase();
      const allowed = ['select', 'with', 'pragma', 'explain', 'values'];
      if (!allowed.includes(verb)) {
        return { error: `Only ${allowed.join(', ').toUpperCase()} statements run here.` };
      }
      if (/\b(attach|detach|writable_schema|load_extension)\b/i.test(src)) {
        return { error: 'That is not available here.' };
      }

      try {
        const rows = readOnlyDb().prepare(src).all();
        return {
          ok: true,
          rows: rows.slice(0, maxRows),
          truncated: rows.length > maxRows,
          total: rows.length
        };
      } catch (err) {
        return { error: String((err && err.message) || 'That query failed.').slice(0, 300) };
      }
    },

    close() {
      try { roDb.close(); } catch { /* not opened, or already closed */ }
      try { db.close(); } catch { /* already closed */ }
    }
  };
}

module.exports = { openStore, hashPassword, verifyPassword, checkUsername, checkEmail, checkPassword, publicUser };
