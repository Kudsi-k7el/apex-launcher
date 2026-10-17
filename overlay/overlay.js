'use strict';

/**
 * Performance overlay renderer.
 *
 * Two loops run here, deliberately kept apart:
 *
 *   - A 1 Hz poll of the main process for measured system numbers (CPU, GPU,
 *     RAM, and the stats of whatever game is running).
 *   - A requestAnimationFrame loop that times its own frames. That number is
 *     labelled "present" because it is exactly what it measures: how often the
 *     desktop compositor presented a frame to this window. It is *not* the
 *     game's frame rate, and the panel never says it is.
 */

const $ = (sel) => document.querySelector(sel);

const HIST = 90;
const cpuHist = [];
const gpuHist = [];
const memHist = [];
const frameHist = [];

let frameSamples = 0;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(0)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}

function fmtUptime(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${sec}s`;
}

const pct = (n) => (n == null ? '\u2014' : `${n >= 100 ? 100 : n.toFixed(n < 10 ? 1 : 0)}%`);

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------
function setMeter(kind, value, text) {
  const row = document.querySelector(`.ov-meter[data-meter="${kind}"]`);
  if (!row) return;
  row.hidden = false;
  const fill = row.querySelector('.ov-fill');
  const label = row.querySelector(`.ov-value[data-val="${kind}"]`);
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  fill.style.width = `${v}%`;
  row.classList.toggle('hot', v >= 70 && v < 90);
  row.classList.toggle('critical', v >= 90);
  label.textContent = text;
}

// ---------------------------------------------------------------------------
// Sparkline: CPU, GPU and memory in one 90-second window
// ---------------------------------------------------------------------------
function drawSpark() {
  const cv = $('#spark');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = Math.round((h / 3) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const line = (hist, colour) => {
    if (hist.length < 2) return;
    ctx.beginPath();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = colour;
    hist.forEach((v, i) => {
      const x = (i / (HIST - 1)) * w;
      const y = h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  line(memHist, 'rgba(46, 204, 113, .55)');
  line(gpuHist, 'rgba(125, 92, 255, .75)');
  line(cpuHist, 'rgba(0, 168, 255, .95)');
}

function push(hist, value) {
  hist.push(value == null ? 0 : Math.max(0, Math.min(100, value)));
  while (hist.length > HIST) hist.shift();
}

// ---------------------------------------------------------------------------
// Frame timing
// ---------------------------------------------------------------------------
let lastFrame = 0;
let emaMs = 0;

function frameLoop(now) {
  if (lastFrame) {
    const dt = now - lastFrame;
    // A long gap means the window was hidden or the machine stalled, not a
    // dropped frame - do not let it poison the average.
    if (dt > 0 && dt < 200) {
      emaMs = emaMs ? emaMs * 0.88 + dt * 0.12 : dt;
      if (++frameSamples >= 12) {
        frameSamples = 0;
        frameHist.push(emaMs);
        while (frameHist.length > HIST) frameHist.shift();
      }
    }
  }
  lastFrame = now;

  const fps = emaMs > 0 ? 1000 / emaMs : 0;
  $('#present-fps').textContent = fps ? fps.toFixed(fps >= 100 ? 0 : 1) : '\u2014';
  $('#present-ms').textContent = emaMs ? `${emaMs.toFixed(2)} ms` : '\u2014';

  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

// ---------------------------------------------------------------------------
// Sample poll
// ---------------------------------------------------------------------------
function apply(s) {
  if (!s || s.ok === false) return;

  setMeter('cpu', s.cpu, pct(s.cpu));
  setMeter('gpu', s.gpu, s.gpu == null ? 'n/a' : pct(s.gpu));

  const memPct = s.mem && s.mem.total ? ((s.mem.used / s.mem.total) * 100) : null;
  setMeter('mem', memPct, s.mem ? fmtBytes(s.mem.used) : '\u2014');

  if (s.gpu == null) {
    // The GPU tile keeps its row but says so out loud rather than showing a
    // zero, which would read as "the GPU is idle".
    document.querySelector('.ov-meter[data-meter="gpu"] .ov-value').title =
      'Windows performance counters for the GPU are unavailable on this machine';
  }

  push(cpuHist, s.cpu);
  push(gpuHist, s.gpu);
  push(memHist, memPct);
  drawSpark();

  const gameEl = $('#game');
  const subject = s.game || s.busiest;
  if (subject) {
    gameEl.hidden = false;
    $('#game-title').textContent = subject.title || subject.name || 'Running game';
    $('#game-cpu').textContent = subject.cpu == null ? '\u2014' : pct(subject.cpu);
    $('#game-gpu').textContent = subject.gpu == null ? '\u2014' : pct(subject.gpu);
    $('#game-mem').textContent = subject.mem == null ? '\u2014' : fmtBytes(subject.mem);
    $('#game-up').textContent = subject.uptime == null ? '\u2014' : fmtUptime(subject.uptime);
  } else {
    gameEl.hidden = true;
  }

  const src = $('#src');
  if (s.gpu == null) src.textContent = 'cpu/ram only';
  else if (s.game) src.textContent = 'measured';
  else src.textContent = 'system';
}

async function poll() {
  try {
    apply(await window.perf.sample());
  } catch {
    /* the main process is going away; the window will close with it */
  }
}

poll();
setInterval(poll, 1000);

window.addEventListener('resize', drawSpark);
window.perf.onHide(() => { /* main hides the window; nothing to do here */ });
