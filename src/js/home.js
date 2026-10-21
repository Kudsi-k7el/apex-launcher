'use strict';

/**
 * Home view.
 *
 * The landing page: the wordmark, the four doors most people want on the first
 * screen, the Discord card, and a row of whatever was played last. Everything
 * here is a shortcut into a surface that already exists - no new state.
 */

/** Titles to show in "Jump back in": played first, then owned, newest first. */
function homeRecent(limit = 6) {
  const lastPlayed = (State.stats && State.stats.lastPlayed) || {};
  const games = (typeof allGames === 'function' ? allGames() : [])
    .filter((g) => g && g.id && (State.installed[g.id] || State.owned[g.id] || lastPlayed[g.id]))
    .sort((a, b) => {
      const playA = lastPlayed[a.id] || 0;
      const playB = lastPlayed[b.id] || 0;
      if (playA !== playB) return playB - playA;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  return games.slice(0, limit);
}

function homeTile(g) {
  const played = State.stats && State.stats.lastPlayed && State.stats.lastPlayed[g.id];
  return `<button class="home-tile" data-act="play" data-id="${esc(g.id)}" title="Launch ${esc(g.title)}">
    <span class="home-tile-art">${art(g, 'cover')}<span class="home-tile-play">${icon('play', 20)}</span></span>
    <span class="home-tile-name">${esc(g.title)}</span>
    <span class="home-tile-meta">${played
      ? `${icon('clock', 11)} ${esc(timeAgo(new Date(played).toISOString()))}`
      : `${icon('gamepad', 11)} Ready`}</span>
  </button>`;
}

/** The Quick guide: what each section is for, in the order the nav shows them. */
function homeGuide() {
  const rows = [
    ['store', 'Store', 'The curated catalogue and the whole Steam store, side by side.'],
    ['library', 'Library', 'Everything you own or installed, with collections, filters and updates.'],
    ['zap', 'Nexus', 'The multi-provider catalogue: one title, several mirrors, automatic failover.'],
    ['gamepad', 'Emulators', 'Consoles, emulator downloads and your own game files.'],
    ['download', 'Downloads', 'Live transfers with pause, resume and a queue.'],
    ['shield', 'Apex Tools', 'Steam helpers, the fix catalogues and your installed titles.'],
    ['tv', 'Big Picture', 'The controller-only, full-screen layout, with an on-screen keyboard.'],
    ['settings', 'Settings', 'Language, theme, interface, sound, controller and account.']
  ];
  return `<div class="guide-list">
    ${rows.map(([ico, name, text]) => `<div class="guide-row">
      <span class="guide-ico">${icon(ico, 17)}</span>
      <div><strong>${name}</strong><small>${text}</small></div>
    </div>`).join('')}
  </div>`;
}

function homeLegal() {
  return `<div class="legal-note">
    <p><strong>Apex Launcher</strong> is a personal project: a single window for the games
    already on this PC, the stores they come from, and the tools around them.</p>
    <p>Game titles, cover art and platform names belong to their publishers. Apex shows them
    to identify the game; it does not claim them. News headlines come from
    <b>news.instant-gaming.com</b> and every story opens on that site.</p>
    <p>Anything Apex changes on disk - a fix, a replaced library, an imported folder - is
    backed up first and listed in the app. Nothing is uploaded anywhere without a server you
    configured yourself.</p>
  </div>`;
}

/** The Discord/community card, matching the hero's right-hand block. */
function homeSocialCard() {
  return `<div class="home-social">
    <img class="home-mark sm" src="img/apex-mark.png" alt="" draggable="false">
    <div class="home-social-txt">
      <strong>PROJECT APEX</strong>
      <small>Join the community</small>
    </div>
    <button class="home-join" data-home-act="discord">Join</button>
  </div>`;
}

function renderHome(el) {
  clearInterval(slideTimer);

  const recent = homeRecent();
  el.innerHTML = `
    <section class="home">
      <div class="home-hero">
        <div class="home-copy">
          <p class="home-kicker">Welcome to</p>
          <h1 class="home-title">
            <span class="home-spark">${icon('zap', 26)}</span>
            <span class="home-word">PROJECT APEX</span>
            <span class="home-spark">${icon('zap', 26)}</span>
          </h1>
          <p class="home-tag">Play as you want <span class="home-tag-mark">${icon('arrowUpRight', 15)}</span></p>

          <div class="home-actions">
            <button class="home-btn" data-home-act="guide">Quick guide</button>
            <button class="home-btn" data-home-act="changelog">Changelog</button>
            <button class="home-btn" data-home-act="legal">Legal notice</button>
            <button class="home-btn" data-home-act="discord">Discord</button>
          </div>

          ${homeSocialCard()}
        </div>

        <div class="home-art" aria-hidden="true">
          <img class="home-mark" src="img/apex-mark.png" alt="" draggable="false">
        </div>
      </div>

      <div class="home-recent ${recent.length ? '' : 'is-empty'}" id="home-recent">
        <div class="home-recent-head">
          <h2>Jump back in</h2>
          ${recent.length ? `<button class="home-more" data-view="library">Open library ${icon('right', 14)}</button>` : ''}
        </div>
        ${recent.length
          ? `<div class="home-strip">${recent.map(homeTile).join('')}</div>`
          : `<p class="home-empty">Nothing installed yet. The Store is one click up there.</p>`}
      </div>
    </section>`;

  el.querySelector('.home').addEventListener('click', async (e) => {
    const more = e.target.closest('[data-view]');
    if (more) { switchView(more.dataset.view); return; }

    const btn = e.target.closest('[data-home-act]');
    if (!btn) return;
    const act = btn.dataset.homeAct;

    if (act === 'guide') {
      openModal({ title: 'Quick guide', ico: 'rocket', body: homeGuide(), footer: '' });
      return;
    }
    if (act === 'changelog') { openChangelog(); return; }
    if (act === 'legal') {
      openModal({ title: 'Legal notice', ico: 'shield', body: homeLegal(), footer: '' });
      return;
    }
    if (act === 'discord') {
      const ok = await window.api.openExternal('https://discord.com/users/z1.f');
      if (!ok) toast('Could not open Discord', 'warn');
    }
  });
}
