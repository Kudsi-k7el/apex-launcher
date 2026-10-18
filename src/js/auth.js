'use strict';

/**
 * The sign-in gate, renderer side.
 * ---------------------------------------------------------------------------
 * The rule itself lives in the main process (auth.js) - this file only asks it
 * what the answer is and paints the door. That split matters: everything here
 * can be bypassed by opening the devtools console, and none of it would matter
 * if the gate were only a view. `game:launch` and friends are refused in main
 * regardless of what this script thinks.
 *
 * The screen is deliberately not dismissible. No Escape handler, no close
 * button: the ways out are signing in, pointing at a different server, or the
 * deliberate "continue without signing in" escape hatch at the bottom, which
 * flips the requirement off in the settings file rather than sneaking past it
 * for one run.
 */

const AuthGate = (() => {
  const el = {};
  let snap = null;
  let busy = false;
  let wired = false;
  let locked = false;
  let syncedSignedIn = false;

  // --- small helpers --------------------------------------------------------
  function cache() {
    el.gate = document.getElementById('auth-gate');
    el.sub = document.getElementById('ag-sub');
    el.status = document.getElementById('ag-status');
    el.msg = document.getElementById('ag-msg');
    el.forms = {
      in: document.getElementById('ag-form-in'),
      up: document.getElementById('ag-form-up')
    };
    el.tabs = Array.from(document.querySelectorAll('[data-ag-tab]'));
    el.fields = {
      inEmail: document.getElementById('ag-in-email'),
      inPass: document.getElementById('ag-in-pass'),
      upUser: document.getElementById('ag-up-user'),
      upEmail: document.getElementById('ag-up-email'),
      upPass: document.getElementById('ag-up-pass'),
      upPass2: document.getElementById('ag-up-pass2')
    };
  }

  function msg(text, kind) {
    if (!el.msg) return;
    el.msg.textContent = text || '';
    el.msg.className = 'ag-msg' + (text ? ` is-${kind || 'err'}` : '');
  }

  function status(text, kind) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.className = 'ag-status' + (text ? ` is-${kind || 'info'}` : '');
    el.status.hidden = !text;
  }

  function setBusy(on, label) {
    busy = !!on;
    document.querySelectorAll('#auth-gate .btn.primary').forEach((b) => {
      b.disabled = !!on;
      if (!b.dataset.label) b.dataset.label = b.textContent.trim();
      b.textContent = on ? (label || 'One moment\u2026') : b.dataset.label;
    });
  }

  function showTab(which) {
    const want = which === 'up' ? 'up' : 'in';
    el.tabs.forEach((t) => {
      const on = t.dataset.agTab === want;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.entries(el.forms).forEach(([k, form]) => { if (form) form.hidden = k !== want; });
    msg('');
    const first = el.forms[want] && el.forms[want].querySelector('input');
    if (first && locked) setTimeout(() => { try { first.focus(); } catch { /* ignore */ } }, 40);
  }

  // --- locking --------------------------------------------------------------
  function lock() {
    if (!el.gate) return;
    if (!locked) {
      locked = true;
      document.body.classList.add('auth-locked');
      el.gate.hidden = false;
      try { SFX.play('back'); } catch { /* no audio yet at boot */ }
    }
    el.gate.hidden = false;
  }

  function unlock() {
    if (!el.gate || !locked) {
      if (el.gate) el.gate.hidden = true;
      locked = false;
      return;
    }
    locked = false;
    document.body.classList.remove('auth-locked');
    el.gate.hidden = true;
    try { SFX.play('enter'); } catch { /* ignore */ }
  }

  /** Keeps the renderer's copy of the account in step with the main process. */
  function syncApiState(s) {
    if (typeof State === 'undefined' || !State.settings) return;
    const api = State.settings.api || {};
    State.settings.api = {
      ...api,
      signedIn: !!s.signedIn,
      email: s.user ? (s.user.email || '') : (s.signedIn ? api.email || '' : ''),
      name: s.user ? (s.user.username || '') : (s.signedIn ? api.name || '' : '')
    };
    State.settings.auth = { ...(State.settings.auth || {}), required: s.required !== false };
  }

  /** Settings shows the account, so it has to be redrawn when it changes. */
  function afterAccountChange() {
    if (typeof current === 'undefined' || typeof render !== 'function') return;
    if (current !== 'settings') return;
    try { render(false); } catch { /* a stale panel is not worth an error */ }
  }

  /** Paints whatever the main process last said. */
  function apply(next) {
    snap = next || {};
    const changed = syncedSignedIn !== !!snap.signedIn;
    syncedSignedIn = !!snap.signedIn;
    syncApiState(snap);

    if (snap.required === false || snap.signedIn) {
      unlock();
      if (changed) afterAccountChange();
      return;
    }
    if (changed) afterAccountChange();

    if (snap.status === 'checking') {
      status('Checking your session\u2026', 'info');
    } else if (snap.status === 'unconfigured') {
      status('The Apex server address is missing from this build. Reinstall the launcher.', 'warn');
    } else if (snap.status === 'unreachable') {
      status('Cannot reach the Apex server. Check your internet connection, then try again.', 'warn');
    } else if (snap.status === 'signedOut') {
      status(snap.error || '', 'warn');
    } else {
      status('', 'info');
    }

    lock();
    // With no session to restore, a new user is the likelier visitor, so the
    // create-account tab is the default when nobody has signed in on this PC
    // before. A re-check (or an expired session) must not move a returning user
    // off the sign-in form, so it is only chosen for a plain `signedOut`.
    if (snap.status === 'signedOut' && String((State.settings.api || {}).name || '') === '') {
      showTab('up');
    } else if (snap.status === 'signedOut' || snap.status === 'unreachable' || snap.status === 'unconfigured') {
      showTab('in');
    }
  }

  // --- actions --------------------------------------------------------------
  async function submit(mode) {
    if (busy) return;
    const isNew = mode === 'up';
    const f = el.fields;

    if (isNew) {
      const username = (f.upUser.value || '').trim();
      const email = (f.upEmail.value || '').trim();
      const password = f.upPass.value || '';
      if (password.length < 8) { msg('Use at least 8 characters for the password.', 'err'); return; }
      if (password !== f.upPass2.value) { msg('Those two passwords do not match.', 'err'); return; }
      setBusy(true, 'Creating\u2026');
      const res = await window.api.authSignUp({ username, email, password });
      setBusy(false);
      return finish(res, `Welcome, ${username}.`);
    }

    const email = (f.inEmail.value || '').trim();
    const password = f.inPass.value || '';
    if (!email || !password) { msg('Enter your email and password.', 'err'); return; }
    setBusy(true, 'Signing in\u2026');
    const res = await window.api.authSignIn({ email, password });
    setBusy(false);
    return finish(res, 'Signed in.');
  }

  function finish(res, okText) {
    if (!res || !res.ok) {
      msg((res && res.error) || 'That did not work.', 'err');
      try { SFX.play('back'); } catch { /* ignore */ }
      return false;
    }
    try { SFX.play('select'); } catch { /* ignore */ }
    apply(res.state || { required: true, signedIn: true, user: res.user });
    if (typeof toast === 'function') toast(okText, 'success');
    return true;
  }

  async function skip() {
    const yes = window.confirm(
      'Open Apex Launcher without an account?\n\n' +
      'The launcher will stop asking on this PC. Games, downloads and installs all work, ' +
      'but your profile and achievements stay local. You can turn the requirement back on ' +
      'in Settings > Account.'
    );
    if (!yes) return;
    apply(await window.api.authRelax());
    if (typeof toast === 'function') toast('Account requirement off for this PC', 'info');
  }

  // --- wiring ---------------------------------------------------------------
  function wire() {
    if (wired || !el.gate) return;
    wired = true;

    el.tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.agTab)));
    document.querySelectorAll('[data-ag-swap]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      showTab(a.dataset.agSwap);
    }));

    if (el.forms.in) el.forms.in.addEventListener('submit', (e) => { e.preventDefault(); submit('in'); });
    if (el.forms.up) el.forms.up.addEventListener('submit', (e) => { e.preventDefault(); submit('up'); });

    const out = document.getElementById('ag-signout');
    if (out) out.addEventListener('click', async () => {
      apply(await window.api.authSignOut());
      showTab('in');
    });

    const skipBtn = document.getElementById('ag-skip');
    if (skipBtn) skipBtn.addEventListener('click', skip);

    // The gate swallows the app's global shortcuts while it is up. Escape, in
    // particular, must not close it - that would make the door a formality.
    document.addEventListener('keydown', (e) => {
      if (!locked) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); }
    }, true);

    if (typeof window !== 'undefined' && window.api && window.api.onAuthChanged) {
      try { window.api.onAuthChanged(apply); } catch { /* the push is a nicety */ }
    }
  }

  async function start() {
    cache();
    if (!el.gate) return;
    wire();

    // Locked from the settings file before anything is asked over IPC, so there
    // is no frame in which the launcher is briefly usable by somebody who is not
    // signed in. A missing `auth` block counts as "required" too.
    const cfg = (State && State.settings && State.settings.auth) || {};
    if (cfg.required !== false) {
      status('Checking your session\u2026', 'info');
      lock();
    }

    try { apply(await window.api.authState()); } catch { /* stay locked */ }
  }

  return {
    start,
    apply,
    isLocked: () => locked,
    snapshot: () => snap
  };
})();
