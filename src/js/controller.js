'use strict';

/**
 * Controller support.
 * ------------------------------------------------------------------
 * Two jobs, kept apart:
 *
 * 1. Detection. Notice a pad being plugged in, switched on or paired, name it
 *    properly and tell the user. Chromium only raises `gamepadconnected` once a
 *    pad has actually been *touched* (a button press or a decent stick move) —
 *    a deliberate browser restriction a page cannot opt out of. So Apex listens
 *    for the events *and* polls the pad list. The visible result is the same:
 *    the "Controller Connected" card appears the moment the user picks the pad
 *    up, which is exactly when it is useful, and a pad that vanishes is noticed
 *    even if `gamepaddisconnected` never fires.
 *
 * 2. Navigation. Turn d-pad and stick input into a focus ring that can walk any
 *    screen. Movement is geometric — the nearest element in the requested
 *    direction — so it works on the store grid, the library, the sidebar, the
 *    Big Picture shelves and inside dialogs with no per-view configuration.
 *
 * Nothing here is required for the app to work: with no pad attached the module
 * polls at a low rate and costs nothing.
 */

// Standard-mapping button indices (the layout Chromium normalises to).
const PAD_BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15
};

/** Index -> printed label, for the Settings live read-out and debug cards. */
const PAD_BTN_NAME = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'View', 'Menu', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right'
];

/**
 * Per-family button names. These are the labels printed on the hardware, which
 * is what makes the on-screen hints readable: a PlayStation owner should be
 * told to press "Cross", not "A".
 */
const PAD_FAMILY = {
  xbox: {
    label: 'Xbox layout',
    glyph: 'xbox',
    a: 'A', b: 'B', x: 'X', y: 'Y', menu: 'Menu', view: 'View'
  },
  playstation: {
    label: 'PlayStation layout',
    glyph: 'ps5',
    a: '\u2715', b: '\u25CB', x: '\u25A1', y: '\u25B3', menu: 'Options', view: 'Create'
  },
  switch: {
    label: 'Nintendo layout',
    glyph: 'gamepad',
    a: 'B', b: 'A', x: 'Y', y: 'X', menu: '+', view: '\u2212'
  },
  generic: {
    label: 'DirectInput layout',
    glyph: 'gamepad',
    a: '1', b: '2', x: '3', y: '4', menu: 'Start', view: 'Select'
  }
};

const GP = {
  pads: new Map(),          // index -> { pad, name, family, label, glyph, mapping }
  dir: { dir: null, since: 0, next: 0 },
  down: {},                 // edge detection per button index
  HOLD: 340,                // ms before a held direction starts repeating
  REPEAT: 125,              // ms between repeats
  DEADZONE: 0.5,
  hasPad: () => GP.pads.size > 0,
  /** The first pad we know about — Apex drives one focus ring, not one per pad. */
  first: () => {
    for (const rec of GP.pads.values()) if (rec.pad) return rec;
    return null;
  },
  enabled: () => State.settings.controller !== false
};

// ---------------------------------------------------------------------------
// Device naming
// ---------------------------------------------------------------------------
/**
 * Chromium reports ids like
 *   "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)"
 * so the vendor blob is stripped for display, and the couple of names Chromium
 * gets generically are turned back into something a person recognises.
 */
function padCleanName(raw) {
  let s = String(raw || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!s) s = 'Controller';
  if (/^wireless controller$/i.test(s)) s = 'PlayStation controller';
  else if (/^gamepad$/i.test(s)) s = 'Generic gamepad';
  return s;
}

/** Family, display name and button labels for one reported gamepad id. */
function padInfo(pad) {
  const raw = String((pad && pad.id) || '');
  let family = 'generic';
  if (/xbox|xinput|045e|microsoft/i.test(raw)) family = 'xbox';
  else if (/dualsense|dual-?sense|playstation|sony|054c|wireless controller|ps5|ps4/i.test(raw)) family = 'playstation';
  else if (/switch|joy-?con|pro controller|057e|nintendo/i.test(raw)) family = 'switch';

  const f = PAD_FAMILY[family];
  return {
    id: raw,
    name: padCleanName(raw),
    family,
    label: f.label,
    glyph: f.glyph,
    // The button names travel with the record so every hint ("press A to
    // select", the footer legend) can name the hardware the user is holding.
    a: f.a, b: f.b, x: f.x, y: f.y, menu: f.menu, view: f.view,
    mapping: (pad && pad.mapping) || 'direct'
  };
}

// ---------------------------------------------------------------------------
// The connection card
// ---------------------------------------------------------------------------
/**
 * A richer notification than the standard toast: the pad's name, its button
 * layout and — on connect — what to press first. It is the same card for connect
 * and disconnect, dimmed for the latter.
 */
function showPadCard(info, on) {
  const el = document.getElementById('pad-toast');
  if (!el) return;
  el.innerHTML = `
    <span class="pt-ico">${icon('gamepad', 22)}</span>
    <span class="pt-body">
      <small>${on ? 'Controller connected' : 'Controller disconnected'}</small>
      <strong>${esc(info.name)}</strong>
      <em>${on
        ? `${esc(info.label)}${info.mapping === 'standard' ? ' \u00b7 standard mapping' : ''} \u00b7 press ${esc(info.a || 'A')} to select`
        : 'Navigation returns to the keyboard and mouse'}</em>
    </span>
    <span class="pt-mark">${icon(info.glyph, 20)}</span>`;
  el.dataset.on = on ? '1' : '0';
  el.classList.add('show');
  clearTimeout(showPadCard.t);
  showPadCard.t = setTimeout(() => el.classList.remove('show'), on ? 4800 : 2600);
}

/** Refreshes the small "pad connected" indicators and the footer hints. */
function refreshPadHints() {
  document.body.classList.toggle('has-pad', GP.hasPad());
  const dot = document.getElementById('pad-status');
  if (dot) {
    const rec = GP.first();
    dot.classList.toggle('on', !!rec);
    dot.innerHTML = rec ? icon(rec.glyph, 16) : icon('gamepad', 16);
    dot.title = rec ? `${rec.name} (${rec.label})` : 'No controller detected';
  }
  if (typeof BP !== 'undefined' && BP.isOpen && BP.isOpen()) BP.refreshHints();
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------
function gpConnected(pad) {
  if (!pad || !pad.id || GP.pads.has(pad.index)) return;
  const info = padInfo(pad);
  GP.pads.set(pad.index, { pad, ...info });
  SFX.play('padOn');
  showPadCard(GP.pads.get(pad.index), true);
  refreshPadHints();
}

function gpDisconnected(index) {
  const rec = GP.pads.get(index);
  if (!rec) return;
  GP.pads.delete(index);
  SFX.play('padOff');
  showPadCard(rec, false);
  refreshPadHints();
}

// The standard events fire first when they fire at all; the poll below catches
// everything else (including pads that were already on when Apex started).
window.addEventListener('gamepadconnected', (e) => { gpConnected(e.gamepad); });
window.addEventListener('gamepaddisconnected', (e) => { gpDisconnected(e.gamepad.index); });

// ---------------------------------------------------------------------------
// Focus navigation
// ---------------------------------------------------------------------------
/**
 * The focus ring. `scope()` narrows navigation to whatever is "on top" right
 * now — an open dialog, the Big Picture overlay, or the whole window — so a
 * controller never walks into hidden chrome.
 */
const Focus = {
  el: null,
  lastAt: 0,

  scope() {
    const modal = document.querySelector('#modal-root .modal-backdrop.show .modal');
    if (modal) return modal;
    if (document.body.classList.contains('big-picture')) {
      const bp = document.getElementById('bigpic');
      if (!bp) return null;
      const overlay = bp.querySelector('.bp-power:not(.hidden)');
      return overlay || bp;
    }
    return null; // whole document
  },

  /** Everything the focus ring may land on, in DOM order. */
  candidates() {
    const scope = this.scope();
    const root = scope || document.body;
    const sel = 'button, a[href], [data-act], [data-card], [tabindex]:not([tabindex="-1"]), input:not([type="hidden"]), select, textarea';
    const out = [];
    const seen = new Set();
    for (const el of root.querySelectorAll(sel)) {
      if (seen.has(el) || el.disabled) continue;
      seen.add(el);
      // Never walk into an inactive layer when the scope is the whole window.
      if (!scope && (el.closest('#bigpic') || el.closest('#modal-root') || el.closest('#pad-toast'))) continue;
      if (this.hidden(el)) continue;
      out.push(el);
    }
    return out;
  },

  /** A cheap, dependency-free visibility test (display, size, opacity). */
  hidden(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return true;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return true;
    if (Number(cs.opacity) < 0.08) return true;
    // Inside a collapsed container (a closed drawer, a hidden overlay).
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.classList.contains('hidden') || p.getAttribute('aria-hidden') === 'true') return true;
      const pr = p.getBoundingClientRect();
      if (pr.height < 4 || pr.width < 4) return true;
    }
    return false;
  },

  set(el, opts = {}) {
    if (!el || el === this.el) return;
    if (this.el) this.el.classList.remove('gp-focus');
    this.el = el;
    el.classList.add('gp-focus');
    document.body.classList.add('gp-nav');
    // Instant, not smooth: the ring can move several times a second while a
    // stick is held, and animated scrolling turns that into a lag.
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
    // Big Picture wants the hero to follow whatever the ring is on.
    if (typeof BP !== 'undefined' && BP.followFocus) BP.followFocus(el);
    if (opts.sound !== false && opts.src === 'pad') SFX.play('move');
  },

  clear() {
    if (this.el) this.el.classList.remove('gp-focus');
    this.el = null;
  },

  /** The closest candidate in one direction, measured centre-to-centre. */
  nearest(dir) {
    const from = this.el ? this.el.getBoundingClientRect() : null;
    const list = this.candidates();
    if (!list.length) return null;
    if (!from || !list.includes(this.el)) return list[0];

    const ax = from.left + from.width / 2;
    const ay = from.top + from.height / 2;
    let best = null;
    let bestScore = Infinity;

    for (const el of list) {
      if (el === this.el) continue;
      const r = el.getBoundingClientRect();
      const bx = r.left + r.width / 2;
      const by = r.top + r.height / 2;
      const dx = bx - ax;
      const dy = by - ay;

      let primary;
      let secondary;
      if (dir === 'left') { if (dx > -2) continue; primary = -dx; secondary = Math.abs(dy); }
      else if (dir === 'right') { if (dx < 2) continue; primary = dx; secondary = Math.abs(dy); }
      else if (dir === 'up') { if (dy > -2) continue; primary = -dy; secondary = Math.abs(dx); }
      else { if (dy < 2) continue; primary = dy; secondary = Math.abs(dx); }

      // Weighting the perpendicular offset keeps a grid walking straight
      // instead of skipping diagonally into the next column.
      const score = primary + secondary * 2.4;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  },

  move(dir, src) {
    const target = this.nearest(dir);
    if (target) {
      this.set(target, { src });
      return true;
    }
    // Nothing that way. A hint of movement on the ring itself reads better than
    // silence — the user can tell the press registered.
    if (this.el && src === 'pad') {
      this.el.classList.remove('gp-bump');
      void this.el.offsetWidth;
      this.el.classList.add('gp-bump');
      setTimeout(() => this.el && this.el.classList.remove('gp-bump'), 180);
    }
    return false;
  },

  activate() {
    if (!this.el) { this.set(this.candidates()[0]); return false; }
    const el = this.el;
    const tag = el.tagName;
    // Text-ish controls own the keyboard: hand them focus rather than clicking.
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      el.focus();
      if (el.select) { try { el.select(); } catch { /* range inputs */ } }
      return true;
    }
    el.click();
    return true;
  },

  /** Jumps the ring to the first element of a freshly rendered view. */
  first(opts) {
    const list = this.candidates();
    if (list.length) this.set(list[0], opts);
  }
};

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------
/** True while a button is down (or a trigger is pulled past halfway). */
function padHeld(pad, index) {
  const b = pad.buttons && pad.buttons[index];
  return !!b && (b.pressed || b.value > 0.5);
}

/** D-pad first, then the left stick treated as a virtual d-pad. */
function padDirection(pad) {
  if (padHeld(pad, PAD_BTN.UP)) return 'up';
  if (padHeld(pad, PAD_BTN.DOWN)) return 'down';
  if (padHeld(pad, PAD_BTN.LEFT)) return 'left';
  if (padHeld(pad, PAD_BTN.RIGHT)) return 'right';

  const ax = (pad.axes && pad.axes[0]) || 0;
  const ay = (pad.axes && pad.axes[1]) || 0;
  const dz = GP.DEADZONE;
  if (Math.abs(ax) > Math.abs(ay)) {
    if (ax < -dz) return 'left';
    if (ax > dz) return 'right';
  } else {
    if (ay < -dz) return 'up';
    if (ay > dz) return 'down';
  }
  return null;
}

/**
 * One frame of controller input. Directional input repeats on a hold; every
 * action button is edge-triggered so holding A does not machine-gun clicks.
 */
function gpNavigate(pad) {
  if (!pad) return;
  const now = performance.now();

  if (window.vkIsOpen && window.vkIsOpen()) {
    const dir = padDirection(pad);
    if (dir && dir !== GP.dir.dir) {
      GP.dir = { dir, since: now, next: 0 };
      if (window.vkNavigate) window.vkNavigate(dir);
    } else if (dir && (GP.dir.next === 0 ? (now - GP.dir.since > GP.HOLD) : (now >= GP.dir.next))) {
      if (window.vkNavigate) window.vkNavigate(dir);
      GP.dir.next = now + GP.REPEAT;
    }
    return;
  }

  const dir = padDirection(pad);
  if (dir !== GP.dir.dir) {
    GP.dir = { dir, since: now, next: 0 };
    if (dir) Focus.move(dir, 'pad');
  } else if (dir) {
    if (GP.dir.next === 0) {
      if (now - GP.dir.since > GP.HOLD) { Focus.move(dir, 'pad'); GP.dir.next = now + GP.REPEAT; }
    } else if (now >= GP.dir.next) {
      Focus.move(dir, 'pad');
      GP.dir.next = now + GP.REPEAT;
    }
  }

  const press = (index, fn) => {
    const down = padHeld(pad, index);
    const key = `b${index}`;
    if (down && !GP.down[key]) { GP.down[key] = true; fn(); }
    else if (!down && GP.down[key]) GP.down[key] = false;
  };

  // A / Cross: select. Inside Big Picture a press on the highlighted tile does
  // what the hero's main button does; everywhere else it is a plain activation.
  press(PAD_BTN.A, () => {
    SFX.unlock();
    if (window.vkIsOpen && window.vkIsOpen()) { if (window.vkSelect) window.vkSelect(); SFX.play('select'); return; }
    if (typeof BP !== 'undefined' && BP.isOpen()
      && Focus.el && Focus.el.classList.contains('bp-tile')) {
      SFX.play('select');
      bpActivateIndex(Number(Focus.el.dataset.idx));
      return;
    }
    Focus.activate();
  });

  // B / Circle: back, one layer at a time.
  press(PAD_BTN.B, () => {
    SFX.unlock();
    if (window.vkIsOpen && window.vkIsOpen()) { if (window.vkClose) window.vkClose(); SFX.play('back'); return; }
    if (uiBack()) SFX.play('back'); else SFX.play('deny');
  });

  // Y / Triangle: switch into (or out of) the 10-foot interface.
  press(PAD_BTN.Y, () => {
    SFX.unlock();
    if (typeof BP !== 'undefined' && BP.isOpen()) BP.exit('pad');
    else if (typeof BP !== 'undefined') BP.enter('pad');
  });

  // X / Square: mute or unmute the UI sounds — the one control a controller
  // owner cannot reach any other way.
  press(PAD_BTN.X, () => {
    const muted = SFX.toggleMute();
    if (typeof BP !== 'undefined' && BP.isOpen()) BP.refreshStatus();
    toast(muted ? 'UI sounds muted' : 'UI sounds on', muted ? 'info' : 'check');
    if (!muted) SFX.play('toggle');
  });

  // Shoulders: previous / next tab.
  press(PAD_BTN.LB, () => {
    if (window.vkIsOpen && window.vkIsOpen()) { if (window.vkShiftToggle) window.vkShiftToggle(); SFX.play('move'); return; }
    SFX.play('tab'); uiCycleTab(-1);
  });
  press(PAD_BTN.RB, () => {
    if (window.vkIsOpen && window.vkIsOpen()) { if (window.vkShiftToggle) window.vkShiftToggle(); SFX.play('move'); return; }
    SFX.play('tab'); uiCycleTab(1);
  });

  // Start: the power / menu overlay in Big Picture, otherwise jump into it.
  press(PAD_BTN.MENU, () => {
    if (typeof BP !== 'undefined' && BP.isOpen()) BP.openOverlay('pad');
    else if (typeof BP !== 'undefined') BP.enter('pad');
  });

  // View / Back button: the download drawer, which is otherwise mouse-only.
  press(PAD_BTN.VIEW, () => {
    SFX.play('toggle');
    if (typeof toggleDrawer === 'function') toggleDrawer();
  });
}

let gpTimer = null;
const GP_ACTIVE_MS = 1000 / 34;   // a pad is attached: watch it closely
const GP_IDLE_MS = 1200;          // nothing attached: a slow check is plenty

/** (Re)schedules the next poll. Self-rescheduling avoids interval pile-up. */
function gpSchedule(ms) {
  clearTimeout(gpTimer);
  gpTimer = setTimeout(gpPoll, ms);
}

function gpPoll() {
  gpTimer = null;
  let connected = false;

  if (GP.enabled() && !document.hidden && typeof navigator.getGamepads === 'function') {
    const list = navigator.getGamepads() || [];
    const present = new Set();
    for (const pad of list) {
      if (!pad || !pad.id || pad.connected === false) continue;
      present.add(pad.index);
      if (!GP.pads.has(pad.index)) gpConnected(pad);
      else GP.pads.get(pad.index).pad = pad;
    }
    for (const index of [...GP.pads.keys()]) if (!present.has(index)) gpDisconnected(index);

    const rec = GP.first();
    if (rec) { gpNavigate(rec.pad); connected = true; }
  }

  // With a pad in hand we poll fast so a quick tap is never missed; with none we
  // back right off. The rate is chosen every frame, so a pad that appears is
  // picked up at full speed within one idle tick.
  gpSchedule(connected ? GP_ACTIVE_MS : GP_IDLE_MS);
}

/** Starts the poll loop. Also used to switch polling on after a settings change. */
function startControllers() {
  clearTimeout(gpTimer);
  gpTimer = null;
  gpPoll();
  refreshPadHints();
}

/** A live snapshot for the Settings read-out: what the pad is doing right now. */
function padSnapshot() {
  const rec = GP.first();
  if (!rec || !rec.pad) return null;
  const pad = rec.pad;
  const num = (v) => Number(v) || 0;
  const fmt = (v) => num(v).toFixed(2);
  const held = [];
  (pad.buttons || []).forEach((b, i) => {
    if (b && (b.pressed || b.value > 0.5)) held.push(PAD_BTN_NAME[i] || `#${i}`);
  });
  const ax = (i) => fmt((pad.axes && pad.axes[i]) || 0);
  const trg = (i) => {
    const b = pad.buttons && pad.buttons[i];
    return fmt(b ? (b.pressed ? 1 : b.value) : 0);
  };
  return {
    name: rec.name,
    label: rec.label,
    buttons: held,
    left: `${ax(0)}, ${ax(1)}`,
    right: `${ax(2)}, ${ax(3)}`,
    triggers: `${trg(PAD_BTN.LT)}, ${trg(PAD_BTN.RT)}`
  };
}

// A pad button is a real user gesture, so it can wake the audio context.
window.addEventListener('gamepadconnected', () => SFX.unlock());
