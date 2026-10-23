'use strict';

/**
 * Apex install coordinator (main process).
 *
 * Owns the lifecycle of a game install:
 *
 *   resolve source -> validate host policy -> download (multi-connection,
 *   resumable) -> verify sha256 -> extract -> place into the games folder
 *
 * It is deliberately ignorant of *where* content comes from: that is the job of
 * net/sources.js, which enforces the host policy. This module only ever talks
 * to a already-validated item `{ url, sha256, extract, dest, filename }`.
 *
 * Progress is pushed to the renderer as a single event stream:
 *   win.webContents.send('dl:event', { type:'job', id, state, phase, pct, ... })
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Transfer } = require('./net/download');
const { USER_AGENT } = require('./net/http');
const archives = require('./net/archives');
const detect = require('./detect');
const { SourceRegistry, fileUrlToPath } = require('./net/sources');
const itch = require('./net/itch');
const providers = require('./net/providers');
const browserResolver = require('./net/providers/browser');

const MB = 1024 * 1024;

/** id -> job */
const JOBS = new Map();

let emitToRenderer = () => {};
let registry = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bandwidthBps(setting) {
  if (!setting || setting === 'unlimited') return Infinity;
  const n = Number(setting);
  return Number.isFinite(n) && n > 0 ? n * MB : Infinity;
}

/** Origin of a URL, for a Referer header; '' when the URL is unusable. */
function originOf(rawUrl) {
  try {
    return new URL(String(rawUrl)).origin;
  } catch {
    return '';
  }
}

function safeDestName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'Game';
}

/**
 * Store ids routinely contain characters that are illegal in a Windows path
 * segment (custom games use `custom:<slug>`), so the on-disk workspace name is
 * a sanitised slug plus a short hash of the original id to stay unique.
 */
function safeSlug(id) {
  const slug = String(id)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 60);
  const hash = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8);
  return `${slug || 'game'}-${hash}`;
}

/** Extensions the launcher is allowed to start directly. */
const LAUNCHABLE_EXT = new Set(['.exe', '.bat', '.cmd', '.lnk', '.url']);

/**
 * Works out what to start after a download finishes.
 *
 * The engine knows the real install folder, but the renderer used to receive
 * only that path - no executable - so a freshly installed game had nothing to
 * launch and its first Play press failed verification. Picking the executable
 * here means the link is persisted together with the completed download.
 *
 * @param {string|null} dest  installed folder, or a single installed file
 * @param {string} title
 * @returns {{type:string, exe:string|null, cwd:string, path:string, name:string, source:string}|null}
 */
function launchFor(dest, title) {
  if (!dest) return null;
  try {
    const st = fs.statSync(dest);
    if (st.isFile()) {
      if (!LAUNCHABLE_EXT.has(path.extname(dest).toLowerCase())) return null;
      return {
        type: 'exe',
        exe: dest,
        cwd: path.dirname(dest),
        path: path.dirname(dest),
        name: title || null,
        source: 'download'
      };
    }
    if (st.isDirectory()) {
      const exe = detect.pickExe(dest, [title || '', path.basename(dest)], 4);
      return {
        type: 'exe',
        exe: exe || null,
        cwd: exe ? path.dirname(exe) : dest,
        path: dest,
        name: title || null,
        source: 'download'
      };
    }
  } catch { /* an install that vanished between done and inspection */ }
  return null;
}

/** Public, serialisable view of a job for the renderer. */
function view(job) {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    state: job.state,
    phase: job.phase,
    paused: job.state === 'paused',
    pct: job.pct,
    received: job.received,
    total: job.total,
    speedBps: job.speedBps,
    mirror: job.mirror || null,
    etaMs: Number.isFinite(job.etaMs) ? job.etaMs : null,
    extractPct: job.extractPct,
    error: job.error || null,
    dest: job.destPath || null,
    file: job.filePath || null,
    launch: job.launch || null,
    connections: job.connections || 1
  };
}

function emit(options) {
  const job = options.job;
  try {
    emitToRenderer({ type: 'job', ...view(job) });
  } catch (err) {
    if (options.log) options.log('warn', `Could not reach the renderer: ${err.message}`);
  }
}

function makeLogger(id, sink) {
  return (level, msg) => {
    const line = `[install ${id}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (sink) sink(level, msg);
  };
}

function hashFile(file, { onProgress, cancelled } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 4 * MB });
    let read = 0;

    stream.on('data', (buf) => {
      if (cancelled && cancelled()) {
        stream.destroy();
        return;
      }
      read += buf.length;
      hash.update(buf);
      if (onProgress) onProgress(read);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Best-effort filename for a remote URL, used when an item does not name one. */
function guessFilename(rawUrl, fallbackId) {
  try {
    const u = new URL(rawUrl);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (base) return base;
  } catch {
    const base = path.basename(String(rawUrl));
    if (base) return base;
  }
  return `${fallbackId}.bin`;
}

/** Canonical extension per sniffed archive format. */
const FORMAT_EXT = { zip: 'zip', rar: 'rar', '7z': '7z', gz: 'gz', bz2: 'bz2', xz: 'xz', tar: 'tar' };

/**
 * Gives a downloaded archive the extension its bytes imply.
 *
 * Providers name the payload after the mirror id, which usually has no
 * extension at all ("87fquh7wht73", "3juu4Uwm"). External extractors are strict
 * about that: UnRAR.exe silently appends ".rar" to an extension-less argument
 * and then cannot find the file it was handed -
 *
 *     Cannot open ...\87fquh7wht73.rar
 *     The system cannot find the file specified.
 *     No files to extract            -> exit 10
 *
 * which is reported to the user as a bare "unrar.exe exited with code 10".
 * Fixing the name here repairs every extractor at once (7-Zip, WinRAR, tar).
 *
 * @param {string} archivePath
 * @param {string|null} [hint]  the real file name the provider advertised
 * @returns {string} the path to use from now on
 */
function normalizeArchivePath(archivePath, hint) {
  let current = archivePath;

  // Prefer the provider's own file name when ours carries no extension.
  if (!path.extname(current) && hint) {
    const clean = safeDestName(path.basename(String(hint)));
    if (clean && path.extname(clean)) {
      const next = path.join(path.dirname(current), clean);
      if (next !== current) {
        try { fs.renameSync(current, next); current = next; } catch { /* keep the old name */ }
      }
    }
  }

  const format = archives.sniff(current);
  const ext = FORMAT_EXT[format];
  if (!ext) return current;

  const have = path.extname(current).toLowerCase().replace(/^\./, '');
  const acceptable = have === ext
    || (format === 'gz' && (have === 'tgz' || /\.tar\.gz$/i.test(current)))
    || (format === 'bz2' && (have === 'tbz' || have === 'tbz2'))
    || (format === 'xz' && have === 'txz');
  if (acceptable) return current;

  const base = have ? current.slice(0, -(have.length + 1)) : current;
  const wanted = format === 'gz' && /\.tar$/i.test(base) ? 'tar.gz' : ext;
  const next = `${base}.${wanted}`;
  try {
    fs.renameSync(current, next);
    return next;
  } catch {
    return current;
  }
}

/** Moves `from` to `to`, falling back to copy+remove across devices. */
async function movePath(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  await fsp.cp(from, to, { recursive: true });
  await fsp.rm(from, { recursive: true, force: true });
}

/**
 * Builds the item for one itch.io build.
 *
 * The signed URL comes from itch.io's official API, asked with the user's own
 * key, and it is short-lived — which is why it is resolved here, at install
 * time, rather than stored when the card was drawn.
 *
 * itch.io publishes no digest, so the item is marked `checksumOptional` and
 * tagged `trustedSource: 'itch'`. That pair is the only thing
 * `SourceRegistry.validate` accepts without a sha256, and no manifest can
 * produce it.
 */
async function itchItem(target, settings) {
  const key = String((settings && settings.itch && settings.itch.apiKey) || '').trim();
  if (!key) throw new Error('Connect your itch.io account in Settings before downloading from itch.io.');

  const uploadId = target.uploadId || null;
  if (!uploadId) throw new Error('Choose an itch.io build to install first.');

  const resolved = await itch.resolveUpload(key, uploadId);
  if (!resolved || !resolved.url) throw new Error('itch.io returned no download URL for that build.');

  return {
    id: String(target.id),
    title: target.title || String(target.id),
    url: resolved.url,
    kind: 'http',
    sha256: null,
    checksumOptional: true,
    trustedSource: 'itch',
    size: Number(target.size) || 0,
    filename: target.filename || resolved.filename || null,
    extract: target.extract !== false,
    dest: String(target.dest || target.title || target.id),
    cover: target.cover || null,
    developer: target.developer || null,
    origin: 'itch'
  };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

const installs = {
  /** Wires the renderer sink and builds the source registry. */
  init(opts = {}) {
    emitToRenderer = typeof opts.send === 'function' ? opts.send : () => {};
    registry = new SourceRegistry({
      getSettings: opts.getSettings || (() => ({})),
      userDataDir: opts.userDataDir || null,
      appDir: opts.appDir || process.cwd(),
      onLog: (level, msg) => console.log(`[sources] ${msg}`)
    });
    return installs;
  },

  /** Search configured manifests. */
  search(query) {
    if (!registry) return [];
    return registry
      .search(query)
      .map((item) => ({
        id: item.id,
        title: item.title,
        developer: item.developer,
        size: item.size,
        kind: item.kind,
        cover: item.cover,
        origin: path.basename(item.origin || '')
      }));
  },

  /** Live jobs (for a renderer reload). */
  list() {
    return [...JOBS.values()].map(view);
  },

  /**
   * Kicks off an install. Resolves the source (which may mean asking itch.io
   * for a signed URL), then hands straight back with the initial job view; the
   * pipeline runs in the background and reports through the event emitter.
   *
   * @param {{id:string,title?:string,kind?:string,url?:string,sha256?:string,
   *          provider?:string,gameId?:number|string,uploadId?:number|string}} target
   * @param {{settings:object}} ctx
   */
  async start(target, ctx = {}) {
    const settings = ctx.settings || {};
    const id = String((target && target.id) || '').trim();
    if (!id) return { ok: false, error: 'install target has no id' };
    if (!registry) return { ok: false, error: 'install coordinator is not initialised' };

    const existing = JOBS.get(id);
    if (existing) return { ok: true, job: view(existing), alreadyRunning: true };

    let item;
    try {
      if (target.provider === 'itch') {
        item = await itchItem(target, settings);
      } else if (target.provider) {
        const delivered = await providers.deliver(target.provider, target, { settings });
        if (!delivered || delivered.ok !== true || !delivered.item || !delivered.item.url) {
          throw new Error((delivered && delivered.reason) || 'The provider could not resolve a source.');
        }
        item = delivered.item;
        if (!item.id) item.id = id;
        if (!item.title) item.title = target.title || id;
        item.kind = item.kind || 'http';
        item.extract = item.extract !== false;
        item.dest = item.dest || target.dest || target.title || id;
        if (item.checksumOptional && !item.trustedSource) item.trustedSource = String(target.provider);
      } else if (target.url) {
        item = registry.fromUrl(target.url, {
          id,
          title: target.title,
          sha256: target.sha256,
          size: target.size,
          extract: target.extract
        });
        // Ad-hoc direct URLs (e.g. SteamRip mirrors) may carry their own
        // policy fields and request headers; honour them instead of dropping.
        if (item) {
          if (target.checksumOptional === true) item.checksumOptional = true;
          if (target.trustedSource) item.trustedSource = target.trustedSource;
          if (target.headers && typeof target.headers === 'object') item.headers = target.headers;
          if (target.cover) item.cover = target.cover;
          if (target.steamAppId) item.steamAppId = target.steamAppId;
          if (target.logo) item.logo = target.logo;
        }
      } else {
        item = registry.resolve(id);
        if (!item) {
          return {
            ok: false,
            error: `No download source is configured for "${target.title || id}". Add it to a manifest in settings.download.manifests.`
          };
        }
      }
      registry.validate(item);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const job = {
      id,
      title: target.title || item.title || id,
      kind: target.kind || 'install',
      item,
      state: 'resolving',
      phase: 'Preparing',
      pct: 0,
      received: 0,
      total: item.size || 0,
      speedBps: 0,
      etaMs: Infinity,
      extractPct: 0,
      error: null,
      destPath: null,
      filePath: null,
      connections: 1,
      transfer: null,
      cancelled: false,
      settings,
      log: null
    };
    job.log = makeLogger(id, null);
    JOBS.set(id, job);

    // Fire and forget: the pipeline reports through events.
    installsPipeline(job).catch((err) => {
      job.log('error', err.stack || err.message);
    });

    return { ok: true, job: view(job) };
  },

  pause(id) {
    const job = JOBS.get(String(id));
    if (!job) return { ok: false, error: 'unknown job' };
    if (job.transfer) job.transfer.pause();
    if (job.state === 'downloading') {
      job.state = 'paused';
      emit({ job });
    }
    return { ok: true, job: view(job) };
  },

  resume(id) {
    const job = JOBS.get(String(id));
    if (!job) return { ok: false, error: 'unknown job' };
    if (job.transfer) job.transfer.resume();
    if (job.state === 'paused') {
      job.state = 'downloading';
      emit({ job });
    }
    return { ok: true, job: view(job) };
  },

  cancel(id) {
    const job = JOBS.get(String(id));
    if (!job) return { ok: false, error: 'unknown job' };
    job.cancelled = true;
    if (job.transfer) job.transfer.cancel();
    if (job._torrentClient) { try { job._torrentClient.destroy(); } catch { /* ignore */ } job._torrentClient = null; }
    job.state = 'cancelled';
    job.phase = 'Cancelled';
    emit({ job });
    // The pipeline removes the job once it unwinds.
    return { ok: true };
  }
};

// ---------------------------------------------------------------------------
// Browser-based fallback (Cloudflare-protected mirrors)
// ---------------------------------------------------------------------------
/**
 * Fetches a mirror through a hidden BrowserWindow.
 *
 * Mirrors behind Cloudflare answer the engine's socket with a bare 403, but a
 * real navigation can pass the challenge and start the download. The subtlety
 * is that Chromium reports an aborted navigation (ERR_ABORTED, -3) at the very
 * moment a download takes over - so that code has to be read as "download
 * starting", not as a fatal load error. Closing the window there (the previous
 * behaviour) cancelled the transfer before it could finish, which is why a
 * blocked mirror surfaced as `Failed to load (-3)` instead of an install.
 */
function browserDownload(url, dest, job, opts = {}) {
  const overallMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let BrowserWindow;
    try {
      BrowserWindow = require('electron').BrowserWindow;
    } catch (err) {
      reject(err);
      return;
    }

    // The direct attempt may have left a truncated file and its resume sidecar
    // behind. The browser saves to the same path, so start it from clean.
    for (const stale of [dest, `${dest}.apexpart`]) {
      try { fs.rmSync(stale, { force: true }); } catch { /* best effort */ }
    }

    let win;
    try {
      win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        width: 1100,
        height: 800,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          // Hidden windows are CPU-throttled by default, which stalls the
          // page's own download-triggering scripts.
          backgroundThrottling: false,
          // A dedicated partition keeps Cloudflare clearance cookies across
          // retries and stops this window from touching the app's own session.
          partition: 'persist:apex-mirror'
        }
      });
    } catch (err) {
      reject(err);
      return;
    }

    // This window exists purely to satisfy Cloudflare and start a transfer; it
    // must never be seen, whatever the page does.
    win.on('show', () => { try { win.hide(); } catch { /* ignore */ } });

    // Some providers (and Cloudflare) call window.open. Deny it and continue in
    // this hidden window so nothing can surface as a new window or tab.
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (/^https?:\/\//i.test(popup)) {
        win.webContents.loadURL(popup, { userAgent: USER_AGENT }).catch(() => { /* ignore */ });
      }
      return { action: 'deny' };
    });

    const session = win.webContents.session;
    let settled = false;
    let downloadStarted = false;
    let idleTimer = null;
    let overallTimer = null;

    const clearTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      try { session.removeListener('will-download', onWillDownload); } catch { /* ignore */ }
      try { if (win && !win.isDestroyed()) win.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve();
    };

    // If the page settles (or its navigation aborts) without a download
    // appearing, allow a bounded grace period, then fail - so a dead mirror
    // errors out instead of holding the install open until the hard timeout.
    const armIdleWatch = (ms, message) => {
      if (downloadStarted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!downloadStarted) finish(new Error(message)); }, ms);
    };

    const onWillDownload = (event, item, webContents) => {
      // The "apex-mirror" partition is shared; only own this window's transfer.
      if (webContents && webContents !== win.webContents) return;
      downloadStarted = true;
      clearTimeout(idleTimer);
      try { item.setSavePath(dest); } catch { /* ignore */ }
      item.on('updated', () => {
        try {
          job.received = item.getReceivedBytes();
          job.total = item.getTotalBytes() || job.total;
          job.pct = job.total ? (job.received / job.total) * 100 : job.pct;
          emit({ job });
        } catch { /* ignore */ }
      });
      item.on('done', (e, state) => {
        if (state === 'completed') finish();
        else finish(new Error(`Download ${state}`));
      });
    };
    session.on('will-download', onWillDownload);

    win.webContents.on('did-fail-load', (e, code, desc, _url, isMainFrame) => {
      // ERR_ABORTED (-3) is what Chromium reports when the navigation turns into
      // a download, and anything after `will-download` is equally benign.
      if (downloadStarted) return;
      if (code === -3) {
        armIdleWatch(30000, `The mirror stopped responding before a download started (${desc || code})`);
        return;
      }
      if (isMainFrame === false) return;
      finish(new Error(desc || `Failed to load (${code})`));
    });

    // Some mirrors (Gofile, Buzzheavier, ...) only expose the real file after a
    // button click, so nudge the page's own download control once it settles.
    // Those pages are script-driven, and Cloudflare may still be solving, so
    // the nudge is repeated.
    win.webContents.on('did-finish-load', () => {
      armIdleWatch(90000, 'The mirror page loaded but never started a download.');
      let tries = 0;
      const poke = () => {
        if (settled || downloadStarted) return;
        win.webContents.executeJavaScript(browserResolver.CLICK_SCRIPT).catch(() => { /* ignore */ });
        if (++tries < 12) setTimeout(poke, 1200);
      };
      poke();
    });

    win.loadURL(url, {
      userAgent: USER_AGENT,
      httpReferrer: opts.referrer ? String(opts.referrer) : undefined
    }).catch((err) => {
      if (downloadStarted) return;
      // The load promise also rejects with ERR_ABORTED when the URL downloads.
      const message = (err && err.message) || '';
      if (/-3|ERR_ABORTED/.test(message)) {
        armIdleWatch(30000, 'The mirror stopped responding before a download started.');
        return;
      }
      finish(err);
    });

    overallTimer = setTimeout(() => finish(new Error('Timed out waiting for download')), overallMs);
  });
}

// ---------------------------------------------------------------------------
// Multi-provider failover
// ---------------------------------------------------------------------------
const HTML_SNIFF_BYTES = 1024;

/**
 * True when a freshly downloaded file is really a web page.
 *
 * Provider landing pages answer the engine with 200 + HTML, which then blows up
 * at extraction with "Unrecognised archive format". Detecting it here instead
 * lets the coordinator drop that mirror and try the next one.
 */
async function looksLikeHtml(filePath) {
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(HTML_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HTML_SNIFF_BYTES, 0);
    const head = buf
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart()
      .toLowerCase();
    if (!head) return false;
    return head.startsWith('<!doctype html')
      || head.startsWith('<html')
      || /^<(head|body|meta|script|link)\b/.test(head);
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Mirrors to try, best-first: the resolved provider list, else the single URL. */
function sourceList(item) {
  const all = Array.isArray(item.sources) && item.sources.length
    ? item.sources
    : [{ url: item.url, provider: item.lightningProvider || null, headers: item.headers || null, kind: item.kind }];
  const usable = all.filter((s) => s && s.url);
  // A magnet cannot be fetched by the HTTP engine (the torrent path runs
  // earlier), so keep it out of the HTTP failover list - unless it is all we
  // have, in which case let the engine report the real failure.
  const http = usable.filter((s) => s.kind !== 'torrent');
  return http.length ? http : usable;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function installsPipeline(job) {
  const settings = job.settings;
  const item = job.item;
  const downloadsRoot = path.resolve(settings.downloadPath || path.join(process.cwd(), 'Downloads'));
  const installRoot = path.resolve(settings.installPath || path.join(process.cwd(), 'Games'));

  const workDir = path.join(downloadsRoot, 'apex', safeSlug(job.id));
  const stagingDir = path.join(workDir, '_extract');
  const destName = safeDestName(item.dest || job.title);
  const finalDir = path.join(installRoot, destName);

  const filename = item.filename || guessFilename(item.url, job.id);
  let archivePath = path.join(workDir, filename);
  // The provider can name the real file while resolving a mirror page; used to
  // repair an extension-less archive name before extraction.
  let archiveNameHint = item.archiveName || null;

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(installRoot, { recursive: true });
    job.log('info', `Work dir: ${workDir}`);

    // --- only way this job proceeds past here is with a validated item ------
    const dls = settings.download || {};
    const connections = Math.max(1, Math.min(16, Number(dls.connections) || 4));
    const isTorrent = item.kind === 'torrent' || /^magnet:/i.test(String(item.url || ''));

    // --- WebTorrent (P2P) path, modelled on Project Lightning ---------------
    if (isTorrent) {
      job.state = 'downloading';
      job.phase = 'Downloading (P2P)';
      job.connections = 1;
      emit({ job });

      let WebTorrent;
      try {
        WebTorrent = require('webtorrent');
      } catch (err) {
        throw new Error('WebTorrent is not available in this build.');
      }
      const client = new WebTorrent();
      job._torrentClient = client;

      await new Promise((resolve, reject) => {
        const torrent = client.add(item.url, { path: workDir }, (t) => {
          const tick = setInterval(() => {
            if (job.cancelled) return;
            job.received = Number(t.downloaded) || 0;
            job.total = Number(t.length) || job.total;
            job.pct = Number.isFinite(t.progress) ? t.progress * 100 : job.pct;
            job.speedBps = Number(t.downloadSpeed) || 0;
            emit({ job });
          }, 1000);

          t.on('done', () => { clearInterval(tick); resolve(); });
          t.on('error', (err) => { clearInterval(tick); reject(err); });
        });
        if (torrent && typeof torrent.on === 'function') torrent.on('error', reject);
      });

      if (job.cancelled) throw new Error('cancelled');
      job.transfer = null;
      job.pct = 100;

      job.state = 'installing';
      job.phase = 'Installing';
      emit({ job });

      if (fs.existsSync(finalDir)) {
        const backup = `${finalDir}.replaced-${Date.now()}`;
        await fsp.rename(finalDir, backup);
        try {
          await movePath(workDir, finalDir);
          await fsp.rm(backup, { recursive: true, force: true });
        } catch (err) {
          await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
          await fsp.rename(backup, finalDir).catch(() => {});
          throw err;
        }
      } else {
        await movePath(workDir, finalDir);
      }

      try { client.destroy(); } catch { /* ignore */ }
      job._torrentClient = null;
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

      job.state = 'done';
      job.phase = 'Installed';
      job.pct = 100;
      job.received = job.total;
      job.speedBps = 0;
      job.destPath = finalDir;
      job.launch = launchFor(finalDir, job.title);
      job.log('info', `Installed to ${finalDir}`);
      emit({ job });
      return;
    }

    // --- resolve local file sources instantly -------------------------------
    if (item.kind === 'file') {
      const src = fileUrlToPath(item.url);
      job.state = 'downloading';
      job.phase = 'Copying';
      emit({ job });
      await movePath(src, archivePath);
      job.received = job.total = fs.statSync(archivePath).size;
      job.pct = 100;
    } else {
      // --- download --------------------------------------------------------
      job.state = 'downloading';
      job.phase = 'Downloading';
      job.connections = connections;
      emit({ job });

      const attemptMirror = async (source, isLast) => {
        const label = source.provider || 'mirror';

        // A previous mirror may have left a partial file and resume sidecar.
        for (const stale of [archivePath, `${archivePath}.apexpart`]) {
          try { fs.rmSync(stale, { force: true }); } catch { /* best effort */ }
        }
        job.received = 0;
        job.pct = 0;
        job.speedBps = 0;

        const engineFetch = async (url, headers) => {
          const transfer = new Transfer({
            url,
            dest: archivePath,
            connections,
            headers,
            bandwidthBps: bandwidthBps(settings.bandwidth),
            onLog: job.log,
            onProgress: (p) => {
              job.received = p.received;
              job.total = p.total;
              job.pct = p.pct;
              job.speedBps = p.speedBps;
              job.etaMs = p.etaMs;
              job.connections = p.connections;
              const wantPaused = !!p.paused;
              if ((job.state === 'paused') !== wantPaused) {
                job.state = wantPaused ? 'paused' : 'downloading';
              }
              emit({ job });
            }
          });
          job.transfer = transfer;
          try {
            await transfer.start();
          } finally {
            job.transfer = null;
          }
          if (job.cancelled) throw new Error('cancelled');

          // A landing page, not a file: fall through to the browser resolver.
          if (await looksLikeHtml(archivePath)) {
            throw new Error(`${label} served a web page instead of a file`);
          }
        };

        const baseHeaders = { ...(item.headers || {}), ...(source.headers || {}) };

        // Cloudflare-fronted mirrors only answer a real browser. Rather than
        // burn a request on the 403 we know is coming, go straight to the
        // hidden background window for those.
        let firstError = null;
        if (!source.needsBrowser) {
          try {
            await engineFetch(source.url, baseHeaders);
            return;
          } catch (err) {
            job.transfer = null;
            if (job.cancelled) throw err;
            firstError = err;
            const recoverable = !!err && (err.blocked || /401|403|451|web page instead/i.test(err.message || ''));
            if (!recoverable) throw err;
          }
        }

        const reason = firstError ? firstError.message : 'this host blocks plain downloads';
        job.log('warn', `"${label}" needs a real browser (${reason}); opening it in the background...`);

        // 1) Ask the hidden window for the provider's *signed* file link. The
        //    link is issued to whoever loads the page, but the file itself is
        //    served by the CDN - so the fast engine can pull it down directly.
        let resolved = null;
        try {
          resolved = await browserResolver.resolveInBrowser(source.url, {
            provider: label,
            referrer: source.referrer,
            timeoutMs: isLast ? 60000 : 30000
          });
        } catch (err) {
          resolved = { ok: false, reason: err.message };
        }
        if (job.cancelled) throw new Error('cancelled');

        if (resolved && resolved.ok && resolved.url) {
          if (resolved.filename) archiveNameHint = resolved.filename;
          job.log('info', `Resolved "${label}" in the background; downloading the file link directly.`);
          try {
            await engineFetch(resolved.url, {
              ...baseHeaders,
              Referer: originOf(source.url) || undefined
            });
            return;
          } catch (err) {
            job.transfer = null;
            if (job.cancelled) throw err;
            job.log('warn', `Direct link failed (${err.message}); retrying through the background browser...`);
          }
        } else if (resolved) {
          job.log('warn', `Could not resolve "${label}" in the background: ${resolved.reason}`);
        }

        // 2) Last resort: the hidden window downloads it itself. Still no
        //    window, tab or site is ever shown.
        await browserDownload(source.url, archivePath, job, {
          timeoutMs: isLast ? undefined : 120000,
          referrer: source.referrer
        });
        if (await looksLikeHtml(archivePath)) {
          throw new Error(`${label} served a web page instead of a file`);
        }
      };

      const list = sourceList(item);
      let lastMirrorError = null;
      for (let i = 0; i < list.length; i += 1) {
        const source = list[i];
        const label = source.provider || `mirror ${i + 1}`;
        if (i > 0) job.log('warn', `Trying the next mirror (${label})...`);
        job.mirror = label;
        job.connections = connections;
        emit({ job });
        try {
          await attemptMirror(source, i === list.length - 1);
          lastMirrorError = null;
          break;
        } catch (err) {
          if (job.cancelled) throw err;
          lastMirrorError = err;
          job.log('warn', `Mirror "${label}" failed: ${err.message}`);
        }
      }
      if (lastMirrorError) {
        const tried = list.map((s) => s.provider || s.url).join(', ');
        throw new Error(`${lastMirrorError.message} - every mirror failed (${tried})`);
      }
      job.pct = 100;
    }

    // --- verify --------------------------------------------------------------
    job.state = 'verifying';
    job.phase = 'Verifying';
    emit({ job });

    // Extension-less provider names break the external extractors; repair the
    // name before anything downstream looks at the file.
    const renamed = normalizeArchivePath(archivePath, archiveNameHint);
    if (renamed !== archivePath) {
      job.log('info', `Archive saved as ${path.basename(renamed)}`);
      archivePath = renamed;
    }

    const stat = await fsp.stat(archivePath);
    job.total = stat.size;
    if (item.sha256) {
      const digest = await hashFile(archivePath, {
        cancelled: () => job.cancelled,
        onProgress: (read) => {
          job.received = read;
          job.pct = stat.size ? (read / stat.size) * 100 : 100;
          emit({ job });
        }
      });
      if (job.cancelled) throw new Error('cancelled');
      if (digest.toLowerCase() !== item.sha256.toLowerCase()) {
        throw new Error(`Checksum mismatch: expected ${item.sha256}, got ${digest}`);
      }
      job.log('info', 'Checksum verified');
    } else {
      job.log('warn', 'No checksum supplied for this item; skipping verification');
    }

    // --- extract & place ----------------------------------------------------
    let placed;
    if (item.extract) {
      job.state = 'extracting';
      job.phase = 'Extracting';
      job.pct = 0;
      emit({ job });

      await fsp.rm(stagingDir, { recursive: true, force: true });
      await archives.extract(archivePath, stagingDir, {
        cancelled: () => job.cancelled,
        onLog: job.log,
        onProgress: (pct) => {
          job.extractPct = pct;
          job.pct = pct;
          emit({ job });
        }
      });
      if (job.cancelled) throw new Error('cancelled');

      job.state = 'installing';
      job.phase = 'Installing';
      emit({ job });

      // Swap the staging folder into place without clobbering on failure.
      if (fs.existsSync(finalDir)) {
        const backup = `${finalDir}.replaced-${Date.now()}`;
        await fsp.rename(finalDir, backup);
        try {
          await movePath(stagingDir, finalDir);
          await fsp.rm(backup, { recursive: true, force: true });
        } catch (err) {
          await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
          await fsp.rename(backup, finalDir).catch(() => {});
          throw err;
        }
      } else {
        await movePath(stagingDir, finalDir);
      }
      placed = finalDir;

      // The archive has served its purpose.
      await fsp.unlink(archivePath).catch(() => {});
    } else {
      job.state = 'installing';
      job.phase = 'Installing';
      emit({ job });

      fs.mkdirSync(finalDir, { recursive: true });
      // Use the name the file actually ended up with (normalizeArchivePath may
      // have repaired it), so an extension-less provider id does not install a
      // file the OS cannot tell what to do with.
      const target = path.join(finalDir, path.basename(archivePath) || filename);
      await movePath(archivePath, target);
      placed = finalDir;
      job.filePath = target;
    }

    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

    job.state = 'done';
    job.phase = 'Installed';
    job.pct = 100;
    job.received = job.total;
    job.speedBps = 0;
    job.destPath = placed;
    job.filePath = job.filePath || null; // set above only for single-file items
    job.launch = launchFor(job.filePath || placed, job.title);
    job.log('info', `Installed to ${placed}`);
    emit({ job });
  } catch (err) {
    const cancelled = job.cancelled || /cancel/i.test(err.message || '');
    job.state = cancelled ? 'cancelled' : 'error';
    job.phase = cancelled ? 'Cancelled' : 'Failed';
    job.error = cancelled ? null : err.message;
    job.speedBps = 0;
    job.transfer = null;
    if (!cancelled) job.log('error', err.message);
    emit({ job });
  } finally {
    // Keep the record briefly so a late renderer fetch sees the outcome, then
    // drop it. The renderer keeps its own history.
    setTimeout(() => {
      const current = JOBS.get(job.id);
      if (current === job) JOBS.delete(job.id);
    }, 15000);
  }
}

module.exports = installs;
module.exports.view = view;
module.exports.looksLikeHtml = looksLikeHtml;
module.exports.sourceList = sourceList;
module.exports.normalizeArchivePath = normalizeArchivePath;
