'use strict';

/**
 * Screenshots (main process).
 * -------------------------------------------------------------------------
 * F2 grabs what is on screen and drops it in a folder the user can trust: a
 * plain PNG named after the moment it was taken, plus a small JPEG the gallery
 * can load cheaply.
 *
 * The directory listing *is* the source of truth - the index is only there to
 * remember which game was on screen. Losing or corrupting the index therefore
 * costs a title, never a screenshot.
 */

const { app, desktopCapturer, screen, nativeImage, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const THUMB_WIDTH = 560;
let log = () => {};

function setLogger(fn) { log = typeof fn === 'function' ? fn : () => {}; }

const dir = () => path.join(app.getPath('userData'), 'screenshots');
const indexFile = () => path.join(dir(), 'index.json');

function ensureDir() {
  try { fs.mkdirSync(dir(), { recursive: true }); } catch { /* reported by the write below */ }
  return dir();
}

// ---------------------------------------------------------------------------
// Index (metadata only)
// ---------------------------------------------------------------------------
function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeIndex(idx) {
  try {
    ensureDir();
    fs.writeFileSync(indexFile(), JSON.stringify(idx, null, 2));
  } catch (err) {
    log(`Could not save the screenshot index: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Screenshots are addressed by file name only; never by a path we were handed. */
function safeName(name) {
  const base = path.basename(String(name || ''));
  return /^[^\\/:*?"<>|]+\.png$/i.test(base) ? base : null;
}

const shotPath = (name) => path.join(dir(), name);
const thumbPath = (name) => path.join(dir(), name.replace(/\.png$/i, '.thumb.jpg'));

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
/**
 * Grabs the primary display.
 *
 * `thumbnailSize` is in physical pixels, so the scale factor has to be folded in
 * or a 150%-scaled 4K desktop would come back soft.
 *
 * @param {{ game?: string, gameId?: string }} [opts]
 * @returns {Promise<{ok:boolean, name?:string, path?:string, thumb?:string, width?:number, height?:number, bytes?:number, at?:number, error?:string}>}
 */
async function capture(opts = {}) {
  try {
    ensureDir();
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const target = {
      width: Math.max(1, Math.round(display.size.width * scale)),
      height: Math.max(1, Math.round(display.size.height * scale))
    };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: target,
      fetchWindowIcons: false
    });
    if (!sources || !sources.length) return { ok: false, error: 'No screen to capture' };

    // Prefer the source that says it belongs to this display; on a single-monitor
    // setup the first source is always it.
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    const image = source.thumbnail;
    if (!image || image.isEmpty()) return { ok: false, error: 'The screen capture came back empty' };

    const size = image.getSize();
    let name = `Apex ${stamp()}.png`;
    // Two presses inside the same second must not overwrite each other.
    let n = 2;
    while (fs.existsSync(shotPath(name))) name = `Apex ${stamp()} (${n++}).png`;

    const png = image.toPNG();
    await fsp.writeFile(shotPath(name), png);

    let thumb = null;
    try {
      const small = size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH }) : image;
      await fsp.writeFile(thumbPath(name), small.toJPEG(80));
      thumb = path.basename(thumbPath(name));
    } catch (err) {
      // A missing thumbnail only costs the gallery a slower first paint.
      log(`Could not write the screenshot thumbnail: ${err.message}`);
    }

    const at = Date.now();
    const idx = readIndex();
    idx[name] = { at, game: opts.game || null, gameId: opts.gameId || null, width: size.width, height: size.height };
    writeIndex(idx);

    return {
      ok: true,
      name,
      path: shotPath(name),
      thumb,
      folder: dir(),
      width: size.width,
      height: size.height,
      bytes: png.length,
      at
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not take the screenshot' };
  }
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------
/**
 * Every screenshot on disk, newest first.
 *
 * The directory is authoritative: an entry whose file has gone is dropped, and
 * a PNG somebody dropped in by hand still shows up (just without metadata).
 */
async function list() {
  try {
    ensureDir();
    const names = (await fsp.readdir(dir())).filter((n) => /\.png$/i.test(n));
    const idx = readIndex();
    const out = [];

    for (const name of names) {
      let stat;
      try { stat = await fsp.stat(shotPath(name)); } catch { continue; }
      const meta = idx[name] || {};
      const thumb = thumbPath(name);
      out.push({
        name,
        path: shotPath(name),
        thumb: fs.existsSync(thumb) ? thumb : shotPath(name),
        hasThumb: fs.existsSync(thumb),
        bytes: stat.size,
        at: meta.at || stat.mtimeMs,
        game: meta.game || null,
        gameId: meta.gameId || null,
        width: meta.width || null,
        height: meta.height || null
      });
    }

    out.sort((a, b) => b.at - a.at);

    // Tidy the index of entries whose file has vanished so it cannot grow forever.
    let dirty = false;
    for (const key of Object.keys(idx)) {
      if (!fs.existsSync(shotPath(key))) { delete idx[key]; dirty = true; }
    }
    if (dirty) writeIndex(idx);

    return { ok: true, folder: dir(), shots: out, bytes: out.reduce((sum, s) => sum + s.bytes, 0) };
  } catch (err) {
    return { ok: false, folder: dir(), shots: [], bytes: 0, error: (err && err.message) || 'Could not read the screenshots folder' };
  }
}

/** Deletes one screenshot and its thumbnail. Names come from `list()`. */
async function remove(name) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'Unknown screenshot' };

  const removed = [];
  for (const target of [shotPath(safe), thumbPath(safe)]) {
    // Belt and braces: the resolved path must still be inside the folder.
    if (path.dirname(path.resolve(target)) !== path.resolve(dir())) continue;
    try {
      await fsp.rm(target, { force: true });
      removed.push(path.basename(target));
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'Could not delete that screenshot' };
    }
  }

  const idx = readIndex();
  if (idx[safe]) { delete idx[safe]; writeIndex(idx); }
  return { ok: true, removed };
}

async function open() {
  try {
    ensureDir();
    await shell.openPath(dir());
    return { ok: true, folder: dir() };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not open the screenshots folder' };
  }
}

module.exports = { setLogger, capture, list, remove, open, dir, stamp, safeName, THUMB_WIDTH };
