'use strict';

/**
 * Profile view + editor.
 *
 * The profile is entirely local: a display name, an avatar image the user
 * picks from their own PC, and a short blurb. Nothing is uploaded anywhere and
 * nothing leaves the machine — the picture is stored under Apex's own data
 * folder and referenced by path.
 *
 * The stats strip is computed from real data the launcher already tracks:
 * play-time sessions recorded on launch/exit, the install list, and the
 * favourites the user set in the Store.
 */

/** Avatar markup: the user's picture when there is one, otherwise initials. */
function avatarMarkup(size = 72, extraClass = '') {
  const p = State.profile || {};
  if (p.avatarUrl) {
    return `<span class="avatar-img ${extraClass}" style="width:${size}px;height:${size}px">
      <img src="${esc(p.avatarUrl)}" alt="Profile picture" draggable="false">
    </span>`;
  }
  const name = String(p.name || '').trim();
  const initials = name
    ? name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
    : '';
  if (initials) {
    return `<span class="avatar-img initials ${extraClass}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(initials)}</span>`;
  }
  return `<span class="avatar-img empty ${extraClass}" style="width:${size}px;height:${size}px">${icon('user', Math.round(size * 0.5))}</span>`;
}

/** Keeps the title-bar button and the dropdown header in sync. */
function paintProfileChrome() {
  const p = State.profile || {};
  const name = String(p.name || '').trim();

  const titleAvatar = document.getElementById('title-avatar');
  if (titleAvatar) {
    titleAvatar.innerHTML = p.avatarUrl
      ? `<img src="${esc(p.avatarUrl)}" alt="" draggable="false">`
      : (name ? esc(name[0].toUpperCase()) : icon('user', 17));
    titleAvatar.classList.toggle('has-img', !!p.avatarUrl);
  }

  const menuAvatar = document.getElementById('menu-avatar');
  if (menuAvatar) {
    menuAvatar.innerHTML = p.avatarUrl
      ? `<img src="${esc(p.avatarUrl)}" alt="" draggable="false">`
      : icon('user', 18);
  }

  const menuName = document.getElementById('menu-name');
  if (menuName) menuName.textContent = name || 'Not signed in';

  const menuSub = document.getElementById('menu-sub');
  if (menuSub) {
    const installed = installedCount();
    menuSub.textContent = name
      ? `${installed} game${installed === 1 ? '' : 's'} installed`
      : 'Set up your profile';
  }
}

const installedCount = () => allGames().filter((g) => isInstalled(g.id)).length;

/** Aggregate stats for the profile page. */
function profileStats() {
  const games = allGames();
  const playtime = (State.stats && State.stats.playtime) || {};
  let total = 0;
  let topId = null;
  let topMs = 0;
  for (const g of games) {
    const ms = playtimeOf(g.id);
    if (ms > 0) total += ms;
    if (ms > topMs) { topMs = ms; topId = g.id; }
  }
  return {
    totalMs: total,
    installed: games.filter((g) => isInstalled(g.id)).length,
    owned: games.filter((g) => isOwned(g.id)).length,
    favorites: Object.keys(State.favorites || {}).filter((k) => State.favorites[k]).length,
    launches: (State.stats && State.stats.launches) || 0,
    top: topMs > 0 ? { game: byId(topId), ms: topMs } : null,
    linked: Object.keys((State.local && State.local.installs) || {}).length,
    preorders: Object.keys(State.preorders || {}).length,
    // Counted by the uninstall flow so "Housekeeping" has something real to read.
    uninstalls: (State.stats && State.stats.uninstalls) || 0,
    screenshots: (State.stats && State.stats.screenshots) || 0,
    overlayOpens: (State.stats && State.stats.overlayOpens) || 0
  };
}

function statTile(ico, label, value, sub = '') {
  return `<div class="stat-tile">
    <span class="st-ico">${icon(ico, 18)}</span>
    <div class="st-text"><strong>${esc(value)}</strong><small>${esc(label)}</small></div>
    ${sub ? `<em class="st-sub">${esc(sub)}</em>` : ''}
  </div>`;
}

function renderProfile(el) {
  clearInterval(slideTimer);
  const p = State.profile || {};
  const s = profileStats();
  const name = String(p.name || '').trim();

  el.innerHTML = `
    <h1 class="page-title">Profile</h1>

    <section class="profile-hero">
      <div class="profile-cover"></div>
      <div class="profile-id">
        <div class="profile-avatar">${avatarMarkup(96)}</div>
        <div class="profile-idtext">
          <h2>${esc(name || 'Unnamed player')}</h2>
          <p class="profile-handle">${name ? `Local profile \u00b7 no account needed` : 'Set a name and picture to make this yours'}</p>
          ${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>` : ''}
        </div>
        <div class="profile-hero-actions">
          <button class="btn primary glow" data-act="edit-profile">${icon('edit', 15)} Edit profile</button>
        </div>
      </div>
    </section>

    <section class="stat-grid">
      ${statTile('clock', 'Total play time', fmtPlaytime(s.totalMs), s.launches ? `${s.launches} session${s.launches === 1 ? '' : 's'} started` : '')}
      ${statTile('library', 'Games installed', String(s.installed), `${s.owned} owned on this account`)}
      ${statTile('link', 'Linked on this PC', String(s.linked), s.linked ? 'Real executables / launchers' : 'Nothing linked yet')}
      ${statTile('heart', 'Favourites', String(s.favorites), 'Marked in the Store')}
      ${statTile('bookmark', 'Pre-orders', String(s.preorders), 'Watching for release')}
      ${statTile('activity', 'Sessions launched', String(s.launches), 'Since this profile was created')}
    </section>

    <section class="panel">
      <h3>Most played</h3>
      ${s.top
        ? `<div class="top-game">
            <div class="top-art">${art(s.top.game, 'cover')}</div>
            <div class="top-text">
              <strong>${esc(s.top.game.title)}</strong>
              <small>${esc(fmtPlaytime(s.top.ms))} played</small>
              <div class="top-actions" data-actions="${s.top.game.id}">${actionHtml(s.top.game.id)}</div>
            </div>
          </div>`
        : `<div class="empty show sm">${icon('clockPlay', 26)}<p>No play time recorded yet. Launch a game and Apex will start counting.</p></div>`}
    </section>

    <section class="panel">
      <h3>Achievements</h3>
      ${renderAchievements()}
    </section>

    <section class="panel">
      <h3>Account &amp; cloud sync</h3>
      <p class="panel-note">Optional. Apex works entirely offline; signing in only lets your profile follow you between PCs.</p>
      <div id="account-body"></div>
    </section>

    <section class="panel">
      <h3>Recently played</h3>
      ${recentlyPlayed() || `<div class="empty show sm">${icon('info', 24)}<p>Nothing played yet.</p></div>`}
    </section>`;

  hydrateIcons(el);
  renderAccountPanel();
}

function renderAchievements() {
  const a = achievements();
  const pct = a.total ? Math.round((a.earned / a.total) * 100) : 0;
  return `
    <div class="ach-head">
      <div class="ach-bar"><div class="ach-fill" style="width:${pct}%"></div></div>
      <span class="ach-count">${a.earned} / ${a.total} unlocked</span>
    </div>
    <div class="ach-grid">
      ${a.list.map((x) => `
        <div class="ach-tile ${x.got ? 'got' : ''}">
          <span class="ach-ico">${icon(x.ico, 18)}</span>
          <div class="ach-text">
            <strong>${esc(x.label)}</strong>
            <small>${esc(x.desc)}</small>
          </div>
          ${x.got ? `<span class="ach-check">${icon('check', 14)}</span>` : ''}
        </div>`).join('')}
    </div>`;
}

function achievements() {
  const s = profileStats();
  const playtimeHrs = s.totalMs / 3600000;
  const shots = (State.stats && State.stats.screenshots) || 0;
  const overlays = (State.stats && State.stats.overlayOpens) || 0;
  const list = [
    { id: 'first-launch', ico: 'play', label: 'First steps', desc: 'Launch your first game', got: s.launches >= 1 },
    { id: 'ten-launches', ico: 'zap', label: 'Regular', desc: 'Launch 10 games', got: s.launches >= 10 },
    { id: 'first-hour', ico: 'clock', label: 'Getting comfortable', desc: 'Play for an hour', got: playtimeHrs >= 1 },
    { id: 'ten-hours', ico: 'hourglass', label: 'Committed', desc: 'Play for 10 hours', got: playtimeHrs >= 10 },
    { id: 'fifty-hours', ico: 'trophy', label: 'Veteran', desc: 'Play for 50 hours', got: playtimeHrs >= 50 },
    { id: 'collector', ico: 'library', label: 'Collector', desc: 'Own 10 games', got: s.owned >= 10 },
    { id: 'librarian', ico: 'box', label: 'Librarian', desc: 'Have 25 games installed', got: s.installed >= 25 },
    { id: 'curator', ico: 'heart', label: 'Curator', desc: 'Favourite 5 games', got: s.favorites >= 5 },
    { id: 'watcher', ico: 'bookmark', label: 'On the lookout', desc: 'Pre-order a game', got: s.preorders >= 1 },
    { id: 'tinkerer', ico: 'link', label: 'Tinkerer', desc: 'Link a local executable', got: s.linked >= 1 },
    // The features that shipped alongside the achievement list itself.
    { id: 'photographer', ico: 'camera', label: 'Photographer', desc: 'Take a screenshot with F2', got: shots >= 1 },
    { id: 'shutterbug', ico: 'image', label: 'Shutterbug', desc: 'Take 10 screenshots', got: shots >= 10 },
    { id: 'overclocked', ico: 'activity', label: 'Overclocked', desc: 'Open the performance overlay', got: overlays >= 1 },
    { id: 'housekeeping', ico: 'trash', label: 'Housekeeping', desc: 'Uninstall a game and get the space back', got: s.uninstalls >= 1 },
    { id: 'indie', ico: 'flame', label: 'Indie supporter', desc: 'Install a game from itch.io', got: allGames().some((g) => g.platform === 'itch' && isInstalled(g.id)) },
    { id: 'sourced', ico: 'zap', label: 'Sourced', desc: 'Install a title from the Nexus catalogue', got: allGames().some((g) => g.provider === 'lightning' && isInstalled(g.id)) }
  ];
  const earned = list.filter((a) => a.got).length;
  list.push({ id: 'well-rounded', ico: 'star', label: 'Well rounded', desc: 'Earn 8 achievements', got: earned >= 8 });

  // `at` is when the user was actually told about it, which is what a gallery
  // wants to show - not when the underlying stat happened to cross a line.
  const when = (State && State.achievements) || {};
  for (const a of list) a.at = when[a.id] || null;

  return { list, earned: earned + (earned >= 8 ? 1 : 0), total: list.length };
}

// ---------------------------------------------------------------------------
// Cloud account panel
// ---------------------------------------------------------------------------
async function renderAccountPanel() {
  const body = document.getElementById('account-body');
  if (!body) return;

  const status = await Api.status();
  const signedIn = !!(status && status.hasToken);
  const email = (State.settings.api && State.settings.api.email) || '';
  const syncAt = State.profile && State.profile.cloudSyncAt;

  if (!status || !status.configured) {
    body.innerHTML = `
      <div class="account-offline">
        ${icon('info', 18)}
        <div>
          <strong>No backend configured.</strong>
          <p>Cloud sync is optional. To enable it, set a server URL in Settings &gt; Account, then come back here to sign in.</p>
        </div>
      </div>`;
    return;
  }

  if (!signedIn) {
    body.innerHTML = `
      <div class="account-auth" id="account-auth">
        <div class="account-tabs">
          <button class="account-tab active" data-account-tab="login">${icon('user', 14)} Sign in</button>
          <button class="account-tab" data-account-tab="register">${icon('plus', 14)} Create account</button>
        </div>
        <div class="account-form" id="account-form">
          <label class="field"><span>Email</span>
            <input type="email" id="acc-email" placeholder="you@example.com" spellcheck="false" autocomplete="email" value="${esc(email)}">
          </label>
          <label class="field" id="acc-name-wrap" hidden><span>Username</span>
            <input type="text" id="acc-name" maxlength="30" placeholder="e.g. Alex" spellcheck="false">
          </label>
          <label class="field"><span>Password</span>
            <input type="password" id="acc-pass" placeholder="At least 6 characters" autocomplete="current-password">
          </label>
          <div class="account-actions">
            <button class="btn primary glow" id="acc-submit">${icon('check', 15)} Sign in</button>
            <span class="account-status" id="acc-status"></span>
          </div>
        </div>
      </div>`;
    wireAccountAuth();
    return;
  }

  body.innerHTML = `
    <div class="account-signed">
      <div class="account-who">
        ${icon('checkCircle', 18)}
        <div>
          <strong>Signed in</strong>
          <small>${esc(email || 'your account')}</small>
        </div>
      </div>
      <div class="account-row">
        <button class="btn primary" id="acc-sync">${icon('refresh', 15)} Sync now</button>
        <button class="btn secondary" id="acc-pull">${icon('download', 15)} Pull from cloud</button>
        <button class="btn danger" id="acc-out">${icon('close', 15)} Sign out</button>
      </div>
      <div class="account-meta">
        ${syncAt ? `${icon('calendar', 13)} Last synced ${esc(timeAgo(syncAt))}` : `${icon('info', 13)} Never synced`}
      </div>
      <div class="account-status" id="acc-status"></span>
    </div>`;
  wireAccountSigned();
}

function wireAccountAuth() {
  let mode = 'login';
  const tabs = document.querySelectorAll('#account-auth .account-tab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    mode = t.dataset.accountTab;
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    const nameWrap = document.getElementById('acc-name-wrap');
    if (nameWrap) nameWrap.hidden = mode !== 'register';
    const submit = document.getElementById('acc-submit');
    if (submit) submit.innerHTML = `${icon(mode === 'register' ? 'plus' : 'check', 15)} ${mode === 'register' ? 'Create account' : 'Sign in'}`;
  }));

  const submit = document.getElementById('acc-submit');
  if (submit) submit.addEventListener('click', async () => {
    const email = (document.getElementById('acc-email') || {}).value || '';
    const password = (document.getElementById('acc-pass') || {}).value || '';
    const username = (document.getElementById('acc-name') || {}).value || '';
    const status = document.getElementById('acc-status');
    if (status) status.textContent = 'Working…';

    const res = mode === 'register'
      ? await apiSignIn({ email, password, username }, true)
      : await apiSignIn({ email, password }, false);

    if (!res.ok) {
      if (status) { status.textContent = res.error; status.classList.add('err'); }
      toast(res.error, 'warn');
      return;
    }
    toast(mode === 'register' ? 'Account created' : 'Signed in', 'check');
    await renderAccountPanel();
    if (current === 'profile') render(true);
  });
}

function wireAccountSigned() {
  const status = document.getElementById('acc-status');
  const syncBtn = document.getElementById('acc-sync');
  if (syncBtn) syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.innerHTML = `${icon('refresh', 15)} Syncing…`;
    const res = await apiPushProfile();
    syncBtn.disabled = false;
    syncBtn.innerHTML = `${icon('refresh', 15)} Sync now`;
    if (!res.ok) {
      if (status) { status.textContent = res.error; status.classList.add('err'); }
      toast(res.error, 'warn');
      return;
    }
    if (status) { status.textContent = 'Synced.'; status.classList.remove('err'); }
    toast('Profile synced to the cloud', 'check');
    await renderAccountPanel();
  });

  const pullBtn = document.getElementById('acc-pull');
  if (pullBtn) pullBtn.addEventListener('click', async () => {
    pullBtn.disabled = true;
    pullBtn.innerHTML = `${icon('download', 15)} Pulling…`;
    const res = await apiPullProfile();
    pullBtn.disabled = false;
    pullBtn.innerHTML = `${icon('download', 15)} Pull from cloud`;
    if (!res.ok) {
      if (status) { status.textContent = res.error; status.classList.add('err'); }
      toast(res.error, 'warn');
      return;
    }
    if (status) { status.textContent = 'Pulled.'; status.classList.remove('err'); }
    toast('Profile updated from the cloud', 'check');
    paintProfileChrome();
    if (current === 'profile') render(true);
  });

  const outBtn = document.getElementById('acc-out');
  if (outBtn) outBtn.addEventListener('click', async () => {
    await apiSignOut();
    toast('Signed out', 'info');
    await renderAccountPanel();
    paintProfileChrome();
  });
}
function recentlyPlayed() {
  const last = (State.stats && State.stats.lastPlayed) || {};
  const rows = Object.entries(last)
    .map(([id, at]) => ({ g: byId(id), at }))
    .filter((r) => r.g)
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
  if (!rows.length) return '';
  return `<div class="recent-list">${rows.map((r) => `
    <div class="recent-row clickable" data-card="${r.g.id}">
      <div class="recent-art">${art(r.g, 'wide')}</div>
      <div class="recent-text">
        <strong>${esc(r.g.title)}</strong>
        <small>${esc(fmtPlaytime(playtimeOf(r.g.id)))} played &middot; ${esc(timeAgo(r.at))}</small>
      </div>
      ${pill(r.g.id)}
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function openProfileEditor() {
  const p = State.profile || {};
  let pendingAvatarPath = p.avatar;
  let pendingAvatarUrl = p.avatarUrl;

  openModal({
    title: 'Edit profile',
    ico: 'user',
    body: `
      <div class="profile-editor">
        <div class="pe-avatar">
          <div class="pe-avatar-frame" id="pe-frame">${avatarMarkup(120)}</div>
          <div class="pe-avatar-actions">
            <button class="btn secondary sm" id="pe-pick">${icon('camera', 15)} Choose picture\u2026</button>
            <button class="btn danger sm" id="pe-clear" ${p.avatarUrl ? '' : 'disabled'}>${icon('trash', 15)} Remove</button>
          </div>
          <small class="pe-hint">PNG, JPG or WebP. Stored on this PC only.</small>
        </div>
        <div class="pe-fields">
          <label class="field"><span>Display name</span>
            <input id="pe-name" type="text" maxlength="40" placeholder="e.g. Alex" value="${esc(p.name || '')}" spellcheck="false">
          </label>
          <label class="field"><span>About (optional)</span>
            <textarea id="pe-bio" maxlength="160" rows="3" placeholder="A line about you">${esc(p.bio || '')}</textarea>
          </label>
          <div class="pe-note">${icon('shield', 14)} This profile lives only on this computer. Apex has no accounts and uploads nothing.</div>
        </div>
      </div>`,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>
      <button class="btn primary glow" id="pe-save">${icon('save', 15)} Save profile</button>`,
    onMount: (root) => {
      const frame = root.querySelector('#pe-frame');
      const render = () => {
        frame.innerHTML = `<span class="avatar-img ${pendingAvatarUrl ? '' : 'empty'}" style="width:120px;height:120px">
          ${pendingAvatarUrl ? `<img src="${esc(pendingAvatarUrl)}" alt="" draggable="false">` : icon('user', 56)}</span>`;
      };

      root.querySelector('#pe-pick').addEventListener('click', async () => {
        const picked = await window.api.pickImage(pendingAvatarPath || undefined);
        if (!picked) return;
        const url = await window.api.readImage(picked);
        if (!url) { toast('That image could not be read (unsupported format or too large)', 'warn'); return; }
        pendingAvatarPath = picked;
        pendingAvatarUrl = url;
        render();
        toast('Picture ready \u2014 hit Save to keep it', 'info');
      });

      root.querySelector('#pe-clear').addEventListener('click', () => {
        pendingAvatarPath = null;
        pendingAvatarUrl = null;
        render();
      });

      root.querySelector('#pe-save').addEventListener('click', async () => {
        const name = root.querySelector('#pe-name').value.trim();
        const bio = root.querySelector('#pe-bio').value.trim();
        State.profile = {
          ...(State.profile || {}),
          name,
          bio,
          avatar: pendingAvatarPath || null,
          avatarUrl: pendingAvatarUrl || null,
          createdAt: (State.profile && State.profile.createdAt) || Date.now()
        };
        await persist();
        paintProfileChrome();
        closeModal();
        if (current === 'profile') render(true);
        toast(name ? `Profile saved \u2014 welcome, ${name}` : 'Profile saved', 'check');
      });
    }
  });
}
