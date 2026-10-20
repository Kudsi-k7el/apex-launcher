'use strict';

/**
 * Lightweight modal system plus the three dialogs the local-games feature
 * needs: scan results, "add a custom game", and game properties.
 */

function modalRoot() {
  return document.getElementById('modal-root');
}

function closeModal() {
  const root = modalRoot();
  if (!root) return;
  const el = root.querySelector('.modal-backdrop');
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 180);
}

function openModal({ title, ico = 'info', body, footer = '', onMount }) {
  const root = modalRoot();
  if (!root) return null;

  // Replace any open dialog immediately (avoids stacking backdrops).
  root.querySelectorAll('.modal-backdrop').forEach((n) => n.remove());

  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <header class="modal-head">
      <span class="modal-ico">${icon(ico, 18)}</span>
      <h3>${esc(title)}</h3>
      <button class="icon-btn sm" data-modal-close title="Close">${icon('close', 16)}</button>
    </header>
    <div class="modal-body">${body}</div>
    ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
  </div>`;

  root.appendChild(el);
  // The class goes on one frame later so the fade and lift have a first state to
  // animate from. The timer is the belt to that braces: a window that is
  // occluded, minimised or otherwise not producing frames can leave a dialog
  // sitting in the DOM fully opaque-but-invisible, which is a dialog nobody can
  // use. Marking it visible twice is harmless.
  const reveal = () => { if (el.isConnected) el.classList.add('show'); };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);

  el.addEventListener('click', (e) => { if (e.target === el) closeModal(); });
  el.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeModal));

  if (onMount) onMount(el);
  // Dialog headings and bodies are assembled from the same English strings as
  // the views, so the same pass covers them.
  if (typeof applyI18n === 'function') applyI18n(el);
  return el;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------------------------------------------------------------------------
// Shared partials
// ---------------------------------------------------------------------------
/** A small preview object so the fallback banner can render for anything. */
function previewGame(name, developer, appId) {
  return {
    id: 'preview',
    title: name || 'New Game',
    developer: developer || 'Local',
    genre: '',
    // A Steam detection knows the real AppID, so the row can show that game's
    // own banner from the CDN instead of the generated placeholder.
    steamAppId: appId ? String(appId) : null
  };
}

function detectedRow(d, index) {
  // Store sources (steam/epic/gog/ubisoft/ea/battlenet/xbox) get their display
  // name from the store registry; anything else is a locally linked executable.
  const store = typeof storeById === 'function' ? storeById(d.source) : null;
  const sourceLabel = store ? store.name
    : d.source === 'steam' ? 'Steam'
      : d.source === 'epic' ? 'Epic Games'
        : 'Local';
  return `<div class="detected-row">
    <div class="detected-art">${art(previewGame(d.name, sourceLabel, d.type === 'steam' ? d.appId : null), 'wide')}</div>
    <div class="detected-info">
      <strong>${esc(d.name)}</strong>
      <small>${esc(sourceLabel)}${d.appId ? ` \u00b7 App ${esc(d.appId)}` : ''}${d.path ? ` \u00b7 ${esc(d.path)}` : ''}</small>
    </div>
    <button class="btn primary sm" data-add-detected="${index}">${icon('plus', 14)} Add</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------
function openDetectedModal(result, onAdd) {
  const matchedCount = Object.keys(result.matched || {}).length;
  const unknown = result.unknown || [];
  const roots = result.roots || {};

  const body = `
    <div class="scan-summary">
      <div class="scan-stat"><small>Steam installs</small><strong>${(result.counts && result.counts.steam) || 0}</strong></div>
      <div class="scan-stat"><small>Epic installs</small><strong>${(result.counts && result.counts.epic) || 0}</strong></div>
      <div class="scan-stat"><small>Matched to library</small><strong>${matchedCount}</strong></div>
      <div class="scan-stat"><small>New titles</small><strong>${unknown.length}</strong></div>
    </div>

    <div class="scan-roots">
      <div><span class="sr-ico">${icon('hardDrive', 14)}</span><code>${esc(roots.steam || 'Steam library not found')}</code></div>
      <div><span class="sr-ico">${icon('globe', 14)}</span><code>${esc(roots.epic || 'Epic Games not found')}</code></div>
    </div>

    <h4 class="modal-sub">${icon('sparkles', 15)} Other games found on this PC</h4>
    <div class="detected-list">
      ${unknown.length
        ? unknown.map((d, i) => detectedRow(d, i)).join('')
        : `<div class="empty show sm">${icon('info', 22)}<p>No extra titles were detected. Linked games were added to your library.</p></div>`}
    </div>`;

  openModal({
    title: 'Scan for installed games',
    ico: 'search',
    body,
    footer: `<button class="btn secondary" data-modal-close>${icon('check', 15)} Done</button>`,
    onMount(el) {
      el.querySelectorAll('[data-add-detected]').forEach((b) => b.addEventListener('click', async () => {
        const d = unknown[+b.dataset.addDetected];
        if (!d) return;
        b.disabled = true;
        b.innerHTML = `${icon('check', 14)} Added`;
        if (onAdd) await onAdd(d);
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Add a custom game
// ---------------------------------------------------------------------------
function openAddGameModal(onCreate) {
  const body = `
    <div class="form-grid">
      <label class="field"><span>Title *</span>
        <input id="cg-title" type="text" placeholder="My Game" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Developer</span>
        <input id="cg-dev" type="text" placeholder="Studio" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Genre</span>
        <input id="cg-genre" type="text" placeholder="Action" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Cover art URL (optional)</span>
        <input id="cg-img" type="text" placeholder="https://\u2026" autocomplete="off" spellcheck="false"></label>
      <label class="field wide"><span>Executable</span>
        <div class="field-row">
          <input id="cg-exe" type="text" placeholder="No executable selected" readonly>
          <button class="btn secondary" id="cg-browse">${icon('folder', 15)} Browse\u2026</button>
        </div>
      </label>
    </div>

    <div class="banner-preview">
      <div class="bp-frame" id="cg-preview"></div>
      <div class="bp-note">${icon('sparkles', 14)} If no cover art is available, Apex generates a typographic banner automatically.</div>
    </div>`;

  const footer = `<button class="btn secondary" data-modal-close>${icon('close', 15)} Cancel</button>
    <button class="btn primary glow" id="cg-save">${icon('plus', 15)} Add game</button>`;

  openModal({
    title: 'Add a custom game',
    ico: 'plus',
    body,
    footer,
    onMount(el) {
      const title = el.querySelector('#cg-title');
      const dev = el.querySelector('#cg-dev');
      const genre = el.querySelector('#cg-genre');
      const img = el.querySelector('#cg-img');
      const exe = el.querySelector('#cg-exe');
      const preview = el.querySelector('#cg-preview');

      const paint = () => {
        preview.innerHTML = art({
          id: 'preview',
          title: title.value.trim() || 'New Game',
          developer: dev.value.trim() || 'Local',
          genre: genre.value.trim(),
          cover: img.value.trim() || null
        }, 'wide');
      };
      [title, dev, genre, img].forEach((i) => i.addEventListener('input', paint));
      paint();

      el.querySelector('#cg-browse').addEventListener('click', async () => {
        const picked = await window.api.pickExecutable(exe.value || undefined);
        if (picked) { exe.value = picked; toast('Executable linked', 'check'); }
      });

      el.querySelector('#cg-save').addEventListener('click', async () => {
        const name = title.value.trim();
        if (!name) { toast('Please enter a title', 'warn'); title.focus(); return; }
        await onCreate({
          title: name,
          developer: dev.value.trim(),
          genre: genre.value.trim(),
          exe: exe.value.trim() || null,
          imageUrl: img.value.trim() || null
        });
        closeModal();
      });

      title.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------
function openPropertiesModal(g) {
  const t = localLink(g.id);
  const sourceLabel = t ? (SOURCE_LABEL[t.type] || 'Linked') : 'Not linked';
  const target = t ? (t.exe || t.uri || t.path || '\u2014') : 'No executable or URI linked yet';

  const row = (k, v) => `<div class="prop-row"><span>${k}</span><code>${esc(v == null || v === '' ? '\u2014' : v)}</code></div>`;

  const body = `
    <div class="prop-art">${art(g, 'wide')}</div>
    <div class="prop-rows">
      ${row('Title', g.title)}
      ${row('Developer', g.developer)}
      ${row('Genre', g.genre)}
      ${row('Released', g.release)}
      ${row('Size', fmtSize(g.size))}
      ${row('Rating', g.rating ? `${g.rating} / 5` : '\u2014')}
      ${row('Tags', (g.tags || []).join(', '))}
    </div>
    <h4 class="modal-sub">${icon('cpu', 15)} Local install</h4>
    <div class="prop-rows">
      ${row('Status', STATUS_LABEL[statusOf(g.id)])}
      ${row('Launch source', sourceLabel)}
      ${row('Executable / URI', target)}
      ${row('Install folder', t && t.path ? t.path : '\u2014')}
    </div>
    <h4 class="modal-sub">${icon('image', 15)} Artwork</h4>
    <p class="art-note">Give this game your own cover, banner and hero image. Saved locally on this PC.</p>
    <div class="art-set">
      <div class="art-set-row">
        <input type="url" id="art-url" class="art-input" spellcheck="false"
          placeholder="Paste an image URL (https://\u2026)"
          value="${esc(State.art[g.id] && /^https?:/i.test(State.art[g.id]) ? State.art[g.id] : '')}">
        <button class="btn secondary" id="art-use">${icon('check', 15)} Use URL</button>
      </div>
      <div class="art-set-row">
        <button class="btn secondary" id="art-file">${icon('folder', 15)} Choose a file\u2026</button>
        <button class="btn danger" id="art-reset" ${State.art[g.id] ? '' : 'disabled'}>${icon('trash', 15)} Reset</button>
      </div>
    </div>`;

  openModal({
    title: g.title,
    ico: 'info',
    body,
    footer: `<button class="btn secondary" data-modal-close>${icon('check', 15)} Close</button>
      ${t && t.path ? `<button class="btn secondary" id="prop-open">${icon('external', 15)} Open folder</button>` : ''}`
      + `<button class="btn primary glow" id="prop-locate">${icon('folder', 15)} Locate executable</button>`,
    onMount(el) {
      const repaint = () => {
        const box = el.querySelector('.prop-art');
        if (box) box.innerHTML = art(g, 'wide');
        const reset = el.querySelector('#art-reset');
        if (reset) reset.disabled = !State.art[g.id];
      };
      const apply = async (value, msg) => {
        if (value) State.art[g.id] = value; else delete State.art[g.id];
        await persist();
        repaint();
        render();               // keep the open detail hero in sync
        refreshActions();
        toast(msg, 'check');
      };

      const urlInput = el.querySelector('#art-url');
      el.querySelector('#art-use').addEventListener('click', () => {
        const v = (urlInput.value || '').trim();
        if (!/^https?:\/\//i.test(v)) { toast('Paste a direct image URL that starts with https://', 'warn'); return; }
        apply(v, 'Artwork updated from URL');
      });
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.querySelector('#art-use').click(); });

      el.querySelector('#art-file').addEventListener('click', async () => {
        const picked = await window.api.pickImage();
        if (!picked) return;
        const url = await window.api.readImage(picked);
        if (!url) { toast('That image could not be read (unsupported format or too large)', 'warn'); return; }
        urlInput.value = '';
        apply(url, 'Artwork updated from file');
      });

      el.querySelector('#art-reset').addEventListener('click', () => { urlInput.value = ''; apply(null, 'Artwork reset to the default'); });

      const openBtn = el.querySelector('#prop-open');
      if (openBtn) openBtn.addEventListener('click', () => openLocalPath(t.path));
      el.querySelector('#prop-locate').addEventListener('click', async () => {
        const picked = await window.api.pickExecutable(t && t.exe ? t.exe : undefined);
        if (!picked) return;
        State.local.installs[g.id] = { type: 'exe', exe: picked, cwd: null, name: g.title, source: 'manual' };
        State.installed[g.id] = true;
        State.owned[g.id] = true;
        await persist();
        refreshActions();
        closeModal();
        toast(`${g.title} linked to ${picked}`, 'check');
      });
    }
  });
}
