'use strict';

/**
 * Download queue hook (main process).
 * ---------------------------------------------------------------------------
 * `installs.js` runs one install to completion the moment it is asked to. That
 * is the right shape for a single click, and the wrong shape for a launcher
 * that lets a user line up six things and walk away: without admission control
 * the sixth transfer fights the first five for sockets and disk.
 *
 * This module is that missing layer. It sits *in front of* the engine and:
 *
 *   - accepts entries from anywhere that has a resolved `{ id, ... }` target
 *     (the store, a metadata provider, a manifest, a pasted URL);
 *   - admits at most `concurrency` jobs at a time, in order, and starts the
 *     next one the instant a slot frees;
 *   - never validates anything itself - it hands the target to the caller's
 *     `start`, which is `installs.start`. That is the function that runs
 *     net/sources.js' host policy, so a blocked host is refused at admission
 *     and is reported back through this queue as `refused` rather than merely
 *     dropped;
 *   - tracks lifecycle by consuming the engine's existing `dl:event` stream,
 *     so progress/state keep flowing to the renderer from one place.
 *
 * Nothing here knows what SteamRip is, and it has no way to queue one: every
 * entry goes through `installs.start` -> `SourceRegistry.validate`, whose
 * default blocked-hosts list refuses warez mirrors unconditionally.
 */

const { EventEmitter } = require('events');

/** States the engine reports while a job still owns a slot. */
const ACTIVE_STATES = new Set([
  'resolving', 'queued', 'downloading', 'paused', 'verifying', 'extracting', 'installing'
]);

/** States that mean the slot is free again. */
const TERMINAL_STATES = new Set(['done', 'cancelled', 'error']);

const HISTORY_LIMIT = 100;

const clampInt = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

class DownloadQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(target:object, ctx:object)=>Promise<{ok:boolean,job?:object,error?:string,alreadyRunning?:boolean}>} opts.start
   *        Admission gate *and* the engine call. Refusals ({ok:false}) never occupy a slot.
   * @param {{pause?:(id:string)=>any,resume?:(id:string)=>any,cancel?:(id:string)=>any}} [opts.controller]
   * @param {number} [opts.concurrency]   how many jobs may run at once (default 2)
   * @param {number} [opts.maxConcurrency]
   * @param {(level:string,msg:string)=>void} [opts.onLog]
   */
  constructor(opts = {}) {
    super();
    if (typeof opts.start !== 'function') throw new Error('DownloadQueue: opts.start is required');

    this.start = opts.start;
    this.controller = opts.controller || {};
    this.maxConcurrency = clampInt(opts.maxConcurrency, 1, 8, 4);
    this.concurrency = clampInt(opts.concurrency, 1, this.maxConcurrency, 2);
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

    /** @type {{id:string,title:string,target:object,ctx:object,queuedAt:number}[]} */
    this._pending = [];
    /** @type {Map<string, object>} jobId -> entry */
    this._active = new Map();
    /** @type {object[]} newest first */
    this._history = [];
    this._pumping = false;
    this._disposed = false;
  }

  // --- public API ----------------------------------------------------------

  /**
   * Lines a target up. Resolves immediately with its position; the job itself
   * is admitted later, through `start`, when a slot frees.
   * @param {{id:string,title?:string}} target
   * @param {object} [ctx]
   */
  enqueue(target, ctx = {}) {
    if (this._disposed) return { ok: false, error: 'The download queue is shutting down' };

    const id = String((target && target.id) || '').trim();
    if (!id) return { ok: false, error: 'A queue entry needs an id' };
    if (this._active.has(id)) return { ok: false, error: `"${id}" is already downloading`, id };
    if (this._pending.some((e) => e.id === id)) return { ok: false, error: `"${id}" is already queued`, id };

    const entry = {
      id,
      title: String((target && target.title) || id),
      target,
      ctx,
      queuedAt: Date.now()
    };
    this._pending.push(entry);
    this.onLog('info', `Queued "${entry.title}" (${this._pending.length} waiting, ${this._active.size} running)`);

    const position = this._pending.length;
    this._emit({ id, state: 'queued', position });
    void this._pump();
    return { ok: true, id, position, queued: true };
  }

  /** Everything the renderer needs to draw the queue panel. */
  list() {
    return {
      concurrency: this.concurrency,
      maxConcurrency: this.maxConcurrency,
      pending: this._pending.map((e) => ({ id: e.id, title: e.title, queuedAt: e.queuedAt })),
      active: [...this._active.values()].map((e) => ({
        id: e.id,
        title: e.title,
        queuedAt: e.queuedAt,
        startedAt: e.startedAt,
        alreadyRunning: !!e.alreadyRunning
      })),
      history: this._history.slice()
    };
  }

  pause(id) {
    const key = String(id || '');
    if (this._pending.some((e) => e.id === key)) {
      return { ok: false, error: 'That entry has not started yet' };
    }
    if (!this._active.has(key)) return { ok: false, error: 'unknown job' };
    if (typeof this.controller.pause !== 'function') return { ok: false, error: 'pausing is unavailable' };
    return this.controller.pause(key);
  }

  resume(id) {
    const key = String(id || '');
    if (!this._active.has(key)) return { ok: false, error: 'unknown job' };
    if (typeof this.controller.resume !== 'function') return { ok: false, error: 'resuming is unavailable' };
    return this.controller.resume(key);
  }

  /** Cancels a running job, or drops a still-pending entry. */
  cancel(id) {
    const key = String(id || '');

    const idx = this._pending.findIndex((e) => e.id === key);
    if (idx >= 0) {
      const [entry] = this._pending.splice(idx, 1);
      // Flagged so `_pump` drops the job if its admission was already in flight.
      entry.cancelled = true;
      this._settle(entry, { state: 'cancelled', error: null });
      return { ok: true, cancelled: true };
    }

    if (!this._active.has(key)) return { ok: false, error: 'unknown job' };
    if (typeof this.controller.cancel !== 'function') return { ok: false, error: 'cancelling is unavailable' };
    return this.controller.cancel(key);
  }

  /** Drops every waiting entry. Running jobs are left alone unless asked. */
  clear({ includeActive = false } = {}) {
    const waiting = this._pending.splice(0, this._pending.length);
    for (const entry of waiting) {
      entry.cancelled = true;
      this._settle(entry, { state: 'cancelled', error: null });
    }

    if (includeActive) {
      for (const id of [...this._active.keys()]) this.cancel(id);
    }
    this._emit({ id: null, state: 'cleared', removed: waiting.length });
    return { ok: true, removed: waiting.length };
  }

  setConcurrency(n) {
    this.concurrency = clampInt(n, 1, this.maxConcurrency, this.concurrency);
    this.onLog('info', `Queue concurrency set to ${this.concurrency}`);
    this._emit({ id: null, state: 'concurrency' });
    void this._pump();
    return { ok: true, concurrency: this.concurrency };
  }

  get depth() {
    return { pending: this._pending.length, active: this._active.size };
  }

  /**
   * Consumes the engine's own event stream (wired to `installs.init`'s `send`
   * in main.js). A job that reaches a terminal state frees its slot and lets
   * the next entry through.
   * @param {{type?:string,id?:string,state?:string,error?:string}} evt
   */
  onJobEvent(evt) {
    if (!evt || evt.type !== 'job') return;
    const id = String(evt.id || '');
    const entry = this._active.get(id);
    if (!entry) return;
    if (evt.state === 'paused' || ACTIVE_STATES.has(evt.state)) return;
    if (!TERMINAL_STATES.has(evt.state)) return;

    this._active.delete(id);
    this._settle(entry, { state: evt.state, error: evt.error || null });
    void this._pump();
  }

  /** Stops admitting new work; running transfers are left to finish. */
  dispose() {
    this._disposed = true;
    this.clear();
    this.removeAllListeners('event');
  }

  // --- scheduling ----------------------------------------------------------

  async _pump() {
    if (this._pumping || this._disposed) return;
    this._pumping = true;
    try {
      for (;;) {
        if (this._disposed) return;
        if (!this._pending.length || this._active.size >= this.concurrency) return;

        // Only one admission runs at a time, and the entry stays *in* the
        // waiting list while its admission is in flight. `enqueue` reads that
        // list for its duplicate check, so an id can never be queued twice in
        // the gap between leaving the queue and occupying a slot.
        const entry = this._pending.find((e) => !e.admitting);
        if (!entry) return;
        entry.admitting = true;

        // eslint-disable-next-line no-await-in-loop
        const res = await this._admit(entry);

        const idx = this._pending.indexOf(entry);
        if (idx >= 0) this._pending.splice(idx, 1);

        // Cancelled (or cleared) while it was being admitted: the engine may
        // already have a job on the wire, so that one gets cancelled too.
        if (entry.cancelled) {
          if (res.ok) this._cancelStarted(res, entry);
          continue;
        }

        if (!res.ok) {
          this._settle(entry, { state: 'refused', error: res.error || 'Refused at admission' });
          continue; // the refusal cost no slot: try the next entry immediately
        }

        const jobId = String((res.job && res.job.id) || entry.id);
        this._active.set(jobId, { ...entry, id: jobId, startedAt: Date.now(), alreadyRunning: !!res.alreadyRunning });
        this.onLog('info', `Started "${entry.title}" (${this._active.size}/${this.concurrency} running)`);
        this._emit({ id: jobId, state: 'started', alreadyRunning: !!res.alreadyRunning });

        // `installs.start` fires and forgets, so it resolves before the transfer
        // is finished - if a job is already gone by the time we look (an
        // instant failure), don't let it hold a slot forever.
        setImmediate(() => this._reconcile());
      }
    } finally {
      this._pumping = false;
    }
  }

  /** Best-effort cancel of a job that was admitted after its entry was dropped. */
  _cancelStarted(res, entry) {
    const jobId = String((res.job && res.job.id) || entry.id);
    try {
      if (typeof this.controller.cancel === 'function') this.controller.cancel(jobId);
    } catch {
      /* best effort */
    }
    this.onLog('warn', `"${entry.title}" was cancelled while starting`);
  }

  /** @returns {Promise<{ok:boolean, job?:object, error?:string, alreadyRunning?:boolean}>} */
  async _admit(entry) {
    try {
      const res = await this.start(entry.target, entry.ctx);
      if (!res) return { ok: false, error: 'The download engine returned nothing' };
      if (res.ok !== true) return { ok: false, error: res.error || 'Refused by the download engine' };
      return res;
    } catch (err) {
      this.onLog('error', `Could not start "${entry.title}": ${err.message}`);
      return { ok: false, error: err.message || 'Failed to start' };
    }
  }

  /** Placeholder for a caller-supplied staleness check; safe when absent. */
  _reconcile() {
    if (typeof this.reconcile === 'function') {
      try { this.reconcile(); } catch { /* never let a check break the queue */ }
    }
  }

  _settle(entry, { state, error }) {
    const rec = {
      id: entry.id,
      title: entry.title,
      state,
      error: error || null,
      queuedAt: entry.queuedAt,
      finishedAt: Date.now()
    };
    this._history.unshift(rec);
    if (this._history.length > HISTORY_LIMIT) this._history.length = HISTORY_LIMIT;
    if (state !== 'queued') {
      this.onLog(state === 'refused' ? 'warn' : 'info', `${entry.title}: ${state}${rec.error ? ` (${rec.error})` : ''}`);
    }
    this._emit({ id: entry.id, state, error: rec.error });
  }

  _emit(patch) {
    try {
      this.emit('event', {
        type: 'queue',
        ...patch,
        pending: this._pending.length,
        active: this._active.size,
        concurrency: this.concurrency
      });
    } catch {
      /* a listener must never break the scheduler */
    }
  }
}

module.exports = { DownloadQueue, ACTIVE_STATES, TERMINAL_STATES };
