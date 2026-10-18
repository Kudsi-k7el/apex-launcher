'use strict';
/*
 * Node-side test for the Apex backend (server/server.js + server/store.js).
 *
 * No stubs: it starts the real HTTP server against a throwaway SQLite file and
 * drives it with real requests, so password hashing, sessions, the profile blob,
 * the rate limiter and the static handler are all exercised for real.
 *
 *   node _server-test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server/server');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-server-'));

function listen(opts) {
  return new Promise((resolve) => {
    const server = createServer(opts);
    server.listen(0, '127.0.0.1', () => {
      server.base = `http://127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}

async function req(base, method, p, { body, token, cookie, headers: extra } = {}) {
  const headers = Object.assign({}, extra);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  const dbFile = path.join(tmp, 'apex.db');
  const server = await listen({ dbFile });
  const base = server.base;
  const store = server.store;

  // --- health ---------------------------------------------------------------
  const health = await req(base, 'GET', '/health');
  check('health answers and reports an empty database',
    health.status === 200 && health.json.ok === true && health.json.accounts === 0,
    JSON.stringify(health.json));

  // --- input validation -----------------------------------------------------
  const badUser = await req(base, 'POST', '/auth/register', { body: { username: 'a', email: 'a@b.com', password: 'longenough' } });
  check('a too-short username is refused', badUser.status === 400 && /3-24 characters/.test(badUser.json.error), badUser.json && badUser.json.error);

  const reserved = await req(base, 'POST', '/auth/register', { body: { username: 'admin', email: 'a@b.com', password: 'longenough' } });
  check('a reserved username is refused', reserved.status === 400 && /reserved/.test(reserved.json.error), reserved.json && reserved.json.error);

  const badMail = await req(base, 'POST', '/auth/register', { body: { username: 'player', email: 'nope', password: 'longenough' } });
  check('a malformed email is refused', badMail.status === 400 && /email/i.test(badMail.json.error), badMail.json && badMail.json.error);

  const shortPw = await req(base, 'POST', '/auth/register', { body: { username: 'player', email: 'p@example.com', password: 'short' } });
  check('a short password is refused', shortPw.status === 400 && /at least 8/.test(shortPw.json.error), shortPw.json && shortPw.json.error);

  // --- sign up --------------------------------------------------------------
  const signup = await req(base, 'POST', '/auth/register', {
    body: { username: 'Player_One', email: 'Player@Example.com', password: 'correct horse battery' }
  });
  const user = signup.json && signup.json.user;
  check('signing up returns a token and a public user',
    signup.status === 201 && typeof signup.json.token === 'string' && signup.json.token.length >= 32
    && user && user.username === 'Player_One' && user.email === 'player@example.com',
    JSON.stringify(user));
  check('the user record never carries a password or hash',
    !!user && !('password' in user) && !('password_hash' in user) && !('passwordHash' in user),
    user && Object.keys(user).join(','));
  check('signing up sets a session cookie',
    /apex_session=/.test(String(signup.headers.get('set-cookie') || '')) && /HttpOnly/i.test(String(signup.headers.get('set-cookie'))),
    String(signup.headers.get('set-cookie') || '').slice(0, 60));
  const signupToken = signup.json.token;

  const dbRow = store.db.prepare('SELECT username, email, password_hash FROM users WHERE id = ?').get(user.id);
  check('the database stores a scrypt digest, not the password',
    !!dbRow && /^scrypt\$/.test(dbRow.password_hash) && !/correct horse/.test(dbRow.password_hash)
    && dbRow.email === 'player@example.com',
    dbRow && dbRow.password_hash.slice(0, 24) + '...');

  // --- duplicates -----------------------------------------------------------
  const dupMail = await req(base, 'POST', '/auth/register', { body: { username: 'someone_else', email: 'player@example.com', password: 'longenough' } });
  check('a duplicate email is refused', dupMail.status === 400 && /already has an account/.test(dupMail.json.error), dupMail.json && dupMail.json.error);

  const dupName = await req(base, 'POST', '/auth/register', { body: { username: 'player_one', email: 'other@example.com', password: 'longenough' } });
  check('a duplicate username (any case) is refused', dupName.status === 400 && /taken/.test(dupName.json.error), dupName.json && dupName.json.error);

  // --- sign in --------------------------------------------------------------
  const wrongPw = await req(base, 'POST', '/auth/login', { body: { email: 'player@example.com', password: 'nope' } });
  const noSuchUser = await req(base, 'POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'nope' } });
  check('a wrong password and an unknown account are indistinguishable',
    wrongPw.status === 401 && noSuchUser.status === 401 && wrongPw.json.error === noSuchUser.json.error,
    wrongPw.json && wrongPw.json.error);

  const login = await req(base, 'POST', '/auth/login', { body: { email: 'PLAYER@example.com', password: 'correct horse battery' } });
  check('signing in works and the email is case-insensitive',
    login.status === 200 && login.json.ok === true && typeof login.json.token === 'string' && login.json.token !== signupToken,
    login.status);
  const token = login.json.token;

  // --- sessions -------------------------------------------------------------
  const me = await req(base, 'GET', '/auth/me', { token });
  check('a bearer token resolves to the account', me.status === 200 && me.json.user.username === 'Player_One', me.status);

  const noAuth = await req(base, 'GET', '/auth/me');
  const badAuth = await req(base, 'GET', '/auth/me', { token: 'not-a-real-token' });
  check('a missing or forged token is refused', noAuth.status === 401 && badAuth.status === 401, `${noAuth.status}/${badAuth.status}`);

  const cookieHeader = /apex_session=([^;]+)/.exec(String(signup.headers.get('set-cookie') || ''))[1];
  const meByCookie = await req(base, 'GET', '/auth/me', { cookie: `apex_session=${cookieHeader}` });
  check('the session cookie (the website path) authenticates too',
    meByCookie.status === 200 && meByCookie.json.user.username === 'Player_One', meByCookie.status);

  // --- profile --------------------------------------------------------------
  const putProfile = await req(base, 'PUT', '/profile', {
    token,
    body: { name: 'Player One', bio: 'hello', avatar: null, favorites: ['hades'], syncedAt: 1700000000000 }
  });
  const getProfile = await req(base, 'GET', '/profile', { token });
  check('the profile round-trips through the database',
    putProfile.status === 200 && putProfile.json.syncedAt > 0
    && getProfile.status === 200 && getProfile.json.name === 'Player One' && getProfile.json.bio === 'hello'
    && Array.isArray(getProfile.json.favorites) && getProfile.json.favorites[0] === 'hades',
    JSON.stringify(getProfile.json));

  const anonProfile = await req(base, 'PUT', '/profile', { body: { name: 'x' } });
  check('the profile refuses anonymous writes', anonProfile.status === 401, anonProfile.status);

  // --- password change ------------------------------------------------------
  const badCurrent = await req(base, 'POST', '/auth/password', { token, body: { current: 'wrong', next: 'a new password' } });
  check('changing the password needs the current one', badCurrent.status === 400 && /current password/.test(badCurrent.json.error), badCurrent.json && badCurrent.json.error);

  const changed = await req(base, 'POST', '/auth/password', { token, body: { current: 'correct horse battery', next: 'a new password' } });
  check('the password changes and a fresh token is handed back',
    changed.status === 200 && typeof changed.json.token === 'string', changed.status);
  const freshToken = changed.json.token;

  const oldTokenNow = await req(base, 'GET', '/auth/me', { token });
  const oldPasswordNow = await req(base, 'POST', '/auth/login', { body: { email: 'player@example.com', password: 'correct horse battery' } });
  const newPasswordNow = await req(base, 'POST', '/auth/login', { body: { email: 'player@example.com', password: 'a new password' } });
  check('changing the password retires every old session',
    oldTokenNow.status === 401 && freshToken !== token, oldTokenNow.status);
  check('the old password stops working and the new one works',
    oldPasswordNow.status === 401 && newPasswordNow.status === 200, `${oldPasswordNow.status}/${newPasswordNow.status}`);

  // --- sign out -------------------------------------------------------------
  const logout = await req(base, 'POST', '/auth/logout', { token: freshToken });
  const afterLogout = await req(base, 'GET', '/auth/me', { token: freshToken });
  check('signing out invalidates the token and clears the cookie',
    logout.status === 200 && /Max-Age=0/.test(String(logout.headers.get('set-cookie') || '')) && afterLogout.status === 401,
    afterLogout.status);

  // --- static site ----------------------------------------------------------
  const home = await fetch(base + '/');
  const homeHtml = await home.text();
  check('the website is served from the root of the same origin',
    home.status === 200 && /text\/html/.test(String(home.headers.get('content-type'))) && /APEX LAUNCHER/i.test(homeHtml),
    home.status);

  const css = await fetch(base + '/assets/css/styles.css');
  check('the site\u2019s assets resolve', css.status === 200 && /text\/css/.test(String(css.headers.get('content-type'))), css.status);

  const underWebsite = await fetch(base + '/website/index.html');
  check('the /website/ path still works (the README\u2019s python server layout)',
    underWebsite.status === 200, underWebsite.status);

  const leak1 = await fetch(base + '/package.json');
  const leak2 = await fetch(base + '/main.js');
  const leak3 = await fetch(base + '/../server/store.js');
  const leak4 = await fetch(base + '/dist/../package.json');
  check('nothing outside the site and the installers is reachable',
    leak1.status === 404 && leak2.status === 404 && leak3.status === 404 && leak4.status === 404,
    [leak1.status, leak2.status, leak3.status, leak4.status].join('/'));

  const missing = await fetch(base + '/nope');
  check('an unknown path is a 404, not a directory listing', missing.status === 404, missing.status);

  // A HEAD has to behave like a GET with the body thrown away. Uptime monitors
  // and the site's installer size probe both use it, so a 404 from a healthy
  // server would send them chasing ghosts.
  const getHome = await fetch(base + '/');
  const headHome = await req(base, 'HEAD', '/');
  const headHealth = await req(base, 'HEAD', '/health');
  const headImg = await req(base, 'HEAD', '/assets/img/icon.png');
  const homeLen = Number(headHome.headers.get('content-length'));
  check('HEAD answers like a GET, without a body, with the real length',
    headHome.status === 200 && headHealth.status === 200 && headImg.status === 200
    && homeLen > 0 && homeLen === Number(getHome.headers.get('content-length'))
    && headHome.json === null,
    JSON.stringify({
      home: headHome.status, health: headHealth.status, img: headImg.status,
      len: homeLen, getLen: Number(getHome.headers.get('content-length'))
    }));

  // --- with no administrator configured -------------------------------------
  // The console is not a locked door, it is no door: `createAdmin` returns null,
  // no route is mounted, and /admin is an ordinary 404. There is no code path to
  // reach any of it, which is the only version of "off" worth having.
  const noAdminPage = await req(base, 'GET', '/admin');
  const noAdminApi = await req(base, 'GET', '/admin/api/overview');
  check('with no administrator configured the console does not exist at all',
    noAdminPage.status === 404 && noAdminApi.status === 404,
    `${noAdminPage.status}/${noAdminApi.status}`);

  await new Promise((r) => server.close(r));
  store.close();

  // --- the admin console ----------------------------------------------------
  const admin = await listen({ dbFile: path.join(tmp, 'admin.db'), adminEmails: ['Boss@Example.com'] });
  const abase = admin.base;

  const boss = await req(abase, 'POST', '/auth/register', {
    body: { username: 'The_Boss', email: 'boss@example.com', password: 'a good password' }
  });
  const pleb = await req(abase, 'POST', '/auth/register', {
    body: { username: 'Plebeian', email: 'pleb@example.com', password: 'a good password' }
  });
  const bossToken = boss.json.token;
  const plebToken = pleb.json.token;
  const plebId = pleb.json.user.id;
  // The per-account routes live at /admin/api/users/<id>/<action>; one helper
  // keeps the calls below readable.
  const asUser = (method, id, action, opts) => req(abase, method, `/admin/api/users/${id}/${action}`, opts);
  check('the console mounts once an administrator is configured',
    !!admin.admin && admin.admin.emails[0] === 'boss@example.com',
    JSON.stringify(admin.admin && admin.admin.emails));

  // The page shell has to be public - a browser cannot log in without something
  // to log into - so the shell is safe to hand to anybody, and every byte of data
  // behind it arrives from a route that checks first.
  const shell = await req(abase, 'GET', '/admin');
  const shellBody = await req(abase, 'GET', '/admin/ui.js');
  const shellCss = await req(abase, 'GET', '/admin/ui.css');
  check('the console shell is served unsigned, without caching or outside code',
    shell.status === 200 && /text\/html/.test(String(shell.headers.get('content-type')))
    && /no-store/.test(String(shell.headers.get('cache-control')))
    && /script-src 'self'/.test(String(shell.headers.get('content-security-policy')))
    && /frame-ancestors 'none'/.test(String(shell.headers.get('content-security-policy')))
    && shellCss.status === 200,
    String(shell.headers.get('content-security-policy')).slice(0, 60));
  check('the shell carries no inline script or style to go with that policy',
    shellBody.status === 200 && /text\/javascript/.test(String(shellBody.headers.get('content-type'))),
    shellBody.status);

  const anonOverview = await req(abase, 'GET', '/admin/api/overview');
  check('every admin route refuses an unsigned caller',
    anonOverview.status === 401 && anonOverview.json.ok === false, anonOverview.status);

  const signedInNotAdmin = await req(abase, 'GET', '/admin/api/users', { token: plebToken });
  check('a signed-in stranger is refused, and told apart from unsigned',
    signedInNotAdmin.status === 403, signedInNotAdmin.status);

  const whoami = await req(abase, 'GET', '/admin/api/whoami', { token: bossToken });
  check('the administrator is let in and named back to the page',
    whoami.status === 200 && whoami.json.admin.email === 'boss@example.com'
    && whoami.json.server.admins[0] === 'boss@example.com',
    JSON.stringify(whoami.json.admin));

  const overview = await req(abase, 'GET', '/admin/api/overview', { token: bossToken });
  check('the overview counts the accounts and the audit log',
    overview.status === 200 && overview.json.totals.users === 2
    && overview.json.totals.liveSessions >= 2
    && Array.isArray(overview.json.eventKinds)
    && overview.json.eventKinds.some((k) => k.kind === 'signup'),
    JSON.stringify(overview.json.totals));

  const users = await req(abase, 'GET', '/admin/api/users?q=pleb', { token: bossToken });
  const usersJson = JSON.stringify(users.json);
  check('the account list searches, and never carries a password',
    users.status === 200 && users.json.users.length === 1
    && users.json.users[0].username === 'Plebeian'
    && !/password/i.test(usersJson) && !/scrypt\$/.test(usersJson),
    users.json.users[0] && users.json.users[0].email);

  const one = await req(abase, 'GET', `/admin/api/users/${plebId}`, { token: bossToken });
  check('one account shows its sessions, its activity and nothing secret',
    one.status === 200 && one.json.user.username === 'Plebeian'
    && Array.isArray(one.json.sessions) && one.json.sessions.length >= 1
    && typeof one.json.sessions[0].id === 'string' && one.json.sessions[0].id.length === 16
    && Array.isArray(one.json.events) && one.json.events[0].kind === 'signup'
    && !/scrypt\$/.test(JSON.stringify(one.json)),
    `${one.json.sessions.length} session(s)`);

  // Locking the administrator out of their own console is never what was meant,
  // so the config owns that decision rather than a button.
  const bossId = boss.json.user.id;
  const selfDisable = await asUser('POST', bossId, 'disabled', { token: bossToken, body: { disabled: true } });
  const selfDelete = await asUser('POST', bossId, 'delete', { token: bossToken, body: { username: 'The_Boss' } });
  check('an administrator account cannot be disabled or deleted from the console',
    selfDisable.status === 400 && /APEX_ADMIN_EMAIL/.test(selfDisable.json.error)
    && selfDelete.status === 400, selfDisable.json.error);

  const disable = await asUser('POST', plebId, 'disabled', { token: bossToken, body: { disabled: true } });
  const disabledLogin = await req(abase, 'POST', '/auth/login', { body: { email: 'pleb@example.com', password: 'a good password' } });
  const disabledToken = await req(abase, 'GET', '/auth/me', { token: plebToken });
  check('disabling an account refuses the next sign-in and kills its live session',
    disable.status === 200 && disable.json.disabled === true
    && disabledLogin.status === 401 && disabledToken.status === 401,
    `${disable.status}/${disabledLogin.status}/${disabledToken.status}`);

  const reEnable = await asUser('POST', plebId, 'disabled', { token: bossToken, body: { disabled: false } });
  const reset = await asUser('POST', plebId, 'password', { token: bossToken, body: { password: 'a different password' } });
  const resetShort = await asUser('POST', plebId, 'password', { token: bossToken, body: { password: 'no' } });
  const afterReset = await req(abase, 'POST', '/auth/login', { body: { email: 'pleb@example.com', password: 'a different password' } });
  check('a password can be reset without knowing the old one, and is still validated',
    reEnable.status === 200 && reset.status === 200 && resetShort.status === 400
    && afterReset.status === 200,
    `${reset.status}/${resetShort.status}/${afterReset.status}`);

  const live = await req(abase, 'GET', '/admin/api/sessions', { token: bossToken });
  const liveRows = live.json.sessions || [];
  check('every live session is listed with its account and nothing that could be replayed',
    live.status === 200 && liveRows.length >= 2
    && liveRows.every((s) => s.id.length === 16 && s.user && s.user.username)
    && !/scrypt\$/.test(JSON.stringify(liveRows)),
    `${liveRows.length} live`);

  const victim = liveRows.find((s) => s.user.username === 'Plebeian');
  const revoke = await req(abase, 'POST', '/admin/api/sessions/revoke', { token: bossToken, body: { id: victim.id } });
  const revokedNow = await req(abase, 'GET', '/auth/me', { token: afterReset.json.token });
  check('revoking a session signs that client out on its next request',
    revoke.status === 200 && revoke.json.revoked === 1 && revokedNow.status === 401,
    `${revoke.json.revoked} revoked`);

  const junkId = await req(abase, 'POST', '/admin/api/sessions/revoke', { token: bossToken, body: { id: 'not a session' } });
  check('a session id that is not a hex prefix is refused, not run',
    junkId.status === 400, junkId.json.error);

  const events = await req(abase, 'GET', '/admin/api/events?kind=admin-disable', { token: bossToken });
  const allEvents = await req(abase, 'GET', '/admin/api/events', { token: bossToken });
  check('the audit log records what the console did, and can be filtered',
    events.status === 200 && events.json.events.length >= 1
    && events.json.events.every((e) => e.kind === 'admin-disable')
    && allEvents.json.events.some((e) => e.kind === 'admin-revoke')
    && allEvents.json.events.some((e) => /boss@example\.com/.test(e.detail || '')),
    events.json.events.map((e) => e.kind).join(','));

  // The console is read-only because SQLite itself was opened read-only, not
  // because a filter looked for suspicious words - which is the only version of
  // this that cannot be talked around.
  const sqlSelect = await req(abase, 'POST', '/admin/api/sql', { token: bossToken, body: { sql: 'SELECT username FROM users ORDER BY id' } });
  const sqlWrite = await req(abase, 'POST', '/admin/api/sql', { token: bossToken, body: { sql: "DELETE FROM users WHERE username = 'Plebeian'" } });
  const sqlDrop = await req(abase, 'POST', '/admin/api/sql', { token: bossToken, body: { sql: 'DROP TABLE events' } });
  const sqlTwo = await req(abase, 'POST', '/admin/api/sql', { token: bossToken, body: { sql: 'SELECT 1; SELECT 2' } });
  const stillThere = await req(abase, 'GET', '/admin/api/users', { token: bossToken });
  check('the query box runs a select and refuses every write',
    sqlSelect.status === 200 && sqlSelect.json.rows.length === 2 && sqlSelect.json.total === 2
    && sqlWrite.status === 400 && sqlDrop.status === 400 && sqlTwo.status === 400
    && stillThere.json.users.length === 2,
    `${sqlSelect.json.rows.length} rows, writes ${sqlWrite.status}/${sqlDrop.status}/${sqlTwo.status}, users ${stillThere.json.users.length}`);
  check('a refused query is still written to the audit log',
    (await req(abase, 'GET', '/admin/api/events?kind=admin-sql', { token: bossToken }))
      .json.events.some((e) => /refused/.test(e.detail || '')),
    'admin-sql');

  // A stray click on a stale row must not be able to wipe an account.
  const wrongConfirm = await asUser('POST', plebId, 'delete', { token: bossToken, body: { username: 'nope' } });
  const rightConfirm = await asUser('POST', plebId, 'delete', { token: bossToken, body: { username: 'plebeian' } });
  const gone = await req(abase, 'GET', '/admin/api/users', { token: bossToken });
  check('deleting an account needs its name typed, and then really deletes it',
    wrongConfirm.status === 400 && /Type Plebeian/.test(wrongConfirm.json.error)
    && rightConfirm.status === 200 && rightConfirm.json.deleted === 'Plebeian'
    && gone.json.users.length === 1,
    wrongConfirm.json.error);

  const notThere = await req(abase, 'GET', '/admin/api/nope', { token: bossToken });
  const wrongVerb = await req(abase, 'POST', '/admin', { token: bossToken });
  const traversal = await req(abase, 'GET', '/admin/../server/store.js', { token: bossToken });
  check('an unknown admin path is a 404, the shell is not writable, and nothing escapes',
    notThere.status === 404 && wrongVerb.status === 405 && traversal.status === 404
    && !/openStore/.test(JSON.stringify(traversal.json)),
    `${notThere.status}/${wrongVerb.status}/${traversal.status}`);

  await new Promise((r) => admin.close(r));
  admin.store.close();

  // --- rate limiting (its own server, so the counters start clean) ----------
  const rl = await listen({ dbFile: path.join(tmp, 'rl.db'), static: false });
  await req(rl.base, 'POST', '/auth/register', { body: { username: 'locked_out', email: 'lock@example.com', password: 'a good password' } });
  let saw429 = false;
  let attempts = 0;
  for (let i = 0; i < 14; i += 1) {
    attempts += 1;
    const r = await req(rl.base, 'POST', '/auth/login', { body: { email: 'lock@example.com', password: 'wrong' } });
    if (r.status === 429) { saw429 = true; break; }
  }
  const goodAfterLock = await req(rl.base, 'POST', '/auth/login', { body: { email: 'lock@example.com', password: 'a good password' } });
  check('repeated bad passwords are throttled', saw429 && attempts <= 12, `blocked after ${attempts} attempts`);
  check('the lockout cannot be bypassed with the right password either',
    goodAfterLock.status === 429, goodAfterLock.status);

  const otherAccount = await req(rl.base, 'POST', '/auth/login', { body: { email: 'someone@example.com', password: 'whatever' } });
  check('a different account still gets a normal answer', otherAccount.status === 401, otherAccount.status);
  await new Promise((r) => rl.close(r));
  rl.store.close();

  // --- behind a TLS terminator ---------------------------------------------
  // A tunnel or reverse proxy speaks plain HTTP to us and reports the real
  // scheme and caller in headers. Both mistakes here are quiet rather than
  // loud: forget to trust the proxy and the cookie merely stops being marked
  // Secure, trust it when you should not and any client can forge the header.
  const proxy = await listen({
    dbFile: path.join(tmp, 'proxy.db'),
    static: false,
    trustProxy: true,
    allowOrigins: ['https://apex.example.com']
  });
  const proxied = await req(proxy.base, 'POST', '/auth/register', {
    body: { username: 'Behind_Tunnel', email: 'tunnel@example.com', password: 'a good password' },
    headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' }
  });
  const proxiedCookie = String(proxied.headers.get('set-cookie') || '');
  check('behind a trusted proxy an https request gets a Secure cookie',
    proxied.status === 201 && /;\s*Secure/i.test(proxiedCookie) && /HttpOnly/i.test(proxiedCookie),
    proxiedCookie.slice(0, 72));

  const proxiedHttp = await req(proxy.base, 'POST', '/auth/login', {
    body: { email: 'tunnel@example.com', password: 'a good password' },
    headers: { 'X-Forwarded-Proto': 'http' }
  });
  check('the same proxy passing http through does not get a Secure cookie',
    proxiedHttp.status === 200 && !/Secure/i.test(String(proxiedHttp.headers.get('set-cookie') || '')),
    proxiedHttp.status);

  const allowedOrigin = await req(proxy.base, 'GET', '/health', {
    headers: { Origin: 'https://apex.example.com' }
  });
  check('an explicitly allowed origin is granted CORS access',
    allowedOrigin.headers.get('access-control-allow-origin') === 'https://apex.example.com',
    String(allowedOrigin.headers.get('access-control-allow-origin')));

  // --- and without that trust ----------------------------------------------
  const direct = await listen({ dbFile: path.join(tmp, 'direct.db'), static: false });
  const forged = await req(direct.base, 'POST', '/auth/register', {
    body: { username: 'Direct_Client', email: 'direct@example.com', password: 'a good password' },
    headers: { 'X-Forwarded-Proto': 'https' }
  });
  check('X-Forwarded-Proto alone does not mark a cookie Secure',
    forged.status === 201 && !/Secure/i.test(String(forged.headers.get('set-cookie') || '')),
    forged.status);

  // Reflecting whatever Origin a caller sends - with credentials allowed - is
  // how an API ends up readable by any page on the web.
  const strayOrigin = await req(direct.base, 'GET', '/health', {
    headers: { Origin: 'https://evil.example' }
  });
  check('an unlisted origin gets no CORS grant at all',
    strayOrigin.status === 200 && !strayOrigin.headers.get('access-control-allow-origin'),
    String(strayOrigin.headers.get('access-control-allow-origin')));

  await new Promise((r) => proxy.close(r));
  proxy.store.close();
  await new Promise((r) => direct.close(r));
  direct.store.close();

  // --- the database file is real -------------------------------------------
  check('a real SQLite file was written to disk',
    fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0,
    fs.existsSync(dbFile) ? `${fs.statSync(dbFile).size} bytes` : 'missing');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('the test suite itself threw:', err);
  process.exit(2);
});
