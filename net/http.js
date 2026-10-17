'use strict';

/**
 * Minimal, dependency-free HTTP(S) helper for the Apex download engine.
 *
 * Why not fetch/undici: the launcher ships as an Electron asar with no network
 * dependencies, and we need raw control over sockets (byte ranges, stream
 * back-pressure, hard cancellation). The core `http`/`https` modules give us
 * all of that with zero supply-chain surface.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Thrown when an operation is cancelled by the user. */
class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
    this.aborted = true;
  }
}

/**
 * Opens a request and resolves once response headers are available.
 * Redirects are followed transparently. The caller owns the response stream.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]  socket-inactivity timeout
 * @param {number} [opts.maxRedirects]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ res: import('http').IncomingMessage, url: string }>}
 */
function open(rawUrl, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    timeoutMs = 30000,
    maxRedirects = 5,
    signal = null
  } = opts;

  return new Promise((resolve, reject) => {
    let current = rawUrl;
    let hops = 0;

    const follow = () => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch {
        reject(new Error(`Invalid URL: ${current}`));
        return;
      }

      const mod = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!mod) {
        reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
        return;
      }

      const req = mod.request(
        parsed,
        { method, headers: (() => {
          const merged = { 'user-agent': USER_AGENT, accept: '*/*' };
          for (const [k, v] of Object.entries(headers || {})) {
            if (v != null) merged[String(k).toLowerCase()] = String(v);
          }
          return merged;
        })() },
        (res) => {
          const code = res.statusCode || 0;
          const location = res.headers.location;

          if (code >= 300 && code < 400 && location) {
            res.resume(); // drain so the socket is released
            if (++hops > maxRedirects) {
              reject(new Error(`Too many redirects (>${maxRedirects})`));
              return;
            }
            current = new URL(location, parsed).toString();
            follow();
            return;
          }

          resolve({ res, url: current });
        }
      );

      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
      req.on('error', (err) => reject(err));

      if (signal) {
        if (signal.aborted) {
          req.destroy(new AbortError());
          return;
        }
        const onAbort = () => req.destroy(new AbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      req.end();
    };

    follow();
  });
}

/** Builds a filename hint from Content-Disposition, falling back to the URL path. */
function filenameFrom(headers, url) {
  const cd = headers['content-disposition'];
  if (cd) {
    const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
      } catch {
        /* fall through */
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    if (plain) return plain[1].trim();
  }

  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (base) return base;
  } catch {
    /* ignore */
  }
  return 'download.bin';
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Discovers size, range support and a filename for a remote resource.
 * Tries HEAD first, then a one-byte ranged GET for servers that reject HEAD
 * or omit Content-Length on HEAD.
 *
 * @returns {Promise<{url:string,size:number,acceptRanges:boolean,filename:string,
 *                    etag:string|null,lastModified:string|null,contentType:string|null}>}
 */
async function probe(rawUrl, opts = {}) {
  let headError = null;

  try {
    const { res, url } = await open(rawUrl, { ...opts, method: 'HEAD' });
    const size = toInt(res.headers['content-length']);
    res.resume();
    if (size > 0) {
      return {
        url,
        size,
        acceptRanges: /bytes/i.test(String(res.headers['accept-ranges'] || '')),
        filename: filenameFrom(res.headers, url),
        etag: res.headers.etag || null,
        lastModified: res.headers['last-modified'] || null,
        contentType: res.headers['content-type'] || null
      };
    }
  } catch (err) {
    headError = err;
  }

  try {
    const { res, url } = await open(rawUrl, {
      ...opts,
      headers: { ...(opts.headers || {}), range: 'bytes=0-0' }
    });

    const range = String(res.headers['content-range'] || '');
    const total = /\/\s*(\d+)\s*$/.exec(range);
    const size = total ? toInt(total[1]) : toInt(res.headers['content-length']);
    res.resume();

    return {
      url,
      size,
      acceptRanges: res.statusCode === 206 || /bytes/i.test(String(res.headers['accept-ranges'] || '')),
      filename: filenameFrom(res.headers, url),
      etag: res.headers.etag || null,
      lastModified: res.headers['last-modified'] || null,
      contentType: res.headers['content-type'] || null
    };
  } catch (err) {
    throw headError || err;
  }
}

module.exports = { open, probe, filenameFrom, AbortError, USER_AGENT };
