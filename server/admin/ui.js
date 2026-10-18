'use strict';

/**
 * Apex Launcher admin console - the page.
 * ---------------------------------------------------------------------------
 * Plain browser JS with no build step, loaded only on /admin and served with a
 * policy that forbids inline code, so everything the page does lives here.
 *
 * The page opens by asking the server who it is talking to. Three answers, three
 * screens: signed out gets a sign-in form, signed in as somebody else gets a
 * polite refusal, the administrator gets the console. The page never decides any
 * of that for itself - every panel is fed by an /admin/api route that re-checks
 * the session, so hiding a button here is a convenience and never a defence.
 */

(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const state = {
    me: null,
    server: null,
    tab: 'overview',
    users: [],
    q: '',
    detailId: null,
    kinds: [],
    events: { kind: '', limit: 100, rows: [] },
    schemaLoaded: false
  };

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const DAY = 24 * 60 * 60 * 1000;

  function when(ms) {
    if (!ms) return '--';
    return new Date(Number(ms)).toLocaleString();
  }

  function ago(ms) {
    if (!ms) return 'never';
    const s = Math.max(0, (Date.now() - Number(ms)) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60;
    if (m < 90) return `${Math.round(m)} min ago`;
    const h = m / 60;
    if (h < 36) return `${Math.round(h)} h ago`;
    const d = h / 24;
    if (d < 60) return `${Math.round(d)} d ago`;
    return new Date(Number(ms)).toLocaleDateString();
  }

  /** Bytes-ish sizes and counts, rendered the same way everywhere. */
  const num = (n) => Number(n || 0).toLocaleString();

  const initials = (user) => String((user && (user.displayName || user.username)) || '?').slice(0, 1).toUpperCase();

  function toast(text, kind) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  function api(path, { method = 'GET', body } = {}) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(
      (res) => res.json().catch(() => null).then((json) => ({
        ok: res.ok,
        status: res.status,
        data: json || {},
        error: (json && json.error) || (res.ok ? '' : `The server answered ${res.status}.`)
      })),
      () => ({ ok: false, status: 0, data: {}, error: 'Could not reach the server.' })
    );
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------
  function screen(which) {
    $('#gate').hidden = which !== 'gate';
    $('#denied').hidden = which !== 'denied';
    $('#console').hidden = which !== 'console';
  }

  function paintWho() {
    const me = state.me;
    $('#who').hidden = !me;
    $('#out').hidden = !me;
    if (me) $('#who').textContent = me.email;
  }

  function showTab(name) {
    state.tab = name;
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.panel').forEach((p) => p.classList.toggle('is-on', p.dataset.panel === name));
    if (name === 'accounts' && !state.users.length) loadUsers();
    if (name === 'sessions') loadSessions();
    if (name === 'events') loadEvents();
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------
  function tile(k, v, s, cls) {
    return `<div class="tile${cls ? ' ' + cls : ''}">
      <div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>
      ${s ? `<div class="s">${esc(s)}</div>` : ''}
    </div>`;
  }

  function barChart(signups, now) {
    // A fixed fourteen-day axis: a quiet week shows as a quiet week, rather than
    // as three bars stretched across the panel.
    const today = Math.floor(now / DAY);
    const byDay = new Map((signups || []).map((r) => [Number(r.day), Number(r.n)]));
    const days = [];
    for (let i = 13; i >= 0; i -= 1) {
      const day = today - i;
      days.push({ day, n: byDay.get(day) || 0 });
    }
    const peak = Math.max(1, ...days.map((d) => d.n));
    return days.map((d) => {
      const pct = Math.round((d.n / peak) * 100);
      const label = new Date(d.day * DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `<div class="bar" title="${esc(label)}: ${d.n}">
        <span class="n">${d.n || ''}</span>
        <span class="col" style="height:${Math.max(3, pct)}%"></span>
        <span class="d">${esc(label)}</span>
      </div>`;
    }).join('');
  }

  function loadOverview() {
    return api('/admin/api/overview').then((res) => {
      if (!res.ok) return toast(res.error, 'err');
      const d = res.data;
      const t = d.totals || {};
      state.kinds = d.eventKinds || [];

      $('#stats').innerHTML = [
        tile('Accounts', num(t.users), t.disabled ? `${t.disabled} disabled` : 'none disabled'),
        tile('Signed in now', num(t.liveSessions), `${num(t.sessions)} sessions all time`, t.liveSessions ? 'hot' : ''),
        tile('Audit lines', num(t.events), `${num((d.eventKinds || []).length)} kinds`),
        tile('Synced profiles', num(t.profiles), 'launcher settings on the server'),
        tile('Server', state.server ? state.server.version : '--', state.server ? state.server.name : '',
          '')
      ].join('');

      $('#chart').innerHTML = barChart(d.signups, d.now || Date.now());

      $('#kinds').innerHTML = (d.eventKinds || []).length
        ? d.eventKinds.map((k) => `<tr><td>${esc(k.kind)}</td><td class="num" style="text-align:right">${num(k.n)}</td></tr>`).join('')
        : '<tr><td class="empty">Nothing logged yet.</td></tr>';

      const db = d.database || {};
      $('#overview-foot').textContent =
        `Database ${db.file || 'apex.db'} - ${num(db.accounts)} account row(s). ` +
        `Signed in as ${d.admin ? d.admin.email : ''}.`;

      // The audit-log filter is built from the same list, so it can never offer a
      // kind that has never happened.
      const sel = $('#event-kind');
      const current = sel.value;
      sel.innerHTML = '<option value="">everything</option>'
        + state.kinds.map((k) => `<option value="${esc(k.kind)}">${esc(k.kind)} (${num(k.n)})</option>`).join('');
      sel.value = current;
    });
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  function userRow(u) {
    const live = Number(u.liveSessions || 0);
    const total = Number(u.sessions || 0);
    return `<tr class="clickable${state.detailId === u.id ? ' is-on' : ''}" data-user="${u.id}">
      <td class="num">${u.id}</td>
      <td><b>${esc(u.username)}</b>${u.displayName && u.displayName !== u.username
        ? `<div class="num" style="border:0">${esc(u.displayName)}</div>` : ''}</td>
      <td class="mono">${esc(u.email)}</td>
      <td class="hide-sm">${esc(ago(u.createdAt))}</td>
      <td class="hide-sm">${esc(ago(u.lastLoginAt))}</td>
      <td>${live ? `<span class="badge live">${live} live</span>` : ''} <span class="num">${total}</span></td>
      <td class="num">${num(u.eventCount)}</td>
      <td>${u.disabled ? '<span class="badge bad">disabled</span>' : '<span class="badge ok">active</span>'}</td>
    </tr>`;
  }

  function loadUsers() {
    const q = state.q;
    return api(`/admin/api/users?q=${encodeURIComponent(q)}&limit=100`).then((res) => {
      if (!res.ok) return toast(res.error, 'err');
      state.users = res.data.users || [];
      const body = $('#users tbody');
      body.innerHTML = state.users.length
        ? state.users.map(userRow).join('')
        : `<tr><td class="empty" colspan="8">No account matches ${esc(q || 'anything')}.</td></tr>`;
    });
  }

  function miniLines(rows, render) {
    if (!rows || !rows.length) return '<p class="note">Nothing recorded.</p>';
    return `<div class="mini">${rows.map(render).join('')}</div>`;
  }

  function detailShell(u, inner) {
    return `<h3>${esc(u.displayName || u.username)} <span class="badge ${u.disabled ? 'bad' : 'ok'}">${u.disabled ? 'disabled' : 'active'}</span></h3>
      <div class="sub">${esc(u.username)} - ${esc(u.email)}</div>
      <div class="kv">
        <span class="k">Account id</span><span class="v">${u.id}</span>
        <span class="k">Joined</span><span class="v">${esc(when(u.createdAt))}</span>
        <span class="k">Last sign-in</span><span class="v">${esc(when(u.lastLoginAt))}</span>
        <span class="k">Sessions</span><span class="v">${num(u.liveSessions)} live of ${num(u.sessions)}</span>
      </div>${inner}`;
  }

  function loadUser(id) {
    state.detailId = Number(id);
    $$('#users tbody tr').forEach((tr) => tr.classList.toggle('is-on', Number(tr.dataset.user) === state.detailId));
    const box = $('#user-detail');
    box.innerHTML = '<p class="hint">Reading that account...</p>';

    return api(`/admin/api/users/${state.detailId}`).then((res) => {
      if (!res.ok) {
        box.innerHTML = `<p class="hint">${esc(res.error)}</p>`;
        return;
      }
      const d = res.data;
      const u = d.user;

      const sessions = miniLines(d.sessions, (s) => `<div class="line">
        <b>${esc(s.kind)}</b> ${esc(s.ip || 'local')} - seen ${esc(ago(s.lastSeenAt))}
        <span class="spacer"></span>
        <button class="btn ghost sm" data-revoke="${esc(s.id)}" type="button">revoke</button>
      </div>`);
      const events = miniLines(d.events, (e) => `<div class="line">
        <b>${esc(e.kind)}</b> ${esc(e.detail || '')}
        <span class="spacer"></span>${esc(ago(e.at))}
      </div>`);

      const profile = d.profile
        ? `<p class="note">Synced ${esc(ago(d.profile.updatedAt))}${d.profile.note ? ' - ' + esc(d.profile.note) : ''}</p>
           <div class="mini"><pre class="mono" style="margin:0;white-space:pre-wrap;font-size:11.5px">${esc(JSON.stringify(d.profile.data, null, 2) || 'null')}</pre></div>`
        : '<p class="note">This account has never synced a launcher profile.</p>';

      box.innerHTML = detailShell(u, `
        <h4>Sessions</h4>${sessions}
        <h4>Recent activity</h4>${events}
        <h4>Synced launcher profile</h4>${profile}
        <h4>Actions</h4>
        <div class="actions">
          <div class="block">
            <button class="btn ${u.disabled ? '' : 'danger'} sm" type="button" data-act="toggle-disabled" data-id="${u.id}" data-next="${u.disabled ? '0' : '1'}">
              ${u.disabled ? 'Enable this account' : 'Disable this account'}
            </button>
            <button class="btn ghost sm" type="button" data-act="signout-all" data-id="${u.id}">Sign out everywhere</button>
          </div>
          <div class="block">
            <input type="password" placeholder="new password" id="pw-${u.id}" autocomplete="new-password">
            <button class="btn sm" type="button" data-act="password" data-id="${u.id}">Set</button>
          </div>
          <p class="note">Setting a password also signs every session out.</p>
          <div class="block">
            <input placeholder="type ${esc(u.username)} to delete" id="del-${u.id}" autocomplete="off">
            <button class="btn danger sm" type="button" data-act="delete" data-id="${u.id}" data-username="${esc(u.username)}">Delete</button>
          </div>
        </div>`);
    });
  }

  async function userAction(act, id, el) {
    const u = state.users.find((x) => Number(x.id) === Number(id));

    if (act === 'toggle-disabled') {
      const disabled = el.dataset.next === '1';
      if (disabled && !confirm(`Disable ${u ? u.username : id}? They are signed out and cannot sign back in.`)) return;
      const res = await api(`/admin/api/users/${id}/disabled`, { method: 'POST', body: { disabled } });
      if (!res.ok) return toast(res.error, 'err');
      toast(disabled ? 'Account disabled.' : 'Account enabled.', 'ok');
    } else if (act === 'password') {
      const field = $(`#pw-${id}`);
      const password = (field && field.value) || '';
      if (password.length < 8) return toast('Use at least eight characters.', 'err');
      const res = await api(`/admin/api/users/${id}/password`, { method: 'POST', body: { password } });
      if (!res.ok) return toast(res.error, 'err');
      toast('Password set; that account was signed out everywhere.', 'ok');
      if (field) field.value = '';
    } else if (act === 'delete') {
      const field = $(`#del-${id}`);
      const typed = (field && field.value) || '';
      if (typed.toLowerCase() !== String(el.dataset.username || '').toLowerCase()) {
        return toast(`Type ${el.dataset.username} to confirm.`, 'err');
      }
      if (!confirm(`Delete ${el.dataset.username} for good? This cannot be undone.`)) return;
      const res = await api(`/admin/api/users/${id}/delete`, { method: 'POST', body: { username: typed } });
      if (!res.ok) return toast(res.error, 'err');
      toast(`Deleted ${res.data.deleted}.`, 'ok');
      state.detailId = null;
      $('#user-detail').innerHTML = '<p class="hint">That account is gone. Pick another row.</p>';
    } else if (act === 'signout-all') {
      const res = await api(`/admin/api/users/${id}`);
      if (!res.ok) return toast(res.error, 'err');
      const ids = (res.data.sessions || []).map((s) => s.id);
      if (!ids.length) return toast('That account has no sessions.', 'err');
      await Promise.all(ids.map((sid) => api('/admin/api/sessions/revoke', { method: 'POST', body: { id: sid } })));
      toast(`Revoked ${ids.length} session(s).`, 'ok');
    } else if (act === 'revoke') {
      const res = await api('/admin/api/sessions/revoke', { method: 'POST', body: { id: id } });
      if (!res.ok) return toast(res.error, 'err');
      toast('Session revoked.', 'ok');
      return loadUser(state.detailId);
    }

    await loadUsers();
    if (state.detailId && act !== 'delete') await loadUser(state.detailId);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  function loadSessions() {
    return api('/admin/api/sessions').then((res) => {
      if (!res.ok) return toast(res.error, 'err');
      const rows = res.data.sessions || [];
      $('#sessions tbody').innerHTML = rows.length
        ? rows.map((s) => `<tr>
            <td><b>${esc(s.user ? s.user.username : '?')}</b><div class="num" style="border:0">${esc(s.user ? s.user.email : '')}</div></td>
            <td class="hide-sm"><span class="badge gray">${esc(s.kind)}</span></td>
            <td class="mono">${esc(s.ip || 'local')}</td>
            <td class="hide-sm">${esc(ago(s.createdAt))}</td>
            <td>${esc(ago(s.lastSeenAt))}</td>
            <td class="hide-sm num">${esc(when(s.expiresAt))}</td>
            <td style="text-align:right"><button class="btn ghost sm" type="button" data-session="${esc(s.id)}">revoke</button></td>
          </tr>`).join('')
        : '<tr><td class="empty" colspan="7">Nobody is signed in.</td></tr>';
    });
  }

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------
  function loadEvents(more) {
    if (!more) { state.events.rows = []; state.events.limit = 100; }
    const { kind, limit } = state.events;
    return api(`/admin/api/events?kind=${encodeURIComponent(kind)}&limit=${limit}`).then((res) => {
      if (!res.ok) return toast(res.error, 'err');
      state.events.rows = res.data.events || [];
      const rows = state.events.rows;
      $('#events tbody').innerHTML = rows.length
        ? rows.map((e) => `<tr>
            <td class="num" title="${esc(when(e.at))}">${esc(ago(e.at))}</td>
            <td><span class="badge gray">${esc(e.kind)}</span></td>
            <td>${e.username ? esc(e.username) : '<span class="num">--</span>'}</td>
            <td>${esc(e.detail || '')}</td>
            <td class="hide-sm mono">${esc(e.ip || '')}</td>
          </tr>`).join('')
        : `<tr><td class="empty" colspan="5">Nothing ${kind ? esc(kind) : 'logged'} yet.</td></tr>`;
      // Only worth offering if the last page came back full.
      $('#event-more').hidden = rows.length < limit;
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------
  function cellValue(v) {
    if (v === null || v === undefined) return '<span class="null">null</span>';
    if (typeof v === 'object') return esc(JSON.stringify(v));
    return esc(String(v));
  }

  function renderSql(rows) {
    if (!rows.length) return '<div class="err" style="color:var(--muted)">No rows.</div>';
    const cols = Object.keys(rows[0]);
    return `<table class="table tight"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="mono">${cellValue(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  async function runSql() {
    const text = ($('#sql-text').value || '').trim();
    if (!text) return toast('Type a query first.', 'err');
    $('#sql-run').disabled = true;
    const started = performance.now();
    const res = await api('/admin/api/sql', { method: 'POST', body: { sql: text } });
    $('#sql-run').disabled = false;

    if (!res.ok) {
      $('#sql-note').textContent = '';
      $('#sql-out').innerHTML = `<div class="err">${esc(res.error)}</div>`;
      return;
    }
    const ms = Math.max(1, Math.round(performance.now() - started));
    const rows = res.data.rows || [];
    $('#sql-note').textContent = `${num(res.data.total)} row(s)${res.data.truncated ? ' (first 500 shown)' : ''} - ${ms} ms`;
    $('#sql-out').innerHTML = renderSql(rows);
  }

  function loadSchema() {
    if (state.schemaLoaded) return;
    state.schemaLoaded = true;
    api('/admin/api/sql', {
      method: 'POST',
      body: { sql: "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name" }
    }).then((res) => {
      const rows = res.ok ? (res.data.rows || []) : [];
      $('#schema').innerHTML = rows.length
        ? rows.map((r) => `<tr><td class="mono">${esc(r.name)}</td><td class="num">${esc(r.type)}</td></tr>`).join('')
        : '<tr><td class="empty">Could not read the schema.</td></tr>';
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function signIn(e) {
    e.preventDefault();
    const email = ($('#email').value || '').trim();
    const password = $('#pass').value || '';
    if (!email || !password) return;
    const go = $('#gate-go');
    go.disabled = true;
    go.textContent = 'Signing in...';
    $('#gate-msg').textContent = '';

    api('/auth/login', { method: 'POST', body: { email, password } }).then((res) => {
      go.disabled = false;
      go.textContent = 'Sign in';
      if (!res.ok) {
        const msg = $('#gate-msg');
        msg.textContent = res.error;
        msg.className = 'msg is-err';
        return;
      }
      $('#pass').value = '';
      boot();
    });
  }

  function signOut() {
    api('/auth/logout', { method: 'POST', body: {} }).then(() => {
      state.me = null;
      state.users = [];
      state.detailId = null;
      paintWho();
      screen('gate');
      $('#gate-msg').textContent = '';
    });
  }

  function wire() {
    $('#signin').addEventListener('submit', signIn);
    $('#out').addEventListener('click', signOut);
    $('#denied-out').addEventListener('click', signOut);

    $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    $('#user-search').addEventListener('submit', (e) => { e.preventDefault(); state.q = $('#user-q').value.trim(); loadUsers(); });
    $('#user-clear').addEventListener('click', () => { $('#user-q').value = ''; state.q = ''; loadUsers(); });
    $('#user-reload').addEventListener('click', () => loadUsers());
    $('#users').addEventListener('click', (e) => {
      const tr = e.target.closest && e.target.closest('tr[data-user]');
      if (tr) loadUser(tr.dataset.user);
    });

    $('#user-detail').addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('button[data-act], button[data-revoke]');
      if (!btn) return;
      if (btn.dataset.revoke) return void userAction('revoke', btn.dataset.revoke);
      userAction(btn.dataset.act, btn.dataset.id, btn);
    });

    $('#session-reload').addEventListener('click', () => loadSessions());
    $('#sessions').addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('button[data-session]');
      if (!btn) return;
      const res = await api('/admin/api/sessions/revoke', { method: 'POST', body: { id: btn.dataset.session } });
      toast(res.ok ? 'Session revoked.' : res.error, res.ok ? 'ok' : 'err');
      loadSessions();
    });

    $('#event-kind').addEventListener('change', () => { state.events.kind = $('#event-kind').value; loadEvents(); });
    $('#event-reload').addEventListener('click', () => loadEvents());
    $('#event-more').addEventListener('click', () => { state.events.limit += 100; loadEvents(true); });

    $('#sql-run').addEventListener('click', runSql);
    $('#sql-clear').addEventListener('click', () => { $('#sql-text').value = ''; $('#sql-out').innerHTML = ''; $('#sql-note').textContent = ''; });
    $('#sql-text').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
    });
    $('details.card').addEventListener('toggle', (e) => { if (e.target.open) loadSchema(); });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function boot() {
    return api('/admin/api/whoami').then((res) => {
      if (res.status === 401) { screen('gate'); return; }
      if (res.status === 403) {
        $('#denied-mail').textContent = (res.data && res.data.email) || 'that account';
        // The server does not name the caller on a 403, so ask who is signed in
        // purely to fill the sentence in.
        api('/auth/me').then((me) => {
          if (me.ok && me.data.user) $('#denied-mail').textContent = me.data.user.email;
        });
        screen('denied');
        return;
      }
      if (!res.ok) { screen('gate'); return toast(res.error, 'err'); }

      state.me = res.data.admin;
      state.server = res.data.server;
      paintWho();
      screen('console');
      showTab(state.tab);
      loadOverview();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { wire(); boot(); });
  else { wire(); boot(); }
})();
