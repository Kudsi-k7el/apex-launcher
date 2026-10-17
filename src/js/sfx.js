'use strict';

/**
 * UI sound effects.
 * ------------------------------------------------------------------
 * Every sound Apex makes is synthesised here with the Web Audio API. No audio
 * file ships with the build: there is nothing to download, nothing to license,
 * and the strict CSP (`script-src 'self'`) stays untouched because no media is
 * ever fetched — the waveforms are generated in the renderer.
 *
 * The palette is deliberately small and quiet, and is tuned for the two jobs
 * the UI needs: telling the user that focus *moved* (a very short tick, so a
 * burst of navigation reads as a texture rather than a tune) and telling them
 * something *happened* (a short two-note figure for confirm, the same shape
 * falling for back, and swells for panels opening and closing).
 *
 * On/off and master volume both live in Settings and are persisted with the
 * rest of the app state.
 */
const SFX = (() => {
  let ctx = null;
  let master = null;
  let sessionMuted = false;   // the Big Picture mute button; not persisted

  const level = () => {
    const v = Number(State.settings.uiVolume);
    return Math.max(0, Math.min(1, (isFinite(v) ? v : 60) / 100));
  };

  /** True when a cue should be heard right now. */
  const wanted = () => State.settings.uiSounds !== false && !sessionMuted;

  /** Lazily builds the audio graph. Null where Web Audio is unavailable. */
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }

    master = ctx.createGain();
    master.gain.value = 1;

    // A compressor stops a fast run of blips from clipping or crackling.
    const comp = ctx.createDynamicsCompressor();
    try {
      comp.threshold.value = -20;
      comp.knee.value = 24;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
    } catch { /* defaults are fine */ }

    master.connect(comp);
    comp.connect(ctx.destination);
    return ctx;
  }

  /** One shaped tone burst: a short attack, then an exponential tail. */
  function tone(dest, o) {
    const dur = o.dur || 0.09;
    const at = ctx.currentTime + (o.at || 0);
    const peak = o.gain == null ? 0.24 : o.gain;

    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.f0), at);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), at + dur);

    const g = ctx.createGain();
    const atk = o.attack == null ? 0.004 : o.attack;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    osc.connect(g);
    g.connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  /**
   * The palette. Every cue is a list of tones, so the same code covers a single
   * tick and a three-note figure.
   */
  const RECIPES = {
    // Focus moving under controller or keyboard: barely there, meant to be
    // repeated quickly.
    move:   [{ f0: 1180, dur: 0.045, gain: 0.09, type: 'triangle' }],
    // Confirming something. A clean rising second.
    select: [{ f0: 700, dur: 0.07, gain: 0.19 }, { f0: 1050, dur: 0.11, gain: 0.21, at: 0.055 }],
    // Back / cancel: the same shape, falling.
    back:   [{ f0: 620, dur: 0.07, gain: 0.17 }, { f0: 400, dur: 0.12, gain: 0.15, at: 0.05 }],
    // A panel opening, and closing again.
    open:   [{ f0: 420, f1: 1250, dur: 0.16, gain: 0.15 }],
    close:  [{ f0: 1150, f1: 460, dur: 0.13, gain: 0.13 }],
    // Switching tabs or paging a shelf.
    tab:    [{ f0: 900, dur: 0.05, gain: 0.13 }, { f0: 1300, dur: 0.06, gain: 0.11, at: 0.035 }],
    // A switch flipping.
    toggle: [{ f0: 1600, dur: 0.035, gain: 0.11, type: 'square' }],
    // A hit of a wall: something was refused.
    deny:   [{ f0: 240, dur: 0.13, gain: 0.15, type: 'square' },
             { f0: 176, dur: 0.15, gain: 0.12, type: 'square', at: 0.06 }],
    // Entering the 10-foot interface: a soft three-note welcome.
    enter:  [{ f0: 523, dur: 0.16, gain: 0.15 },
             { f0: 659, dur: 0.16, gain: 0.14, at: 0.09 },
             { f0: 880, dur: 0.26, gain: 0.15, at: 0.18 }],
    // ... and the matching goodbye.
    exit:   [{ f0: 880, dur: 0.14, gain: 0.13 },
             { f0: 659, dur: 0.14, gain: 0.12, at: 0.08 },
             { f0: 494, dur: 0.22, gain: 0.12, at: 0.16 }],
    // A controller arriving and leaving.
    padOn:  [{ f0: 784, dur: 0.10, gain: 0.17 }, { f0: 1175, dur: 0.17, gain: 0.17, at: 0.07 }],
    padOff: [{ f0: 700, dur: 0.10, gain: 0.13 }, { f0: 494, dur: 0.16, gain: 0.12, at: 0.07 }]
  };

  /** Plays a named cue. Safe to call at any time, even before any gesture. */
  function play(name, opts = {}) {
    if (!wanted()) return false;
    const recipe = RECIPES[name];
    if (!recipe) return false;
    if (!ensure()) return false;

    // Chromium starts the context suspended until the page has been interacted
    // with; every cue that reaches here follows an interaction, so resuming is
    // safe and makes the very first tick audible.
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* ignore */ } }

    const g = ctx.createGain();
    g.gain.value = level() * (opts.gain == null ? 1 : opts.gain);
    g.connect(master);
    for (const step of recipe) tone(g, step);
    return true;
  }

  /** Wakes the audio context up on the first real user gesture. */
  function unlock() {
    if (!wanted()) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* ignore */ } }
  }

  return {
    play,
    unlock,
    isMuted: () => sessionMuted || State.settings.uiSounds === false,
    setMuted: (v) => { sessionMuted = !!v; },
    toggleMute: () => { sessionMuted = !sessionMuted; return sessionMuted; }
  };
})();

// ---------------------------------------------------------------------------
// Wiring: wake the audio context on the first real user gesture so the very
// first cue of a session is audible.
// ---------------------------------------------------------------------------
(() => {
  const wake = () => SFX.unlock();
  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('keydown', wake);
})();
