'use strict';

/**
 * Changelog ("What's new").
 * -------------------------------------------------------------------------
 * The entries ship with the app (data/changelog.json), so this works offline and
 * cannot be rewritten from a server. It shows itself once after an update -
 * `State.seenChangelog` remembers which version the user has already read - and
 * stays reachable afterwards from Settings and the title bar.
 */

let changelogCache = null;

async function loadChangelog() {
  if (changelogCache) return changelogCache;
  try {
    changelogCache = await window.api.changelogList();
  } catch {
    changelogCache = { ok: true, version: '', entries: [] };
  }
  return changelogCache;
}

function fmtVersionDate(d) {
  if (!d) return '';
  const parsed = new Date(`${String(d).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(d);
  try {
    return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return String(d); }
}

function changelogEntryHtml(entry, current, first) {
  const sections = (entry.sections || []).map((sec) => `
    <div class="cl-section">
      <h5>${esc(sec.title || '')}</h5>
      <ul>${(sec.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    </div>`).join('');

  return `
    <article class="cl-entry${first ? ' current' : ''}">
      <header class="cl-head">
        <span class="cl-ver">v${esc(entry.version || '?')}</span>
        ${entry.version === current ? '<span class="cl-badge">You are here</span>' : ''}
        ${entry.date ? `<span class="cl-date">${esc(fmtVersionDate(entry.date))}</span>` : ''}
      </header>
      ${entry.title ? `<h4>${esc(entry.title)}</h4>` : ''}
      ${entry.summary ? `<p class="cl-summary">${esc(entry.summary)}</p>` : ''}
      ${sections}
    </article>`;
}

/**
 * The full history.
 *
 * @param {object} [opts]
 * @param {string} [opts.version] - the version to treat as current
 * @param {boolean} [opts.fresh]  - true when this is the automatic after-update show
 */
/**
 * Which version counts as "this build".
 *
 * Normally that is simply app.getVersion(). When the app is started straight
 * from a script (a test harness, `electron main.js`) Electron reports its own
 * version instead, so the newest documented entry is the honest fallback.
 */
function changelogCurrent(data) {
  const entries = data.entries || [];
  const v = String(data.version || '');
  if (entries.some((e) => String(e.version) === v)) return v;
  return (entries[0] && String(entries[0].version)) || v;
}

async function openChangelog(opts = {}) {
  const data = await loadChangelog();
  const entries = data.entries || [];
  const current = opts.version || changelogCurrent(data);

  if (!entries.length) {
    openModal({
      title: "What's new",
      ico: 'news',
      body: `<p class="cl-summary">No changelog is bundled with this build.</p>`
    });
    return;
  }

  const [latest, ...older] = entries;

  const body = `
    <div class="cl-hero">
      <span class="cl-hero-ico">${icon('zap', 22)}</span>
      <div>
        <strong>${opts.fresh ? 'Apex Launcher was updated' : 'What has changed'}</strong>
        <small>You are on v${esc(current || latest.version || '?')}${current && latest.version !== current
          ? ` \u00b7 the newest entries below are ahead of your build`
          : ''}</small>
      </div>
    </div>
    ${changelogEntryHtml(latest, current, true)}
    ${older.length ? `
      <button class="cl-toggle" id="cl-toggle">${icon('list', 14)} Older releases (${older.length})</button>
      <div class="cl-older" id="cl-older" hidden>
        ${older.map((e) => changelogEntryHtml(e, current, false)).join('')}
      </div>` : ''}`;

  openModal({
    title: "What's new",
    ico: 'news',
    body,
    footer: `<button class="btn primary" data-modal-close>Got it</button>`,
    onMount(el) {
      const toggle = el.querySelector('#cl-toggle');
      const olderEl = el.querySelector('#cl-older');
      if (toggle && olderEl) {
        toggle.addEventListener('click', () => {
          olderEl.hidden = !olderEl.hidden;
          toggle.innerHTML = olderEl.hidden
            ? `${icon('list', 14)} Older releases (${older.length})`
            : `${icon('close', 14)} Hide older releases`;
        });
      }
    }
  });
}

/**
 * Shows the changelog by itself the first time the app runs after an update.
 * @returns {Promise<boolean>} whether it opened
 */
async function maybeShowChangelog() {
  const data = await loadChangelog();
  const entries = data.entries || [];
  const version = changelogCurrent(data);
  if (!entries.length || !version) return false;
  if (State.seenChangelog === version) return false;

  // Mark it read first: if the modal fails to open, the user should not be
  // greeted by it again on every single launch.
  State.seenChangelog = version;
  await persist();
  await openChangelog({ version, fresh: true });
  return true;
}
