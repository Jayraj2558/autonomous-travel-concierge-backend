import { config } from '../config/index.js';

/** Deterministic pseudo random generator so demo data is stable per seed. */
export function createRng(seed = 42) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export const rng = createRng(20260924);

export const pick = (list, random = rng) => list[Math.floor(random() * list.length)];

export const between = (min, max, random = rng) => min + Math.floor(random() * (max - min + 1));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * External travel services are never instant. Every mock provider awaits this
 * so the demo shows genuine in-flight states instead of teleporting results.
 */
export async function simulatedLatency(multiplier = 1) {
  const { latencyMinMs, latencyMaxMs } = config.mocks;
  const span = Math.max(0, latencyMaxMs - latencyMinMs);
  const ms = (latencyMinMs + Math.random() * span) * multiplier;
  await sleep(Math.round(ms));
  return Math.round(ms);
}

export function shouldSimulateTransientFailure() {
  return Math.random() < config.mocks.transientFailureRate;
}

const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePnr() {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += PNR_ALPHABET[Math.floor(Math.random() * PNR_ALPHABET.length)];
  return out;
}

export function generateTicketNumber(airlineCode = 'TG') {
  return `${airlineCode}-${Math.floor(1000000000 + Math.random() * 8999999999)}`;
}

export function generateConfirmationCode(prefix = 'HTL') {
  return `${prefix}-${Math.floor(100000 + Math.random() * 899999)}`;
}

export function id(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
