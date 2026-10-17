'use strict';

/**
 * "Delete this game" - the dialog behind Uninstall.
 *
 * Two different wants hide behind one word, so the dialog always offers both and
 * says out loud what each one does:
 *
 *   - *Uninstall* really deletes the files. The main process decides which
 *     folders that means (see uninstall.js) and this dialog only displays the
 *     plan it returns, so the user sees the exact paths and size before agreeing.
 *   - *Remove from library* is the old behaviour: nothing on disk moves.
 *
 * Content another launcher owns (a Steam or Epic install) is never deleted by
 * Apex. For those the dialog offers the store's own uninstaller instead.
 */

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

/** The folder list, with the reason shown for anything Apex refuses to touch. */
function uninstallPathRows(plan) {
  const paths = (plan && plan.paths) || [];
  if (!paths.length) {
    return `<div class="un-row muted">${icon('info', 14)}<code>Apex has no folder recorded for this title</code></div>`;
  }
  return paths.map((p) => `<div class="un-row${p.blocked ? ' blocked' : ''}">
    ${icon(p.blocked ? 'lock' : 'hardDrive', 14)}
    <code title="${esc(p.path)}">${esc(shortPath(p.path))}</code>
    <span>${p.blocked
      ? esc(p.reason || 'protected')
      : `${p.approximate ? '~' : ''}${fmtBytes(p.bytes)}`}</span>
  </div>`).join('');
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function openUninstallModal(id) {
  const g = byId(id);
  if (!g) return;

  let plan = null;
  try { plan = await window.api.uninstallPlan(id); } catch { plan = null; }
  if (plan && plan.ok === false) plan = null;

  const storeKey = plan && plan.store;
  const storeMeta = storeKey ? storeById(storeKey) : null;
  const storeName = storeMeta ? storeMeta.name : (storeKey ? storeKey : null);
  const total = plan ? fmtBytes(plan.bytes) : '';
  const canDelete = !!(plan && plan.canDelete);

  const body = `
    <div class="un-head">
      <div class="un-art">${art(g, 'wide')}</div>
      <div class="un-headtext">
        <strong>${esc(g.title)}</strong>
        <small>${esc(g.developer || 'Unknown developer')}${g.size ? ` &middot; ${fmtSize(g.size)}` : ''}</small>
      </div>
    </div>

    <div class="un-grid">
      <div class="un-card danger">
        <h4>${icon('trash', 15)} Uninstall</h4>
        ${canDelete
          ? `<p>Permanently deletes the files Apex installed and frees about
               <strong>${esc(total)}</strong>. This cannot be undone.</p>`
          : `<p>${storeName
              ? `These files belong to ${esc(storeName)}. Uninstall there and ${esc(storeName)} removes them properly.`
              : 'Apex has nothing on disk to delete for this title.'}</p>`}
        ${uninstallPathRows(plan)}
      </div>

      <div class="un-card">
        <h4>${icon('library', 15)} Remove from library</h4>
        <p>Hides <strong>${esc(g.title)}</strong> from your Library and keeps every file
           exactly where it is. A later scan will not add it back on its own.</p>
      </div>
    </div>

    ${plan && plan.reason && !canDelete ? `<p class="un-note">${icon('info', 14)} ${esc(plan.reason)}</p>` : ''}
    <p class="un-note">${icon('shield', 14)} Apex only ever deletes folders it installed itself.
      Drive roots, system folders, your Documents/Downloads roots and other launchers' libraries are refused.</p>`;

  const footer = [
    `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>`,
    `<button class="btn secondary" id="un-library">${icon('library', 15)} Remove from library</button>`,
    canDelete
      ? `<button class="btn danger" id="un-delete">${icon('trash', 15)} Uninstall &amp; delete files</button>`
      : (storeName ? `<button class="btn primary" id="un-store">${icon('external', 15)} Uninstall in ${esc(storeName)}</button>` : '')
  ].join('');

  openModal({
    title: 'Uninstall',
    ico: 'trash',
    body,
    footer,
    onMount(el) {
      const lib = el.querySelector('#un-library');
      if (lib) lib.addEventListener('click', async () => {
        closeModal();
        await removeFromLibrary(id);
      });

      const del = el.querySelector('#un-delete');
      if (del) del.addEventListener('click', async () => {
        del.disabled = true;
        del.innerHTML = `${icon('refresh', 15)} Deleting\u2026`;
        lib && (lib.disabled = true);

        let res = null;
        try { res = await window.api.uninstallDelete(id); } catch { res = null; }

        const freed = res && res.freed ? fmtBytes(res.freed) : null;
        const failed = res && res.errors && res.errors.length ? res.errors[0].error : null;
        const refused = res && res.blocked && res.blocked.length ? res.blocked[0].reason : null;

        if (res && res.removed && res.removed.length) {
          closeModal();
          toast(`${g.title} uninstalled${freed ? ` \u00b7 ${freed} freed` : ''}`, 'check');
        } else {
          del.disabled = false;
          del.innerHTML = `${icon('trash', 15)} Try again`;
          lib && (lib.disabled = false);
          toast(failed || refused || 'Nothing could be deleted', 'warn');
          return;
        }
        await removeFromLibrary(id, { silent: true });
      });

      const store = el.querySelector('#un-store');
      if (store) store.addEventListener('click', async () => {
        const res = await window.api.uninstallStore(id).catch(() => null);
        if (res && res.ok) {
          toast(`Opening ${storeName}\u2026`, 'check');
          closeModal();
        } else {
          toast(`Open ${storeName || 'your launcher'} and uninstall it there`, 'info');
        }
      });
    }
  });
}
