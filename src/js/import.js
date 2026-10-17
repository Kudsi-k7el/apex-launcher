'use strict';

/**
 * "Import a folder" — turns games that are already on disk into library
 * entries. This is entirely local: the chosen folder is walked for launchable
 * executables (main process) and each entry the user ticks becomes a custom
 * library record with a real executable link, so it can be launched and
 * tracked like anything else.
 */

/** Human-readable byte size for the import list. */
function fmtBytes(n) {
  if (!n || n < 0) return '\u2014';
  const mb = n / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Adds a single scanned executable as a custom, launchable library game. */
async function importGameEntry(entry) {
  const g = makeCustomGame({
    title: entry.name,
    developer: 'Local folder',
    genre: 'Imported',
    icon: entry.icon || null     // the icon Windows shows for the .exe
  });
  State.custom = State.custom || [];
  State.custom.push(g);
  State.installed[g.id] = true;
  State.owned[g.id] = true;
  State.local = State.local || { installs: {}, roots: {}, stores: {} };
  State.local.installs[g.id] = { type: 'exe', exe: entry.exe, cwd: entry.dir || null, name: entry.name, source: 'manual' };
  await persist();
  afterLibraryChange();
  toast(`${entry.name} added to your library`, 'check');
}

/** Prompts for a folder, scans it and offers the executables it found. */
async function importFolder() {
  const dir = await window.api.pickFolder(State.settings.installPath);
  if (!dir) return;

  const res = await window.api.scanFolder(dir);
  if (!res || !res.ok) {
    toast(`Could not scan that folder: ${(res && res.error) || 'unknown error'}`, 'warn');
    return;
  }
  if (!res.games.length) {
    toast('No launchable executables were found in that folder', 'info');
    return;
  }

  const body = `
    <div class="import-head">${icon('folder', 15)} <code>${esc(res.root)}</code></div>
    <div class="import-list">
      ${res.games.map((g, i) => `<label class="import-row">
        <input type="checkbox" data-imp="${i}" checked>
        ${g.icon
          ? `<img class="import-ico" src="${g.icon}" alt="" draggable="false">`
          : `<span class="import-ico blank">${icon('hardDrive', 16)}</span>`}
        <div class="import-info"><strong>${esc(g.name)}</strong><small>${esc(g.exe)}</small></div>
        <span class="import-size">${fmtBytes(g.size)}</span>
      </label>`).join('')}
    </div>`;

  openModal({
    title: `Import ${res.games.length} game${res.games.length === 1 ? '' : 's'}`,
    ico: 'folder',
    body,
    footer: `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>
      <button class="btn primary glow" id="imp-save">${icon('plus', 15)} Add selected</button>`,
    onMount(elm) {
      const all = elm.querySelectorAll('[data-imp]');
      elm.querySelector('#imp-save').addEventListener('click', async () => {
        const picked = [...all].filter((c) => c.checked).map((c) => res.games[+c.dataset.imp]);
        closeModal();
        if (!picked.length) return;
        for (const g of picked) await importGameEntry(g);
      });
    }
  });
}
