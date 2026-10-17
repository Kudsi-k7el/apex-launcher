'use strict';

/**
 * Provider registry.
 * ---------------------------------------------------------------------------
 * A *provider* is the only thing in Apex allowed to know where content lives.
 * The download engine (net/download.js) knows how to move bytes; nets/sources.js
 * knows which hosts are allowed; a provider knows what a title *is*.
 *
 * The contract is deliberately tiny, and every field is required:
 *
 *   {
 *     id:      'steam',                 // stable key, used in state and IPC
 *     label:   'Steam',                 // what a human sees
 *     trust:   'official' | 'user',     // official APIs vs. user-configured
 *     metadataOnly: true,               // true => search/details, no files
 *     search?(term, opts)  -> { ok, items[], error? }
 *     details?(appId, opts)-> { ok, ...record, error? }
 *     logos?(appId)        -> string[]  // transparent wordmark candidates
 *     deliver?(target, ctx)-> { ok:true, item:{url,sha256,...} } | { ok:false, reason }
 *   }
 *
 * `deliver()` is what feeds the download queue. A provider that cannot hand
 * back a `{ url, sha256 }` item simply does not implement it (or returns
 * `ok:false`), and nothing is ever queued on its behalf. Whatever a provider
 * does return still has to clear the host policy in net/sources.js before a
 * single byte moves - the queue calls `SourceRegistry.validate` itself, so a
 * provider cannot smuggle a blocked host into the engine by calling it
 * "official".
 */

const registry = new Map();

const REQUIRED = ['id', 'label', 'trust'];

/**
 * @param {object} provider
 * @returns {object} the registered provider
 */
function register(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('register: provider must be an object');

  for (const key of REQUIRED) {
    if (!provider[key] || typeof provider[key] !== 'string') {
      throw new Error(`register: provider is missing a string "${key}"`);
    }
  }
  if (provider.search !== undefined && typeof provider.search !== 'function') {
    throw new Error(`register: "${provider.id}".search must be a function`);
  }
  if (provider.deliver !== undefined && typeof provider.deliver !== 'function') {
    throw new Error(`register: "${provider.id}".deliver must be a function`);
  }

  registry.set(provider.id, provider);
  return provider;
}

const get = (id) => registry.get(String(id || '')) || null;
const all = () => [...registry.values()];
const ids = () => [...registry.keys()];

/** Shape-only description, safe to hand to the renderer. */
function describe() {
  return all().map((p) => ({
    id: p.id,
    label: p.label,
    trust: p.trust,
    metadataOnly: p.metadataOnly !== false,
    canDeliverFiles: typeof p.deliver === 'function' && p.metadataOnly === false
  }));
}

/** A provider that declines (or lacks) `deliver` cannot queue anything. */
async function deliver(providerId, target, ctx) {
  const provider = get(providerId);
  if (!provider) return { ok: false, reason: `Unknown provider "${providerId}"` };
  if (typeof provider.deliver !== 'function') {
    return { ok: false, reason: `${provider.label} is a metadata-only provider and cannot supply files.` };
  }
  try {
    const out = await provider.deliver(target, ctx);
    if (!out || out.ok !== true || !out.item || !out.item.url) {
      return { ok: false, reason: (out && out.reason) || `${provider.label} could not resolve a source.` };
    }
    return { ok: true, item: out.item };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || `${provider.label} failed to resolve a source.` };
  }
}

// --- built-ins -------------------------------------------------------------
register(require('./steam'));
register(require('./fitgirl'));
// Project Lightning (Lightning Nexus) multi-provider catalog & download engine.
try { register(require('./lightning')); } catch { /* already registered */ }
// Backwards-compatible alias for older callers/tests.
try { register(require('./steamrip')); } catch { /* already registered */ }
module.exports = { register, get, all, ids, describe, deliver };
