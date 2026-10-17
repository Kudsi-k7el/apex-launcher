'use strict';

/**
 * Safe archive extraction for the Apex installer.
 *
 * ZIP is handled natively (central-directory parser + zlib) so the common case
 * needs no external tooling and works inside a packaged asar. RAR, 7z and
 * tarballs are delegated to whatever the machine already has (7-Zip, WinRAR,
 * bsdtar) and fail with a clear, actionable message when none is present.
 *
 * Every entry path is resolved against the destination root and rejected if it
 * escapes it, so a malicious archive cannot write outside the install folder
 * (the classic "zip slip" attack). Symlink entries are never materialised.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const ZIP64_EXTRA = 0x0001;

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** @returns {'zip'|'rar'|'7z'|'gz'|'bz2'|'xz'|'tar'|null} */
function sniff(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(512);
    const read = fs.readSync(fd, head, 0, head.length, 0);

    if (read >= 6 && head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf && head[4] === 0x27 && head[5] === 0x1c) {
      return '7z';
    }
    if (read >= 4 && head.toString('latin1', 0, 4).startsWith('PK')) return 'zip';
    if (read >= 7 && head.toString('latin1', 0, 5) === 'Rar!\u001a') return 'rar';
    if (read >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gz';
    if (read >= 3 && head.toString('latin1', 0, 3) === 'BZh') return 'bz2';
    if (read >= 6 && head.toString('latin1', 0, 6) === '\u00fd7zXZ\u0000') return 'xz';
    if (read >= 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar';
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const SIGN_7Z = 0xafbc7a37; // '7z<BC><AF><27><1C>' as a little-endian u32 (kept for reference)

/** Fallback when there is no header (e.g. a plain tar with no ustar magic). */
function formatFromExt(file) {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '');
  if (ext === 'zip') return 'zip';
  if (ext === 'rar') return 'rar';
  if (ext === '7z') return '7z';
  if (ext === 'gz' || ext === 'tgz') return 'gz';
  if (ext === 'bz2') return 'bz2';
  if (ext === 'xz') return 'xz';
  if (ext === 'tar') return 'tar';
  return null;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** Resolves an archive entry inside `root`, throwing if it would escape it. */
function safeJoin(root, name) {
  const raw = String(name);
  if (raw.includes('\u0000')) throw new Error('Archive entry contains a NUL byte');

  // Strip drive letters and leading slashes, normalise separators.
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .join(path.sep);

  const base = path.resolve(root);
  if (!cleaned) return base; // entry is the archive root itself

  const resolved = path.resolve(base, cleaned);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Archive entry escapes the destination folder: ${name}`);
  }
  return resolved;
}

const isDir = (e) => /[\\/]$/.test(e.name);
const isSymlink = (e) => (e.mode & 0xf000) === 0xa000;

function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  // Not flagged UTF-8: Latin-1 is a close-enough superset of CP437 for paths.
  return buf.toString('latin1');
}

// ---------------------------------------------------------------------------
// Native ZIP
// ---------------------------------------------------------------------------

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

function readZipDirectory(fd, fileSize) {
  const back = Math.min(fileSize, 66000);
  const tail = readAt(fd, fileSize - back, back);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP archive (no end-of-central-directory record)');

  let totalEntries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  const needsZip64 = totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff;
  if (needsZip64 && eocd >= 20) {
    const locatorOff = fileSize - back + eocd - 20;
    const locator = readAt(fd, locatorOff, 20);
    if (locator.length === 20 && locator.readUInt32LE(0) === SIG_EOCD64_LOC) {
      const z64Off = Number(locator.readBigUInt64LE(8));
      const z64 = readAt(fd, z64Off, 56);
      if (z64.length === 56 && z64.readUInt32LE(0) === SIG_EOCD64) {
        totalEntries = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }
  }

  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  let p = 0;

  while (p + 46 <= cd.length && entries.length < totalEntries) {
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;

    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const extAttrs = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);

    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const size = extra.readUInt16LE(q + 2);
        const valStart = q + 4;
        if (id === ZIP64_EXTRA && valStart + 8 <= extra.length) {
          let v = valStart;
          if (uncompSize === 0xffffffff && v + 8 <= extra.length) {
            uncompSize = Number(extra.readBigUInt64LE(v));
            v += 8;
          }
          if (compSize === 0xffffffff && v + 8 <= extra.length) {
            compSize = Number(extra.readBigUInt64LE(v));
            v += 8;
          }
          if (localOffset === 0xffffffff && v + 8 <= extra.length) {
            localOffset = Number(extra.readBigUInt64LE(v));
          }
          break;
        }
        q = valStart + size;
      }
    }

    entries.push({
      name: decodeName(nameBuf, flags),
      method,
      compSize,
      uncompSize,
      localOffset,
      flags,
      mode: extAttrs >>> 16
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Local header sizes can differ from the central directory; read the real one. */
function localDataOffset(fd, entry) {
  const head = readAt(fd, entry.localOffset, 30);
  if (head.length !== 30 || head.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`Corrupt local header for entry: ${entry.name}`);
  }
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  return entry.localOffset + 30 + nameLen + extraLen;
}

function copyRange(archivePath, start, length, outPath, onBytes, cancelled) {
  return new Promise((resolve, reject) => {
    if (cancelled && cancelled()) return reject(new Error('Extraction cancelled'));
    if (length === 0) {
      fs.writeFileSync(outPath, Buffer.alloc(0));
      return resolve();
    }
    const rs = fs.createReadStream(archivePath, { start, end: start + length - 1 });
    const ws = fs.createWriteStream(outPath);
    rs.on('data', (b) => onBytes(b.length));
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

function inflateRange(archivePath, start, length, outPath, onBytes, cancelled) {
  return new Promise((resolve, reject) => {
    if (cancelled && cancelled()) return reject(new Error('Extraction cancelled'));
    if (length === 0) {
      fs.writeFileSync(outPath, Buffer.alloc(0));
      return resolve();
    }
    const rs = fs.createReadStream(archivePath, { start, end: start + length - 1 });
    const inflate = zlib.createInflateRaw();
    const ws = fs.createWriteStream(outPath);

    rs.on('error', reject);
    inflate.on('error', reject);
    ws.on('error', reject);
    inflate.on('data', (b) => onBytes(b.length));
    ws.on('finish', resolve);

    rs.pipe(inflate).pipe(ws);
  });
}

async function extractZipNative(archivePath, destDir, ctx) {
  const stat = fs.statSync(archivePath);
  const fd = fs.openSync(archivePath, 'r');
  let entries;
  try {
    entries = readZipDirectory(fd, stat.size);
    // Local header sizes can differ from the central directory, so the data
    // offset must be read while the descriptor is still open.
    for (const entry of entries) {
      entry.dataStart = isDir(entry) ? entry.localOffset : localDataOffset(fd, entry);
    }
  } finally {
    fs.closeSync(fd);
  }

  const total = entries.reduce((sum, e) => sum + (isDir(e) ? 0 : e.uncompSize || e.compSize), 0);
  let written = 0;
  const onBytes = (n) => {
    written += n;
    ctx.report(total ? (written / total) * 100 : 0);
  };

  ctx.onLog('info', `ZIP: ${entries.length} entries, ${total} bytes uncompressed`);

  let skipped = 0;
  for (const entry of entries) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('Extraction cancelled');
    if (isDir(entry)) continue;
    if (isSymlink(entry)) {
      skipped++;
      ctx.onLog('warn', `Skipping symlink entry: ${entry.name}`);
      continue;
    }

    const out = safeJoin(destDir, entry.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const start = entry.dataStart;
    if (entry.method === 0) {
      await copyRange(archivePath, start, entry.compSize, out, onBytes, ctx.cancelled);
    } else if (entry.method === 8) {
      await inflateRange(archivePath, start, entry.compSize, out, onBytes, ctx.cancelled);
    } else {
      skipped++;
      ctx.onLog('warn', `Unsupported compression method ${entry.method} for ${entry.name} - skipped`);
    }
  }

  return { format: 'zip', entries: entries.length, skipped };
}

// ---------------------------------------------------------------------------
// External tools (RAR / 7z / tar family)
// ---------------------------------------------------------------------------

function findTool(names) {
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .concat(
      win
        ? [
            'C:\\Program Files\\7-Zip',
            'C:\\Program Files (x86)\\7-Zip',
            'C:\\Program Files\\WinRAR',
            'C:\\Program Files (x86)\\WinRAR',
            path.join(process.env.ProgramFiles || '', '7-Zip'),
            path.join(process.env['ProgramFiles(x86)'] || '', '7-Zip')
          ]
        : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin']
    );

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

function runTool(tool, args, { onLine, onLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { windowsHide: true });
    let stderr = '';

    // RAR and 7-Zip both repaint their progress in place, so one logical line
    // arrives separated by CR and backspaces rather than LF. Split on all three
    // or a whole extraction looks like a single enormous line and only its
    // first percentage is ever read.
    const feed = (buf) => String(buf).split(/[\r\n\b]+/).forEach((line) => line && onLine && onLine(line));
    child.stdout.on('data', feed);
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
      feed(buf);
    });

    child.on('error', (err) => reject(new Error(`Could not run ${path.basename(tool)}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${path.basename(tool)} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`));
    });
  });
}

/**
 * External tools insist on a file extension.
 *
 * Handed an extension-less path, UnRAR.exe appends ".rar" to the argument and
 * then fails to find the file ("Cannot open X.rar", exit 10). Providers hand out
 * extension-less names (the mirror id), so give the tool a hard-linked alias
 * that carries the right extension - no copy, no extra disk use.
 */
function aliasWithExtension(archivePath, format) {
  if (path.extname(archivePath)) return { path: archivePath, cleanup: null };
  const ext = { rar: 'rar', '7z': '7z', zip: 'zip', tar: 'tar', gz: 'gz', bz2: 'bz2', xz: 'xz' }[format];
  if (!ext) return { path: archivePath, cleanup: null };

  const alias = `${archivePath}.${ext}`;
  try {
    fs.linkSync(archivePath, alias);
    return { path: alias, cleanup: () => { try { fs.unlinkSync(alias); } catch { /* ignore */ } } };
  } catch {
    // Hard links can fail (odd filesystem); the tool may still cope as-is.
    return { path: archivePath, cleanup: null };
  }
}

async function extractWithTool(archivePath, destDir, format, ctx) {
  const alias = aliasWithExtension(archivePath, format);
  try {
    return await extractWithToolAt(alias.path, destDir, format, ctx);
  } finally {
    if (alias.cleanup) alias.cleanup();
  }
}

async function extractWithToolAt(archivePath, destDir, format, ctx) {
  const sevenZip = findTool(['7z', '7za', '7zz', '7zr']);
  // WinRAR ships UnRAR.exe (extractor) and Rar.exe (full console tool); either
  // reads RAR5. 7-Zip is preferred over both when it is present.
  const unrar = findTool(['unrar', 'unrar-free', 'rar']);
  const bsdtar = findTool(['bsdtar', 'tar', 'gtar']);

  if (format === 'rar' && sevenZip) {
    ctx.onLog('info', `Extracting RAR with ${path.basename(sevenZip)}`);
    return runSevenZip(sevenZip, archivePath, destDir, ctx);
  }
  if (format === 'rar' && unrar) {
    ctx.onLog('info', `Extracting RAR with ${path.basename(unrar)}`);
    // -idc drops the copyright banner but keeps the progress ticks, and -p-
    // stops an encrypted archive from blocking forever on a stdin nobody feeds.
    await runTool(unrar, ['x', '-y', '-idc', '-p-', archivePath, `${destDir}${path.sep}`], {
      onLine: percentReporter(ctx),
      onLog: ctx.onLog
    });
    return { format, entries: null, skipped: 0 };
  }
  if (format === '7z') {
    if (!sevenZip) {
      throw new Error('7z archives need 7-Zip installed (or extract it and add the game manually)');
    }
    return runSevenZip(sevenZip, archivePath, destDir, ctx);
  }
  if (['tar', 'gz', 'bz2', 'xz'].includes(format)) {
    if (bsdtar) {
      ctx.onLog('info', `Extracting ${format} with ${path.basename(bsdtar)}`);
      await runTool(bsdtar, ['-xf', archivePath, '-C', destDir], { onLine: () => {}, onLog: ctx.onLog });
      return { format, entries: null, skipped: 0 };
    }
    throw new Error(`Cannot extract .${format} without bsdtar/tar available on this system`);
  }
  if (format === 'zip' && bsdtar) {
    // Only reached if the native parser rejected the file.
    await runTool(bsdtar, ['-xf', archivePath, '-C', destDir], { onLine: () => {}, onLog: ctx.onLog });
    return { format: 'zip', entries: null, skipped: 0 };
  }

  throw new Error(
    `No extractor available for "${format}" archives. Install 7-Zip or WinRAR, `
    + `or unpack ${path.basename(archivePath)} yourself and add the game manually.`
  );
}

/**
 * Turns a tool's progress output into percentages.
 *
 * Both 7-Zip and RAR print every tick on one in-place line, so the *last*
 * `NN%` in a chunk is the current progress - earlier ones are history, and a
 * file name in the line can itself contain a '%'.
 */
function percentReporter(ctx) {
  let last = -1;
  return (line) => {
    const hits = String(line).match(/\d{1,3}%/g);
    if (!hits) return;
    const pct = Math.min(100, Number(hits[hits.length - 1].slice(0, -1)));
    if (!Number.isFinite(pct) || pct === last) return;
    last = pct;
    ctx.report(pct);
  };
}

function runSevenZip(tool, archivePath, destDir, ctx) {
  return runTool(tool, ['x', '-y', '-bsp1', '-bso0', '-bse1', `-o${destDir}`, '--', archivePath], {
    onLine: percentReporter(ctx),
    onLog: ctx.onLog
  }).then(() => ({ format: '7z-tool', entries: null, skipped: 0 }));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extracts `archivePath` into `destDir`.
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @param {object} [opts]
 * @param {(pct:number)=>void} [opts.onProgress]  0..100 within the extract phase
 * @param {(level:string,msg:string)=>void} [opts.onLog]
 * @param {()=>boolean} [opts.cancelled]
 * @returns {Promise<{format:string, entries:number|null, skipped:number}>}
 */
async function extract(archivePath, destDir, opts = {}) {
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  fs.mkdirSync(destDir, { recursive: true });

  const format = sniff(archivePath) || formatFromExt(archivePath);
  if (!format) throw new Error('Unrecognised archive format');

  let lastEmit = 0;
  const ctx = {
    onLog,
    cancelled: opts.cancelled,
    report: (pct) => {
      const now = Date.now();
      if (now - lastEmit < 150 && pct < 100) return;
      lastEmit = now;
      onProgress(Math.max(0, Math.min(100, pct)));
    }
  };

  onLog('info', `Extracting ${path.basename(archivePath)} (${format})`);

  try {
    if (format === 'zip') {
      const result = await extractZipNative(archivePath, destDir, ctx).catch((err) => {
        // The native parser is strict; hand odd-but-valid zips to a system tool.
        const fallback = findTool(['bsdtar', 'tar', '7z', '7za']);
        if (!fallback) throw err;
        onLog('warn', `Native ZIP parser failed (${err.message}); falling back to ${path.basename(fallback)}`);
        return extractWithTool(archivePath, destDir, 'zip', ctx);
      });
      ctx.report(100);
      return result;
    }

    const result = await extractWithTool(archivePath, destDir, format, ctx);
    ctx.report(100);
    return result;
  } catch (err) {
    onLog('error', `Extraction failed: ${err.message}`);
    throw err;
  }
}

module.exports = { extract, sniff, safeJoin, findTool, formatFromExt, extractZipNative, aliasWithExtension };
