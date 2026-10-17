'use strict';
/*
 * End-to-end check of the sign-in gate.
 *
 * _smoke.js deliberately disarms the gate (its file is recognised by name in
 * main.js) so it can drive the rest of the renderer. This harness does the
 * opposite: it boots exactly like a fresh install - armed, pointed at a
 * throwaway server - and presses the gate's own buttons. Nothing here is stubbed
 * except the native confirm() behind the escape hatch, which would otherwise
 * block the renderer on a real dialog.
 *
 * Run in two phases against the same temporary userData:
 *   APEX_GATE_TMP=... APEX_GATE_PORT=8896 electron _gate-check.js
 *   APEX_GATE_PHASE=2 APEX_GATE_TMP=... APEX_GATE_PORT=8896 electron _gate-check.js
 * The second phase answers the question that matters most for a real launch: is
 * the session restored from the state file, with a server that has restarted in
 * between?
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');

const HERE = __dirname;
const PHASE = String(process.env.APEX_GATE_PHASE || '1');
const PORT = Number(process.env.APEX_GATE_PORT || 8896);
const tmp = process.env.APEX_GATE_TMP || path.join(os.tmpdir(), `apex-gate-${Date.now()}`);
const userData = path.join(tmp, 'userData');
const DB = path.join(tmp, 'gate.db');
const STATE = path.join(userData, 'apex-state.json');
fs.mkdirSync(userData, { recursive: true });

const USER = 'gatecheck';
const EMAIL = 'gate@example.com';
const PASS = 'a good password';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

(async () => {
  // The backend runs under real system Node: the app does the same, for the same
  // reason - `node:sqlite` does not exist inside Electron's runtime.
  const server = spawn('node', [path.join(HERE, 'server', 'server.js'), '--port', String(PORT), '--db', DB], { stdio: 'ignore' });
  const up = await waitForServer();
  if (!up) { console.log(`the throwaway server never came up on ${PORT}`); process.exit(2); }

  if (PHASE === '1') {
    // Exactly what a fresh install looks like: armed, pointed at our server, no
    // session yet.
    fs.writeFileSync(STATE, JSON.stringify({
      settings: {
        api: { baseUrl: `http://127.0.0.1:${PORT}`, token: '', email: '', name: '' },
        auth: { required: true }
      }
    }, null, 2), 'utf8');
  }

  app.setPath('userData', userData);
  require(path.join(HERE, 'main.js'));

  app.whenReady().then(async () => {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('no window was created'); if (results.length) console.log(`\n${results.filter((r) => r.ok).length}/${results.length} assertions passed`); process.exit(2); }
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) console.log('  [renderer error]', message);
    });

    // ---------------------------------------------------------------- phase 1
    if (PHASE === '1') {
      const boot = await js(`
        const g = document.getElementById('auth-gate');
        return {
          shown: !!g && !g.hidden,
          locked: document.body.classList.contains('auth-locked'),
          isLocked: AuthGate.isLocked(),
          upVisible: !document.getElementById('ag-form-up').hidden,
          inVisible: !document.getElementById('ag-form-in').hidden,
          upTab: document.querySelector('[data-ag-tab="up"]').getAttribute('aria-selected'),
          url: document.getElementById('ag-url').value,
          bodyOverflow: getComputedStyle(document.body).overflow
        };`);
      check('an armed launcher starts behind the gate, not in front of it',
        boot.shown && boot.locked && boot.isLocked, JSON.stringify(boot));
      check('a brand-new install is offered the create-account form first',
        boot.upVisible && !boot.inVisible && boot.upTab === 'true', JSON.stringify(boot));
      check('the gate shows the configured server, and the shell cannot scroll behind it',
        /127\.0\.0\.1:/.test(boot.url) && boot.bodyOverflow === 'hidden', `${boot.url} / ${boot.bodyOverflow}`);

      const esc = await js(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 80));
        return { hidden: document.getElementById('auth-gate').hidden, locked: AuthGate.isLocked() };`);
      check('Escape and the app shortcuts cannot get past the gate',
        !esc.hidden && esc.locked, JSON.stringify(esc));

      const created = await js(`
        const set = (id, v) => { document.getElementById(id).value = v; };
        set('ag-up-user', '${USER}');
        set('ag-up-email', '${EMAIL}');
        set('ag-up-pass', '${PASS}');
        set('ag-up-pass2', '${PASS}');
        document.getElementById('ag-form-up').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        for (let i = 0; i < 50; i += 1) {
          await new Promise(r => setTimeout(r, 200));
          if (document.getElementById('auth-gate').hidden) break;
        }
        const st = await window.api.authState();
        const api = (State.settings && State.settings.api) || {};
        return {
          hidden: document.getElementById('auth-gate').hidden,
          locked: AuthGate.isLocked(),
          msg: document.getElementById('ag-msg').textContent,
          signedIn: st.signedIn, user: st.user,
          rendererSignedIn: !!api.signedIn,
          rendererName: api.name,
          rendererHasToken: Object.prototype.hasOwnProperty.call(api, 'token'),
          required: st.required
        };`);
      check('creating an account from the gate signs in and hands the window over',
        created.hidden && !created.locked && created.signedIn === true && created.user && created.user.username === USER,
        JSON.stringify({ hidden: created.hidden, msg: created.msg, user: created.user }));
      check('the renderer knows who is signed in, and is never given the token',
        created.rendererSignedIn && created.rendererName === USER && created.rendererHasToken === false,
        JSON.stringify({ rendererSignedIn: created.rendererSignedIn, name: created.rendererName, hasToken: created.rendererHasToken }));

      const onDisk = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const diskToken = String((onDisk.settings.api || {}).token || '');
      check('the session is on disk for the next launch, as an opaque token and never a password',
        /^[A-Za-z0-9_-]{40,}$/.test(diskToken)
        && !JSON.stringify(onDisk).includes(PASS)
        && !(onDisk.settings.api || {}).password,
        `token is ${diskToken.length} chars of base64url`);

      const out = await js(`
        await window.api.authSignOut();
        for (let i = 0; i < 30; i += 1) {
          await new Promise(r => setTimeout(r, 200));
          if (!document.getElementById('auth-gate').hidden) break;
        }
        const plan = await window.api.uninstallPlan('anything');
        return {
          shown: !document.getElementById('auth-gate').hidden,
          locked: AuthGate.isLocked(),
          plan
        };`);
      check('signing out drops you back behind the gate',
        out.shown && out.locked, JSON.stringify({ shown: out.shown, locked: out.locked }));
      check('and a privileged channel is refused in the main process, not just greyed out',
        out.plan && out.plan.ok === false && out.plan.authRequired === true, JSON.stringify(out.plan));

      const bad = await js(`
        document.querySelector('[data-ag-tab="in"]').click();
        document.getElementById('ag-in-email').value = '${EMAIL}';
        document.getElementById('ag-in-pass').value = 'not the password';
        document.getElementById('ag-form-in').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        for (let i = 0; i < 30; i += 1) {
          await new Promise(r => setTimeout(r, 200));
          if (document.getElementById('ag-msg').textContent) break;
        }
        return {
          shown: !document.getElementById('auth-gate').hidden,
          locked: AuthGate.isLocked(),
          msg: document.getElementById('ag-msg').textContent
        };`);
      check('a wrong password keeps the gate shut and says why',
        bad.shown && bad.locked && /do not match|incorrect|wrong/i.test(bad.msg), JSON.stringify(bad));

      const back = await js(`
        document.getElementById('ag-in-email').value = '${EMAIL}';
        document.getElementById('ag-in-pass').value = '${PASS}';
        document.getElementById('ag-form-in').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        for (let i = 0; i < 50; i += 1) {
          await new Promise(r => setTimeout(r, 200));
          if (document.getElementById('auth-gate').hidden) break;
        }
        const st = await window.api.authState();
        return { hidden: document.getElementById('auth-gate').hidden, signedIn: st.signedIn, user: st.user };`);
      check('signing back in with the right password works',
        back.hidden && back.signedIn === true && back.user.username === USER, JSON.stringify(back));
    }

    // ---------------------------------------------------------------- phase 2
    if (PHASE === '2') {
      const restored = await js(`
        await new Promise(r => setTimeout(r, 800));
        const st = await window.api.authState();
        return {
          hidden: document.getElementById('auth-gate').hidden,
          locked: AuthGate.isLocked(),
          signedIn: st.signedIn,
          user: st.user,
          status: st.status
        };`);
      check('a relaunch with the stored session comes up signed in, gate down',
        restored.hidden && !restored.locked && restored.signedIn === true && restored.user
          && restored.user.username === USER,
        JSON.stringify(restored));

      const plan = await js(`return await window.api.uninstallPlan('anything');`);
      check('privileged work is allowed again once the session is verified',
        plan && plan.authRequired !== true, JSON.stringify(plan));

      // The escape hatch is deliberately last: it turns the requirement off in
      // the state file, so nothing after it could test the armed path.
      const skipped = await js(`
        window.confirm = () => true;
        document.getElementById('ag-skip').click();
        for (let i = 0; i < 40; i += 1) {
          await new Promise(r => setTimeout(r, 200));
          if (document.getElementById('auth-gate').hidden) break;
        }
        const st = await window.api.authState();
        return { hidden: document.getElementById('auth-gate').hidden, required: st.required };`);
      const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      check('the escape hatch turns the requirement off for good, and says so in the file',
        skipped.hidden && skipped.required === false && file.settings.auth.required === false,
        JSON.stringify({ hidden: skipped.hidden, required: skipped.required, file: file.settings.auth.required }));
    }

    server.kill();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} assertions passed`);
    setTimeout(() => app.exit(passed === results.length ? 0 : 1), 80);
  });
})();
