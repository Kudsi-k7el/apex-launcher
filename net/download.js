'use strict';

/**
 * Apex download engine.
 *
 * A resumable, multi-connection HTTP(S) transfer with live progress, a
 * bandwidth cap, stall detection, bounded retries and graceful pause/resume/
 * cancel. No third-party dependencies.
 *
 * Design notes
 * ------------
 *  - Chunks are written straight into one file descriptor at their own offset,
 *    so `connections` sockets make progress against a single destination file
 *    without ever buffering the whole payload in memory.
 *  - A `.apexpart` sidecar records per-chunk byte counts (plus the ETag) so an
 *    interrupted transfer can resume after a crash or an app restart.
 *  - If a server advertises range support but then answers a ranged request
 *    with a plain 200, the engine degrades to a single connection and restarts
 *    cleanly instead of corrupting the file.
 */

const fs = require('fs');
const path = require('path');
const http = require('./http');

const DEFAULTS = {
  connections: 4,
  maxConnections: 16,
  minChunkSize: 8 * 1024 * 1024, // don't open a socket for a tiny remainder
  retries: 5,
  retryBaseMs: 500,
  stallMs: 45000, // no bytes for this long => drop and retry the chunk
  timeoutMs: 30000, // socket inactivity timeout for header phase
  progressIntervalMs: 250,
  headers: {}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Transfer {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} opts.dest           absolute destination file path
   * @param {number} [opts.connections]
   * @param {number} [opts.bandwidthBps] 0 / Infinity = uncapped
   * @param {Record<string,string>} [opts.headers]
   * @param {(p:object)=>void} [opts.onProgress]
   * @param {(level:string,msg:string)=>void} [opts.onLog]
   */
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (!o.url) throw new Error('Transfer: url is required');
    if (!o.dest) throw new Error('Transfer: dest is required');

    this.url = o.url;
    this.dest = path.resolve(o.dest);
    this.headers = o.headers || {};
    this.onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
    this.onLog = typeof o.onLog === 'function' ? o.onLog : () => {};

    this.connections = Math.min(Math.max(1, Number(o.connections) || 1), o.maxConnections);
    this.bandwidthBps = Number.isFinite(o.bandwidthBps) && o.bandwidthBps > 0 ? o.bandwidthBps : Infinity;

    this.timeoutMs = o.timeoutMs;
    this.stallMs = o.stallMs;
    this.progressIntervalMs = o.progressIntervalMs;
    this._retries = o.retries;
    this._retryBaseMs = o.retryBaseMs;
    this._minChunkSize = o.minChunkSize;

    this.size = 0;
    this.received = 0;
    this.acceptRanges = false;
    this.etag = null;
    this.lastModified = null;

    /** @type {{index:number,start:number,end:number,done:number}[]} */
    this.chunks = [];
    this._fd = null;
    this._connsActive = 1;

    this._streams = new Set();
    this._aborts = new Set();
    this._paused = false;
    this._stopped = false;
    this._started = false;
    this._finished = false;
    this._degraded = false;
    this._degradeRequested = false;

    this._waiters = [];
    this._speed = 0;
    this._lastSample = 0;
    this._lastBytes = 0;

    this._bucket = 0;
    this._bucketAt = 0;
    this._throttleUntil = 0;

    this._progressTimer = null;
    this._ticks = 0;
  }

  // --- public API ----------------------------------------------------------

  /** Runs the transfer to completion (or throws). Resolves with a summary. */
  async start() {
    if (this._started) throw new Error('Transfer already started');
    this._started = true;

    const t0 = Date.now();
    const info = await http.probe(this.url, { headers: this.headers, timeoutMs: this.timeoutMs });
    if (!info.size) throw new Error('Server did not report a file size');

    this.size = info.size;
    this.etag = info.etag;
    this.lastModified = info.lastModified;
    this.acceptRanges = !!info.acceptRanges;

    const bySize = Math.ceil(this.size / this._minChunkSize);
    this._connsActive = this.acceptRanges ? Math.max(1, Math.min(this.connections, bySize)) : 1;

    fs.mkdirSync(path.dirname(this.dest), { recursive: true });
    this._fd = fs.openSync(this.dest, fs.existsSync(this.dest) ? 'r+' : 'w+');

    this._plan(this._connsActive);
    this._loadPart();
    this._truncateToSize();

    this._lastSample = Date.now();
    this._lastBytes = this.received;
    this._startProgress();
    this.onLog('info', `Transfer start: ${this.size} bytes over ${this._connsActive} connection(s)`);

    try {
      await this._run();
    } finally {
      this._stopProgress();
      this._closeFd();
    }

    if (this._stopped) throw new http.AbortError();
    if (this.received < this.size) {
      throw new Error(`Incomplete download: ${this.received}/${this.size} bytes`);
    }

    this._clearPart();
    this._finished = true;
    this._emit();
    return { bytes: this.received, size: this.size, elapsedMs: Date.now() - t0, url: this.url };
  }

  pause() {
    if (this._paused || this._stopped || this._finished) return;
    this._paused = true;
    this._abortActive(); // in-flight chunk requests will re-gate on resume
    this._savePart();
    this._emit();
    this.onLog('info', 'Transfer paused');
  }

  resume() {
    if (!this._paused || this._stopped || this._finished) return;
    this._paused = false;
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
    this._emit();
    this.onLog('info', 'Transfer resumed');
  }

  cancel() {
    // After a successful transfer the file on disk is the finished artefact:
    // cancelling must never delete it.
    if (this._stopped || this._finished) return;
    this._stopped = true;
    this._paused = false;
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
    this._abortActive();
    this._stopProgress();
    this._closeFd();
    this._clearPart();
    try {
      fs.unlinkSync(this.dest);
    } catch {
      /* best effort */
    }
    this.onLog('info', 'Transfer cancelled');
  }

  get paused() {
    return this._paused;
  }
  get stopped() {
    return this._stopped;
  }

  // --- planning & resume state --------------------------------------------

  _plan(n) {
    const size = this.size;
    const base = Math.floor(size / n);
    this.chunks = [];
    let start = 0;
    for (let i = 0; i < n; i++) {
      const end = i === n - 1 ? size - 1 : start + base - 1;
      this.chunks.push({ index: i, start, end, done: 0, claimed: false });
      start = end + 1;
    }
  }

  _partPath() {
    return `${this.dest}.apexpart`;
  }

  _savePart() {
    if (this._finished) return;
    try {
      fs.writeFileSync(
        this._partPath(),
        JSON.stringify({
          v: 1,
          url: this.url,
          size: this.size,
          etag: this.etag,
          received: this.received,
          chunks: this.chunks.map((c) => ({ start: c.start, end: c.end, done: c.done })),
          at: Date.now()
        }),
        'utf8'
      );
    } catch (err) {
      this.onLog('warn', `Could not persist resume state: ${err.message}`);
    }
  }

  _loadPart() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._partPath(), 'utf8'));
    } catch {
      return; // fresh download
    }
    if (!raw || raw.size !== this.size) return;
    if ((raw.etag || null) !== (this.etag || null)) return; // remote file changed
    if (!Array.isArray(raw.chunks) || raw.chunks.length !== this.chunks.length) return;

    let received = 0;
    this.chunks.forEach((chunk, i) => {
      const saved = raw.chunks[i];
      const span = chunk.end - chunk.start + 1;
      if (saved && saved.start === chunk.start && saved.end === chunk.end) {
        if (Number.isInteger(saved.done) && saved.done >= 0 && saved.done <= span) {
          chunk.done = saved.done;
        }
      }
      received += chunk.done;
    });
    this.received = received;
    if (received > 0) this.onLog('info', `Resuming from ${received}/${this.size} bytes`);
  }

  _clearPart() {
    try {
      fs.unlinkSync(this._partPath());
    } catch {
      /* already gone */
    }
  }

  _truncateToSize() {
    try {
      fs.ftruncateSync(this._fd, this.size);
    } catch (err) {
      this.onLog('warn', `Could not size the destination file: ${err.message}`);
    }
  }

  _closeFd() {
    if (this._fd == null) return;
    try {
      fs.closeSync(this._fd);
    } catch {
      /* ignore */
    }
    this._fd = null;
  }

  // --- worker loop ---------------------------------------------------------

  async _run() {
    for (;;) {
      const conns = Math.max(1, this._connsActive);
      const workers = [];
      for (let i = 0; i < conns; i++) workers.push(this._worker());
      await Promise.all(workers);

      if (this._stopped) return;
      if (this._degradeRequested && !this._degraded) {
        this._degrade();
        continue;
      }
      return;
    }
  }

  _degrade() {
    this._degraded = true;
    this._degradeRequested = false;
    this.received = 0;
    this._connsActive = 1;
    this.chunks = [{ index: 0, start: 0, end: this.size - 1, done: 0, claimed: false }];
    this.onLog('warn', 'Server ignored byte ranges - restarting on a single connection');
  }

  /**
   * Hands out the next unfinished chunk and *claims* it, so two workers can
   * never open a socket for the same byte range (which would also double-count
   * progress). Single-threaded, so the flag write is atomic.
   */
  _nextChunk() {
    const chunk = this.chunks.find((c) => !c.claimed && c.start + c.done <= c.end);
    if (chunk) chunk.claimed = true;
    return chunk;
  }

  _gate() {
    if (!this._paused) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  async _worker() {
    for (;;) {
      if (this._stopped || this._degradeRequested) return;
      await this._gate();
      if (this._stopped || this._degradeRequested) return;
      const chunk = this._nextChunk();
      if (!chunk) return;
      await this._chunkWithRetry(chunk);
    }
  }

  async _chunkWithRetry(chunk) {
    let attempt = 0;
    for (;;) {
      if (this._stopped || this._degradeRequested) return;
      await this._gate();
      if (this._stopped || this._degradeRequested) return;

      const from = chunk.start + chunk.done;
      if (from > chunk.end) return; // chunk finished

      try {
        await this._streamRange(chunk, from);
        if (chunk.start + chunk.done <= chunk.end) {
          throw new Error('Connection closed before the range was complete');
        }
        this._savePart();
        return;
      } catch (err) {
        if (this._stopped || this._degradeRequested) return;
        if (err && err.aborted) {
          if (this._paused) continue; // paused mid-flight: re-gate
          return; // cancelled
        }
        if (err && err.blocked) {
          // Refused outright before any bytes: skip the retry ladder.
          const blocked = new Error(`Range ${chunk.start}-${chunk.end} blocked: ${err.message}`);
          blocked.blocked = true;
          blocked.statusCode = err.statusCode;
          throw blocked;
        }
        if (++attempt > this._retries) {
          throw new Error(`Range ${chunk.start}-${chunk.end} failed after ${attempt} attempts: ${err.message}`);
        }
        const delay = Math.min(20000, this._retryBaseMs * 2 ** (attempt - 1));
        this.onLog('warn', `Retry ${attempt}/${this._retries} for range ${chunk.start}-${chunk.end} in ${delay}ms (${err.message})`);
        await sleep(delay);
      }
    }
  }

  async _streamRange(chunk, from) {
    const ac = new AbortController();
    this._aborts.add(ac);
    try {
      const headers = { ...this.headers };
      // Always ask for the exact range when the server advertised range
      // support: an unranged request would return the whole file and be
      // written back over every other worker's region.
      if (this.acceptRanges && !this._degraded) {
        headers.range = `bytes=${from}-${chunk.end}`;
      }

      const { res } = await http.open(this.url, {
        headers,
        signal: ac.signal,
        timeoutMs: this.timeoutMs
      });

      if (res.statusCode === 200 && from > 0) {
        res.destroy();
        this._degradeRequested = true;
        throw new Error('Server ignored the byte range');
      }
      if (res.statusCode === 416) {
        // Requested past EOF: everything the server has is already on disk.
        res.destroy();
        chunk.done = chunk.end - chunk.start + 1;
        this._recompute();
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        const code = res.statusCode;
        res.destroy();
        const err = new Error(`HTTP ${code}`);
        err.statusCode = code;
        // A hard 401/403/451 before a single byte of this range arrived is a
        // policy block, not a flaky server. Flag it so the chunk loop stops
        // retrying the same wall and the coordinator can fall back to the
        // embedded browser at once.
        if (chunk.done === 0 && (code === 401 || code === 403 || code === 451)) err.blocked = true;
        throw err;
      }

      await this._pump(chunk, from, res, ac);
    } finally {
      this._aborts.delete(ac);
    }
  }

  /**
   * Streams one byte range to disk.
   *
   * Writes use an explicit file position and the source stream is paused around
   * every write, so `chunk.done` only ever advances for bytes that are actually
   * on disk. That invariant is what makes pause/resume safe: an interrupted
   * range simply re-requests from `chunk.start + chunk.done` with nothing lost
   * and nothing double-counted.
   */
  _pump(chunk, from, res, ac) {
    return new Promise((resolve, reject) => {
      let pos = from;
      let settled = false;
      let lastData = Date.now();
      let resumeTimer = null;

      const watchdog = setInterval(() => {
        if (Date.now() - lastData > this.stallMs) {
          fail(new Error(`Stalled: no data for ${Math.round(this.stallMs / 1000)}s`));
        }
      }, 5000);

      const onData = (buf) => {
        lastData = Date.now();

        // Never write past the end of this range, even if the server ignored
        // the bound of the requested range.
        const room = chunk.end + 1 - pos;
        if (room <= 0) {
          finish(null);
          res.destroy();
          return;
        }
        const n = Math.min(buf.length, room);
        const slice = n === buf.length ? buf : buf.subarray(0, n);

        res.pause(); // exactly one write in flight per connection
        fs.write(this._fd, slice, 0, n, pos, (err) => {
          if (err) return fail(err);
          pos += n;
          chunk.done += n;
          this.received += n;
          this._maybeThrottle(n);
          if (settled) return;
          if (pos > chunk.end) {
            // Range satisfied: settle before tearing the socket down so the
            // local destroy is not mistaken for a dropped connection.
            finish(null);
            res.destroy();
            return;
          }
          const wait = this._throttleUntil - Date.now();
          if (wait > 0) {
            resumeTimer = setTimeout(() => {
              if (!settled) res.resume();
            }, wait);
          } else {
            res.resume();
          }
        });
      };

      const abortErr = () => (ac.signal.aborted ? new http.AbortError() : new Error('Connection closed early'));

      const onEnd = () => finish(null);
      const onAborted = () => finish(abortErr());
      const onError = (err) => finish(err);
      const onClose = () => {
        // 'close' also fires after a clean 'end'; the settled guard ignores it.
        if (!settled) finish(ac.signal.aborted ? new http.AbortError() : null);
      };

      const cleanup = () => {
        clearInterval(watchdog);
        clearTimeout(resumeTimer);
        this._streams.delete(res);
        res.removeListener('data', onData);
        res.removeListener('end', onEnd);
        res.removeListener('aborted', onAborted);
        res.removeListener('error', onError);
        res.removeListener('close', onClose);
      };

      function finish(err) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      }
      const fail = finish;

      this._streams.add(res);
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('aborted', onAborted);
      res.on('error', onError);
      res.on('close', onClose);
    });
  }

  _recompute() {
    this.received = this.chunks.reduce((sum, c) => sum + c.done, 0);
  }

  // --- bandwidth limiting --------------------------------------------------

  /**
   * Sliding-window bandwidth cap. Bytes are metered here and, when the cap is
   * exceeded, a resume deadline is set which the pump honours after each write.
   * Nothing is paused from the outside, so a range is never written to twice.
   */
  _maybeThrottle(bytes) {
    if (!Number.isFinite(this.bandwidthBps)) return;
    const now = Date.now();
    if (!this._bucketAt || now - this._bucketAt >= 1000) {
      this._bucketAt = now;
      this._bucket = 0;
    }
    this._bucket += bytes;
    if (this._bucket >= this.bandwidthBps) {
      this._throttleUntil = Math.max(this._throttleUntil, this._bucketAt + 1000);
    }
  }

  _abortActive() {
    for (const ac of this._aborts) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
  }

  // --- progress reporting --------------------------------------------------

  _startProgress() {
    this._ticks = 0;
    this._progressTimer = setInterval(() => {
      const now = Date.now();
      const dt = (now - this._lastSample) / 1000;
      if (dt > 0) {
        const instant = (this.received - this._lastBytes) / dt;
        this._speed = this._speed > 0 ? this._speed * 0.7 + instant * 0.3 : instant;
        this._lastSample = now;
        this._lastBytes = this.received;
      }
      // Periodic checkpoint so a crash does not lose more than a few seconds.
      if (++this._ticks % 20 === 0 && !this._paused && !this._stopped) this._savePart();
      this._emit();
    }, this.progressIntervalMs);
    if (this._progressTimer.unref) this._progressTimer.unref();
  }

  _stopProgress() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = null;
  }

  _emit() {
    const total = this.size || 0;
    const received = Math.min(this.received, total || this.received);
    const speedBps = this._paused ? 0 : Math.max(0, this._speed);
    const remaining = Math.max(0, total - received);
    this.onProgress({
      received,
      total,
      pct: total ? (received / total) * 100 : 0,
      speedBps,
      etaMs: speedBps > 0 ? (remaining / speedBps) * 1000 : Infinity,
      paused: this._paused,
      connections: this._connsActive
    });
  }
}

/**
 * Convenience one-shot download.
 * @returns {Promise<{bytes:number,size:number,elapsedMs:number,url:string}>}
 */
async function downloadFile(url, dest, opts = {}) {
  const transfer = new Transfer({ ...opts, url, dest });
  if (opts.onTransfer) opts.onTransfer(transfer);
  return transfer.start();
}

module.exports = { Transfer, downloadFile, DEFAULTS };
