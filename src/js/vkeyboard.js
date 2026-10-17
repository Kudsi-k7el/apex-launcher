'use strict';

/**
 * On-screen keyboard for controller users.
 *
 * When a controller is connected, typing into a search box is awkward: the
 * physical keyboard is across the room. This module shows a virtual keyboard
 * the moment a search field receives focus, navigable with the d-pad and the
 * A button, so the whole app stays usable from the sofa.
 *
 * It only appears when a pad is actually connected (GP.first() is truthy) and
 * only for text/search inputs, so mouse-and-keyboard users never see it.
 */

const VK_LAYOUT = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
  ['Space','Back','Clear','Done']
];

let vkOpen = false;
let vkTarget = null;
let vkShift = false;
let vkRow = 0;
let vkCol = 0;
let vkEl = null;

function vkEnsure() {
  if (vkEl) return vkEl;
  const el = document.createElement('div');
  el.id = 'vkbd';
  el.className = 'vkbd hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'On-screen keyboard');
  el.innerHTML = `
    <div class="vkbd-panel">
      <div class="vkbd-head">
        <span class="vkbd-title">${icon('edit', 16)} On-screen keyboard</span>
        <button class="vkbd-close" data-vk="close" title="Close">${icon('close', 16)}</button>
      </div>
      <div class="vkbd-preview" id="vkbd-preview"></div>
      <div class="vkbd-keys" id="vkbd-keys"></div>
      <div class="vkbd-hint">D-pad moves \u00b7 A selects \u00b7 B closes \u00b7 LB/RB shifts case</div>
    </div>`;
  document.body.appendChild(el);
  vkEl = el;
  vkRenderKeys();
  return el;
}

function vkRenderKeys() {
  const wrap = document.getElementById('vkbd-keys');
  if (!wrap) return;
  wrap.innerHTML = VK_LAYOUT.map((row, ri) => `
    <div class="vkbd-row" data-row="${ri}">
      ${row.map((k, ci) => {
        const label = k === 'Space' ? 'Space' : k === 'Back' ? '\u232b' : k === 'Clear' ? 'Clear' : k === 'Done' ? 'Done' : (vkShift ? k.toUpperCase() : k);
        const cls = (k === 'Space' || k === 'Back' || k === 'Clear' || k === 'Done') ? 'vk-special' : '';
        return `<button class="vk-key ${cls}" data-vk-key="${esc(k)}" data-row="${ri}" data-col="${ci}">${esc(label)}</button>`;
      }).join('')}
    </div>`).join('');
  vkHighlight();
}

function vkHighlight() {
  if (!vkEl) return;
  vkEl.querySelectorAll('.vk-key').forEach((b) => b.classList.remove('vk-focus'));
  const row = VK_LAYOUT[vkRow];
  if (!row) return;
  const ci = Math.min(vkCol, row.length - 1);
  const btn = vkEl.querySelector(`.vk-key[data-row="${vkRow}"][data-col="${ci}"]`);
  if (btn) btn.classList.add('vk-focus');
}

function vkUpdatePreview() {
  const pv = document.getElementById('vkbd-preview');
  if (pv && vkTarget) pv.textContent = vkTarget.value;
}

function vkInsert(ch) {
  if (!vkTarget) return;
  const start = vkTarget.selectionStart || vkTarget.value.length;
  const end = vkTarget.selectionEnd || vkTarget.value.length;
  const val = vkTarget.value;
  vkTarget.value = val.slice(0, start) + ch + val.slice(end);
  const pos = start + ch.length;
  try { vkTarget.setSelectionRange(pos, pos); } catch { /* range inputs */ }
  vkTarget.dispatchEvent(new Event('input', { bubbles: true }));
  vkUpdatePreview();
}

function vkBackspace() {
  if (!vkTarget) return;
  const start = vkTarget.selectionStart || vkTarget.value.length;
  const end = vkTarget.selectionEnd || vkTarget.value.length;
  const val = vkTarget.value;
  if (start !== end) {
    vkTarget.value = val.slice(0, start) + val.slice(end);
    try { vkTarget.setSelectionRange(start, start); } catch {}
  } else if (start > 0) {
    vkTarget.value = val.slice(0, start - 1) + val.slice(start);
    try { vkTarget.setSelectionRange(start - 1, start - 1); } catch {}
  }
  vkTarget.dispatchEvent(new Event('input', { bubbles: true }));
  vkUpdatePreview();
}

function vkClear() {
  if (!vkTarget) return;
  vkTarget.value = '';
  try { vkTarget.setSelectionRange(0, 0); } catch {}
  vkTarget.dispatchEvent(new Event('input', { bubbles: true }));
  vkUpdatePreview();
}

function vkPress(key) {
  if (key === 'Space') vkInsert(' ');
  else if (key === 'Back') vkBackspace();
  else if (key === 'Clear') vkClear();
  else if (key === 'Done') vkClose();
  else vkInsert(vkShift ? key.toUpperCase() : key);
}

function vkOpenFor(target, force) {
  if (!target) return;
  // A pad is the normal reason to show a keyboard on a game launcher, but the
  // title-bar button can also ask for one directly, so a caller may force it.
  if (!force && (!GP || !GP.first || !GP.first())) return;
  vkEnsure();
  vkTarget = target;
  vkOpen = true;
  vkRow = 0;
  vkCol = 0;
  vkShift = false;
  vkRenderKeys();
  vkEl.classList.remove('hidden');
  vkUpdatePreview();
  // Keep focus on the input so the value updates land; the keyboard is
  // navigated by the controller's global handler (see below).
}

function vkClose() {
  if (!vkEl) return;
  vkEl.classList.add('hidden');
  vkOpen = false;
  if (vkTarget) {
    try { vkTarget.focus(); } catch { /* noop */ }
  }
  vkTarget = null;
}

function vkNavigate(dir) {
  if (!vkOpen) return false;
  const rows = VK_LAYOUT.length;
  if (dir === 'up') vkRow = (vkRow - 1 + rows) % rows;
  else if (dir === 'down') vkRow = (vkRow + 1) % rows;
  else if (dir === 'left') {
    const len = VK_LAYOUT[vkRow].length;
    vkCol = (vkCol - 1 + len) % len;
  } else if (dir === 'right') {
    const len = VK_LAYOUT[vkRow].length;
    vkCol = (vkCol + 1) % len;
  } else return false;
  vkHighlight();
  return true;
}

function vkSelect() {
  if (!vkOpen) return false;
  const row = VK_LAYOUT[vkRow];
  if (!row) return false;
  const ci = Math.min(vkCol, row.length - 1);
  vkPress(row[ci]);
  return true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t || !t.matches) return;
  if (!(t.matches('input[type="search"], input[type="text"], textarea') )) return;
  // Only pop up for controller users.
  if (!GP || !GP.first || !GP.first()) return;
  // Don't reopen if already open for this target.
  if (vkOpen && vkTarget === t) return;
  vkOpenFor(t);
});

// Close on Escape / B.
document.addEventListener('keydown', (e) => {
  if (!vkOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); vkClose(); }
});

// Controller-driven navigation while the keyboard is open. We hook into the
// global pad poll by listening for the same events the focus engine uses; the
// simplest robust approach is to intercept d-pad presses via a capture-phase
// keydown that the controller layer dispatches as synthetic KeyboardEvents.
document.addEventListener('keydown', (e) => {
  if (!vkOpen) return;
  // The controller layer translates pad presses into these keys when a pad is
  // active. We only act on them while the keyboard is open.
  let handled = false;
  if (e.key === 'ArrowUp') { handled = vkNavigate('up'); }
  else if (e.key === 'ArrowDown') { handled = vkNavigate('down'); }
  else if (e.key === 'ArrowLeft') { handled = vkNavigate('left'); }
  else if (e.key === 'ArrowRight') { handled = vkNavigate('right'); }
  else if (e.key === 'Enter') { handled = vkSelect(); }
  else if (e.key === 'Backspace') { vkBackspace(); handled = true; }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);

// Expose to other modules (controller.js) since top-level `let` is script-scoped.
window.vkIsOpen = () => vkOpen;
window.vkOpenFor = vkOpenFor;
window.vkClose = vkClose;
window.vkNavigate = vkNavigate;
window.vkSelect = vkSelect;
window.vkShiftToggle = () => { vkShift = !vkShift; vkRenderKeys(); };

// Click handling inside the keyboard.
document.addEventListener('click', (e) => {
  if (!vkOpen) return;
  const t = e.target;
  if (!t || !t.closest) return;
  const close = t.closest('[data-vk="close"]');
  if (close) { vkClose(); return; }
  const key = t.closest('[data-vk-key]');
  if (key) { vkPress(key.dataset.vkKey); return; }
  // Clicking outside the panel closes it.
  if (t === vkEl) vkClose();
});

// Close when the target input loses focus (with a small grace period so
// clicking a key doesn't immediately close it).
let vkBlurTimer = null;
document.addEventListener('focusout', (e) => {
  if (!vkOpen || !vkTarget) return;
  if (e.target === vkTarget) {
    clearTimeout(vkBlurTimer);
    vkBlurTimer = setTimeout(() => {
      if (vkOpen && document.activeElement !== vkTarget && !(vkEl && vkEl.contains(document.activeElement))) {
        vkClose();
      }
    }, 250);
  }
});