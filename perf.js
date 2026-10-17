'use strict';

/**
 * Performance overlay (main process).
 * -------------------------------------------------------------------------
 * A small always-on-top, click-through panel that sits over a running game and
 * reports what the machine is actually doing.
 *
 * Honesty first: a *true* in-game frame rate needs a graphics hook - it is how
 * Steam, RTSS and the Xbox Game Bar all do it, by injecting into the game's
 * present call. A separate Electron window cannot read another process's present
 * rate, so this overlay does not pretend to. Every number it shows is measured:
 *
 *   - CPU %  from `os.cpus()` tick deltas (the same source as Task Manager).
 *   - RAM    from `os.totalmem()` / `os.freemem()`.
 *   - GPU %  and per-process CPU/memory from Windows PDH counters, streamed by a
 *     single long-lived `typeperf` process - the same mechanism Task Manager
 *     uses, and far cheaper than polling WMI once a second.
 *   - Frame time / present rate, measured in the overlay's own renderer with
 *     requestAnimationFrame and labelled as exactly that.
 *
 * The sampler only runs while the overlay is on screen, so an overlay the user
 * never opens costs nothing at all.
 */

const { BrowserWindow, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const procs = require('./procs');

// ---------------------------------------------------------------------------
// Counter sets
// ---------------------------------------------------------------------------
/**
 * PDH counter sets, tried in order. The first is the full picture; each
 * fallback drops something rather than giving up entirely, because a locked-down
 * or non-English Windows can refuse individual counters while the rest work.
 */
const COUNTER_SETS = [
  [
    '\\GPU Engine(*engtype_3D)\\Utilization Percentage',
    '\\Process(*)\\ID Process',
    '\\Process(*)\\% Processor Time',
    '\\Process(*)\\Working Set'
  ],
  [
    '\\GPU Engine(*engtype_3D)\\Utilization Percentage',
    '\\Process(*)\\% Processor Time'
  ],
  ['\\GPU Engine(*engtype_3D)\\Utilization Percentage'],
  []
];

const GPU_RE = /GPU Engine\(([^)]*)\)\\Utilization Percentage$/i;
const PROC_RE = /Process\(([^)]*)\)\\(ID Process|% Processor Time|Working Set)$/i;

/** Streams PDH samples as CSV, one line per second, with no shell involved. */
let sampler = null;
let samplerSet = -1;
let samplerColumns = [];
let samplerDead = false;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let win = null;
let enabled = true;
let opts = { corner: 'top-left', opacity: 0.92, showPresent: true };

let prevCpu = null;
let latest = null;

function configure(next = {}) {
  const before = { ...opts };
  opts = { ...opts, ...(next || {}) };
  if (win && !win.isDestroyed()) {
    if (before.opacity !== opts.opacity) win.setOpacity(clamp01(Number(opts.opacity) || 0.92));
    if (before.corner !== opts.corner) place();
  }
}

const clamp01 = (n) => Math.max(0.25, Math.min(1, n));

// ---------------------------------------------------------------------------
// PDH sampler
// ---------------------------------------------------------------------------
/** One CSV line -> fields, honouring the quoting typeperf uses. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Turns the header row into a per-column description we can look up cheaply. */
function parseHeader(fields) {
  const cols = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) { cols.push(null); continue; }
    const g = f.match(GPU_RE);
    if (g) { cols.push({ kind: 'gpu', instance: g[1] }); continue; }
    const p = f.match(PROC_RE);
    if (p) { cols.push({ kind: 'proc', instance: p[1], counter: p[2].toLowerCase() }); continue; }
    cols.push(null);
  }
  return cols;
}

/** PDH pads duplicate instance names with `#2`, `#3`; the base name is the process. */
const baseName = (instance) => String(instance || '').replace(/#\d+$/, '');
const gpuPid = (instance) => {
  const m = String(instance || '').match(/^pid_(\d+)_/);
  return m ? Number(m[1]) : null;
};

function startSampler() {
  if (process.platform !== 'win32' || sampler || samplerDead) return;
  trySet(0);
}

function trySet(index) {
  if (index >= COUNTER_SETS.length || !COUNTER_SETS[index].length) {
    // Nothing PDH wants to give us: the overlay still reports CPU and RAM.
    samplerDead = true;
    samplerSet = -1;
    return;
  }

  const counters = COUNTER_SETS[index];
  const args = ['-si', '1', '-y', ...counters.map((c) => c)];
  let child;
  try {
    child = spawn('typeperf', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    trySet(index + 1);
    return;
  }

  sampler = child;
  samplerSet = index;
  samplerColumns = [];
  let buf = '';
  let sawData = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const fields = splitCsv(line);
      // The header is one long row of counter paths; the first field is the
      // "PDH-CSV 4.0" marker rather than a timestamp.
      if (fields.length > 1 && /^\(PDH-CSV/i.test(fields[0])) { samplerColumns = parseHeader(fields); continue; }
      if (fields.length < 2) continue;
      sawData = true;
      readSample(fields);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* typeperf is chatty about refused counters; the exit path handles it */ });

  child.once('exit', () => {
    const wasSampler = sampler === child;
    if (wasSampler) sampler = null;
    if (sawData) {
      // It had been working; restart it quietly the next time a sample is asked
      // for, unless we are shutting down.
      samplerDead = false;
      return;
    }
    if (wasSampler) trySet(index + 1);
  });
  child.once('error', () => { if (sampler === child) sampler = null; trySet(index + 1); });
}

function stopSampler() {
  if (!sampler) return;
  const child = sampler;
  sampler = null;
  try { child.stdout.removeAllListeners('data'); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}

/** Folds one PDH row into the per-process table. */
function readSample(fields) {
  const gpuByPid = new Map();
  const byPid = new Map();
  let gpuTotal = 0;
  let sawGpu = false;

  for (let i = 1; i < fields.length && i < samplerColumns.length; i++) {
    const col = samplerColumns[i];
    if (!col) continue;
    const raw = fields[i];
    if (!raw || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;

    if (col.kind === 'gpu') {
      sawGpu = true;
      if (value <= 0) continue;
      gpuTotal += value;
      const pid = gpuPid(col.instance);
      if (pid) gpuByPid.set(pid, (gpuByPid.get(pid) || 0) + value);
      continue;
    }

    const name = baseName(col.instance);
    if (/^(_total|idle)$/i.test(name)) continue;

    if (col.counter === 'id process') {
      // Keep the raw instance: duplicates carry a `#2` suffix of their own, and
      // the CPU / memory rows use that same suffix, so it is the only safe key.
      if (value > 0) {
        byPid.set(value, { pid: value, name, instance: col.instance, cpu: 0, mem: 0, gpu: 0 });
      }
      continue;
    }

    // `% Processor Time` and `Working Set` are keyed by instance name only, so
    // they are matched back to the ID Process row of the same instance.
    let entry = null;
    for (const e of byPid.values()) if (e.instance === col.instance) { entry = e; break; }
    if (!entry) continue;
    if (col.counter === '% processor time') entry.cpu = Math.round(value * 10) / 10;
    else if (col.counter === 'working set') entry.mem = value;
  }

  for (const [pid, g] of gpuByPid) {
    const entry = byPid.get(pid);
    if (entry) entry.gpu = Math.round(g * 10) / 10;
    else byPid.set(pid, { pid, name: `pid ${pid}`, instance: null, cpu: 0, mem: 0, gpu: Math.round(g * 10) / 10 });
  }

  latest = {
    pdh: {
      gpu: sawGpu ? Math.round(gpuTotal * 10) / 10 : null,
      procs: [...byPid.values()].filter((p) => p.pid)
    },
    at: Date.now()
  };
}

// ---------------------------------------------------------------------------
// System CPU / memory (Node's own, always available)
// ---------------------------------------------------------------------------
function systemCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const key of Object.keys(c.times)) total += c.times[key];
    idle += c.times.idle;
  }
  let pct = null;
  if (prevCpu) {
    const dt = total - prevCpu.total;
    const di = idle - prevCpu.idle;
    if (dt > 0) pct = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 1000) / 10));
  }
  prevCpu = { total, idle };
  return pct;
}

// ---------------------------------------------------------------------------
// Public sampling API
// ---------------------------------------------------------------------------
/**
 * One reading of everything, as JSON-safe values.
 *
 * Nothing here throws: a metric that cannot be read comes back `null` and the
 * UI shows a dash, which is the honest thing to do.
 */
function sample() {
  const total = os.totalmem();
  const free = os.freemem();
  const cpu = systemCpu();

  const pdh = latest && Date.now() - latest.at < 6000 ? latest.pdh : null;
  const running = procs.list();

  // The game Apex started is matched by pid, never by name: PDH truncates
  // process instance names to 15 characters, and a pid cannot be ambiguous.
  let game = null;
  if (running.length) {
    const rec = running[0];
    const row = pdh && rec.pid ? pdh.procs.find((p) => p.pid === rec.pid) : null;
    game = {
      id: rec.id,
      title: rec.name,
      pid: rec.pid,
      cpu: row ? row.cpu : null,
      mem: row ? row.mem : null,
      gpu: row ? row.gpu : null,
      uptime: Math.max(0, Date.now() - (rec.startedAt || Date.now()))
    };
  }

  // When nothing tracked is running, the busiest GPU process is the most useful
  // thing to name - it is almost always the game on screen.
  let busiest = null;
  if (pdh && pdh.procs.length) {
    busiest = pdh.procs.reduce((best, p) => ((p.gpu || 0) > (best.gpu || 0) ? p : best), pdh.procs[0]);
    if (busiest && !(busiest.gpu > 0.5)) {
      const topCpu = pdh.procs.reduce((best, p) => ((p.cpu || 0) > (best.cpu || 0) ? p : best), pdh.procs[0]);
      if (!game && topCpu && topCpu.cpu > 5) busiest = topCpu;
      else if (game) busiest = null;
    }
    if (game && busiest && busiest.pid === game.pid) busiest = null;
  }

  return {
    ok: true,
    at: Date.now(),
    cpu,
    mem: { used: total - free, total },
    gpu: pdh ? pdh.gpu : null,
    game,
    busiest: busiest ? { pid: busiest.pid, name: busiest.name, cpu: busiest.cpu, mem: busiest.mem, gpu: busiest.gpu } : null,
    games: running.length,
    platform: process.platform,
    counters: samplerSet >= 0 ? samplerSet : (samplerDead ? -1 : null)
  };
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------
function place() {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const [w, h] = win.getSize();
  const pad = 18;
  const corner = opts.corner || 'top-left';
  const x = corner.includes('right') ? area.x + area.width - w - pad : area.x + pad;
  const y = corner.includes('bottom') ? area.y + area.height - h - pad : area.y + pad;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

function create() {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: 330,
    height: 232,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A game must never lose a click to the overlay, and it must never take
    // keyboard focus away from a game either.
    focusable: false,
    show: false,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  // `screen-saver` is the highest level Electron exposes: it stays above a
  // borderless-fullscreen game, which is how most games run these days.
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* older Electron */ }
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
  // Click-through: every click in the overlay's rectangle lands on the game.
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* ignore */ }
  win.setOpacity(clamp01(Number(opts.opacity) || 0.92));

  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  return win;
}

/** Shows the overlay and starts the sampler. */
function show() {
  if (!enabled) return { ok: false, open: false, reason: 'disabled' };
  const w = create();
  place();
  startSampler();
  try { w.showInactive(); } catch { w.show(); }
  return { ok: true, open: true };
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
  stopSampler();
  latest = null;
  prevCpu = null;
  return { ok: true, open: false };
}

const isOpen = () => !!(win && !win.isDestroyed() && win.isVisible());

function toggle() {
  return isOpen() ? hide() : show();
}

function setEnabled(on) {
  enabled = on !== false;
  if (!enabled) hide();
  return { ok: true, enabled };
}

const status = () => ({
  enabled,
  open: isOpen(),
  corner: opts.corner || 'top-left',
  opacity: clamp01(Number(opts.opacity) || 0.92),
  showPresent: opts.showPresent !== false
});

function destroy() {
  stopSampler();
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('closed');
    win.destroy();
  }
  win = null;
}

module.exports = {
  configure,
  sample,
  show,
  hide,
  toggle,
  isOpen,
  status,
  setEnabled,
  destroy,
  // exported for the test suite
  splitCsv,
  parseHeader,
  baseName,
  gpuPid,
  COUNTER_SETS
};
