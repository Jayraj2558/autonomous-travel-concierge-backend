import { simulatedLatency, shouldSimulateTransientFailure } from './random.js';
import { store } from '../domain/store.js';
import { logger } from './logger.js';

/**
 * Wraps an outbound call to a (mock) external provider so that every provider
 * behaves the same way: real latency, occasional transient failure with one
 * retry, and metrics the Admin page can report on.
 */
export async function providerCall(name, fn, options = {}) {
  const { multiplier = 1, retries = 1, silent = false } = options;
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    attempt += 1;
    const startedAt = Date.now();
    try {
      const latencyMs = await simulatedLatency(multiplier);
      if (shouldSimulateTransientFailure() && attempt <= retries) {
        store.trackProvider({ name, ok: false, latencyMs });
        if (!silent) logger.warn(`${name} returned 503 — retrying once`);
        lastError = Object.assign(new Error(`${name} temporarily unavailable (503)`), {
          code: 'PROVIDER_TRANSIENT',
          provider: name,
        });
        continue;
      }
      const result = await fn({ attempt });
      const elapsed = Date.now() - startedAt;
      store.trackProvider({ name, ok: true, latencyMs: elapsed });
      return { data: result, meta: { provider: name, latencyMs: elapsed, attempts: attempt } };
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      store.trackProvider({ name, ok: false, latencyMs: elapsed });
      lastError = error;
      if (attempt > retries) break;
      if (!silent) logger.warn(`${name} failed (${error.message}) — retrying once`);
    }
  }

  throw lastError || new Error(`${name} unavailable`);
}

/** Deterministic per-scenario response cache so repeated calls stay coherent. */
export function memoise(ttlMs = 15000) {
  const cache = new Map();
  return (key, producer) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    return Promise.resolve(producer()).then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    });
  };
}
