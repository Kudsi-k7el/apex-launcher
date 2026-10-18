'use strict';

/**
 * Apex Launcher companion site - accounts.
 * ---------------------------------------------------------------------------
 * Talks to the same origin the page was served from, so there is no API URL to
 * configure and the session cookie set by the server does the remembering. Three
 * surfaces live here:
 *
 *   1. The nav chip - "Sign in" when signed out, the account when signed in.
 *   2. The modal - a Sign in / Create account pair of forms.
 *   3. The download gate - the buttons in the hero and the download section ask
 *      for an account first, because the launcher itself refuses to open without
 *      one. Locking the door only in the app would just be confusing.
 *
 * Plain browser JS, no build step, same conventions as assets/js/main.js.
 */

(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const state = { user: null, ready: false, busy: false };

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  function call(method, url, body) {
    const opts = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(
      (res) => res.json().catch(() => null).then((json) => ({
        ok: res.ok,
        status: res.status,
        data: json || {},
        error: (json && json.error) || (res.ok ? '' : `The server answered ${res.status}.`)
      })),
      () => ({ ok: false, status: 0, data: {}, error: 'Could not reach the server. Is it running?' })
    );
  }

  // -------------------------------------------------------------------------
  // Painting the nav
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // The admin door
  // -------------------------------------------------------------------------
  /**
   * Only the administrator's account can open the console, and only that
   * account is ever shown the link to it. /admin/api/whoami answers 401 to
   * everyone signed out and 403 to everyone else, so asking is free and the
   * answer says nothing to anybody it does not concern.
   */
  function probeAdmin() {
    const link = $('#auth-menu-admin');
    if (!link) return;
    if (!state.user) { link.hidden = true; return; }
    call('GET', '/admin/api/whoami').then((res) => {
      link.hidden = !(res.ok && res.data && res.data.admin);
      // A stale answer must never outlive the account that earned it.
      if (state.user && res.ok && res.data.admin
          && res.data.admin.email !== state.user.email) link.hidden = true;
    });
  }

  function paint(user) {
    state.user = user || null;
    const open = $('#auth-open');
    const chip = $('#auth-chip');
    if (open) open.hidden = !!state.user;
    if (chip) chip.hidden = !state.user;
    probeAdmin();
    if (state.user) {
      const name = state.user.displayName || state.user.username || 'player';
      const av = $('#auth-av');
      const nm = $('#auth-name');
      const mn = $('#auth-menu-name');
      const mm = $('#auth-menu-mail');
      if (av) av.textContent = name.slice(0, 1).toUpperCase();
      if (nm) nm.textContent = name;
      if (mn) mn.textContent = name;
      if (mm) mm.textContent = state.user.email || '';
      const since = $('#auth-menu-since');
      if (since && state.user.createdAt) {
        since.textContent = 'Member since ' + new Date(state.user.createdAt).toLocaleDateString();
      }
    }

    document.dispatchEvent(new CustomEvent('apex:auth', { detail: state.user }));
  }

  // -------------------------------------------------------------------------
  // The modal
  // -------------------------------------------------------------------------
  function modal() { return $('#auth-modal'); }

  function message(text, kind) {
    const el = $('#auth-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'auth-msg' + (text ? ' is-' + (kind || 'err') : '');
  }

  function showTab(which) {
    $$('[data-auth-tab]').forEach((tab) => {
      const on = tab.dataset.authTab === which;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.auth-form').forEach((form) => {
      form.hidden = form.dataset.authForm !== which;
    });
    message('');
    const first = $('.auth-form:not([hidden]) input');
    if (first) setTimeout(() => first.focus(), 40);
  }

  function openModal(which, reason) {
    const box = modal();
    if (!box) return;
    box.hidden = false;
    document.documentElement.classList.add('auth-open');
    $('#auth-reason').textContent = reason || '';
    $('#auth-reason').hidden = !reason;
    showTab(which || 'in');
    const first = $('.auth-form:not([hidden]) input');
    if (first) setTimeout(() => first.focus(), 60);
  }

  function closeModal() {
    const box = modal();
    if (!box) return;
    box.hidden = true;
    document.documentElement.classList.remove('auth-open');
    message('');
    $$('.auth-form').forEach((f) => { f.reset(); });
    const open = $('#auth-open');
    if (open && !state.user) open.focus();
  }

  function setBusy(on, label) {
    state.busy = !!on;
    $$('.auth-form button[type="submit"]').forEach((b) => {
      b.disabled = !!on;
      if (!b.dataset.label) b.dataset.label = b.textContent.trim();
      b.textContent = on ? (label || 'One moment\u2026') : b.dataset.label;
    });
  }

  function finish(res, verb) {
    setBusy(false);
    if (!res.ok) {
      message(res.error || 'That did not work.', 'err');
      return false;
    }
    paint(res.data.user);
    message(`${verb} \u2014 welcome, ${(res.data.user && (res.data.user.displayName || res.data.user.username)) || 'player'}.`, 'ok');
    setTimeout(closeModal, 700);
    return true;
  }

  function onSubmitLogin(e) {
    e.preventDefault();
    if (state.busy) return;
    const email = ($('#si-email').value || '').trim();
    const password = $('#si-pass').value || '';
    if (!email || !password) { message('Enter your email and password.', 'err'); return; }
    setBusy(true, 'Signing in\u2026');
    call('POST', '/auth/login', { email: email, password: password })
      .then((res) => finish(res, 'Signed in'));
  }

  function onSubmitSignup(e) {
    e.preventDefault();
    if (state.busy) return;
    const username = ($('#su-user').value || '').trim();
    const email = ($('#su-email').value || '').trim();
    const password = $('#su-pass').value || '';
    const confirm = $('#su-confirm').value || '';

    if (password.length < 8) { message('Use at least 8 characters for the password.', 'err'); return; }
    if (password !== confirm) { message('Those two passwords do not match.', 'err'); return; }

    setBusy(true, 'Creating\u2026');
    call('POST', '/auth/register', { username: username, email: email, password: password })
      .then((res) => finish(res, 'Account created'));
  }

  function signOut() {
    call('POST', '/auth/logout', {}).then(() => {
      paint(null);
      const menu = $('#auth-menu');
      if (menu) menu.classList.remove('is-open');
      message('');
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function wireModal() {
    const box = modal();
    if (!box) return;

    $('#auth-open').addEventListener('click', () => openModal('in'));
    $$('[data-auth-close]', box).forEach((el) => el.addEventListener('click', closeModal));
    $$('[data-auth-tab]', box).forEach((tab) => {
      tab.addEventListener('click', () => showTab(tab.dataset.authTab));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = tab.dataset.authTab === 'in' ? 'up' : 'in';
        showTab(next);
        $(`[data-auth-tab="${next}"]`).focus();
      });
    });

    $('#auth-form-in').addEventListener('submit', onSubmitLogin);
    $('#auth-form-up').addEventListener('submit', onSubmitSignup);

    $$('[data-auth-swap]', box).forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      showTab(a.dataset.authSwap);
    }));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !box.hidden) closeModal();
    });
  }

  function wireChip() {
    const btn = $('#auth-chip-btn');
    const menu = $('#auth-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !menu.classList.contains('is-open');
        menu.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', (e) => {
        if (!menu.classList.contains('is-open')) return;
        if (!menu.contains(e.target) && !btn.contains(e.target)) menu.classList.remove('is-open');
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.classList.contains('is-open')) {
          menu.classList.remove('is-open');
          btn.focus();
        }
      });
    }
    const out = $('#auth-menu-out');
    if (out) out.addEventListener('click', signOut);
  }

  /**
   * The download gate. Intercepting in the capture phase means it works no
   * matter what main.js has already done to the button's href.
   */
  function wireDownloadGate() {
    // The launcher links here for "Account on the website" (#account), and this
    // block's own button opens the modal with no download intent behind it.
    const create = document.getElementById('dl-account-btn');
    if (create) create.addEventListener('click', () => openModal(state.user ? 'in' : 'up'));

    document.addEventListener('click', (e) => {
      if (state.user) return;
      const dl = e.target.closest && e.target.closest('[data-dl]');
      if (!dl) return;
      e.preventDefault();
      e.stopPropagation();
      openModal('up', 'Create a free account to download Apex Launcher.');
    }, true);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function boot() {
    wireModal();
    wireChip();
    wireDownloadGate();

    // Ask the server who we are: the session cookie may already be valid from a
    // previous visit, in which case the page starts signed in.
    call('GET', '/auth/me').then((res) => {
      state.ready = true;
      paint(res.ok ? res.data.user : null);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.ApexAuth = { open: openModal, close: closeModal, signOut: signOut, state: state };
})();
