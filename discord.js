'use strict';

/**
 * Discord Rich Presence.
 * ---------------------------------------------------------------------------
 * A small, dependency-free client for Discord's *local* IPC socket. Nothing
 * here talks to the network: the desktop Discord client owns the socket, and
 * Apex only ever hands it the one line of text that says what the user is
 * doing ("Browsing Apex Launcher", "Playing Halo", …).
 *
 * The wire format is deliberately simple — each message is an 8-byte header
 * (opcode + length, both little-endian int32) followed by a JSON body:
 *
 *   op 0 HANDSHAKE   { v: 1, client_id }
 *   op 1 FRAME       { cmd, args, nonce }
 *   op 2 CLOSE
 *   op 3 PING / op 4 PONG
 *
 * Everything degrades quietly: if Discord is not running, or the user never
 * pasted an Application ID, the launcher behaves exactly as before.
 */

const net = require('net');
const crypto = require('crypto');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const PING_MS = 15000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 30000;

/** Discord listens on discord-ipc-0 … discord-ipc-9, one per running client. */
function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
  return `${base}/discord-ipc-${i}`;
}

class DiscordRPC {
  constructor() {
    this.enabled = false;
    this.clientId = '';
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.pingTimer = null;
    this.retryTimer = null;
    this.retryMs = RETRY_MIN_MS;
    this.activity = null;     // the last activity asked for, replayed on reconnect
    this.lastError = null;
    this.closed = false;
  }

  /** Applies the Settings values. Safe to call with anything. */
  configure({ enabled, clientId } = {}) {
    const nextEnabled = !!enabled;
    const nextId = String(clientId || '').trim();
    if (nextEnabled === this.enabled && nextId === this.clientId) return this.status();

    this.enabled = nextEnabled;
    this.clientId = nextId;
    this.teardown();

    if (this.enabled && this.clientId) this.connect(0);
    else this.lastError = null;
    return this.status();
  }

  status() {
    return {
      enabled: this.enabled,
      clientId: this.clientId,
      connected: this.ready,
      error: this.lastError
    };
  }

  /** The line shown on the user's profile. `null` clears it. */
  setActivity(activity) {
    this.activity = activity || null;
    if (this.ready) this.sendActivity();
  }

  clear() {
    this.activity = null;
    if (this.ready) this.sendActivity();
  }

  // --- socket -------------------------------------------------------------
  connect(index) {
    if (this.closed || !this.enabled || !this.clientId || this.sock) return;

    if (index > 9) {
      this.lastError = 'Discord is not running (no IPC socket found).';
      this.scheduleRetry();
      return;
    }

    const sock = net.connect(pipePath(index));
    let settled = false;

    const tryNext = () => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      this.connect(index + 1);
    };

    sock.once('error', tryNext);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      sock.removeListener('error', tryNext);

      this.sock = sock;
      this.buf = Buffer.alloc(0);
      this.lastError = null;
      sock.on('data', (d) => this.onData(d));
      sock.on('error', () => this.onClose());
      sock.on('close', () => this.onClose());

      this.send({ v: 1, client_id: this.clientId }, OP_HANDSHAKE);
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (len < 0 || this.buf.length < 8 + len) break;

      const raw = this.buf.slice(8, 8 + len).toString('utf8');
      this.buf = this.buf.slice(8 + len);

      let msg = null;
      try { msg = JSON.parse(raw); } catch { /* malformed frame: skip it */ }
      this.onMessage(op, msg);
    }
  }

  onMessage(op, msg) {
    if (op === OP_PING || op === OP_PONG || !msg) return;

    // READY is Discord's "handshake accepted" — only now may we set activity.
    if (msg.evt === 'READY') {
      this.ready = true;
      this.retryMs = RETRY_MIN_MS;
      this.sendActivity();
      this.startPing();
      return;
    }

    if (msg.evt === 'ERROR') {
      this.lastError = (msg.data && msg.data.message) || 'Discord rejected the presence.';
    }
  }

  onClose() {
    this.stopPing();
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.ready = false;
    if (this.enabled) this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.retryTimer || this.closed || !this.enabled) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryMs = Math.min(Math.round(this.retryMs * 1.5), RETRY_MAX_MS);
      this.connect(0);
    }, this.retryMs);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  send(payload, op = OP_FRAME) {
    if (!this.sock) return false;
    try {
      const data = Buffer.from(JSON.stringify(payload), 'utf8');
      const head = Buffer.alloc(8);
      head.writeInt32LE(op, 0);
      head.writeInt32LE(data.length, 4);
      this.sock.write(Buffer.concat([head, data]));
      return true;
    } catch {
      return false;
    }
  }

  sendActivity() {
    if (!this.ready) return;
    this.send({
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.activity || null },
      nonce: crypto.randomUUID()
    });
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ready) return;
      this.send({}, OP_PING);
    }, PING_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /** Drops the socket but keeps the configuration (used before a reconnect). */
  teardown() {
    this.stopPing();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryMs = RETRY_MIN_MS;
    if (this.sock) {
      try { this.send({}, OP_CLOSE); } catch { /* ignore */ }
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.ready = false;
    this.buf = Buffer.alloc(0);
  }

  /** Final shutdown, called as the app quits. */
  destroy() {
    this.closed = true;
    this.clear();
    this.enabled = false;
    this.teardown();
  }
}

module.exports = new DiscordRPC();
