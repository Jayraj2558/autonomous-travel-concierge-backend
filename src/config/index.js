import 'dotenv/config';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Central runtime configuration. Every value can be overridden with an
 * environment variable so the prototype can move between machines without
 * touching code.
 */
export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  corsOrigin: (process.env.CORS_ORIGIN || '*').trim(),
  database: {
    url: process.env.DATABASE_URL || '',
    ssl: String(process.env.DATABASE_SSL || 'false') === 'true',
  },
  mocks: {
    latencyMinMs: num(process.env.MOCK_LATENCY_MIN_MS, 140),
    latencyMaxMs: num(process.env.MOCK_LATENCY_MAX_MS, 460),
    // Chance a provider call fails once before a successful retry. Demonstrates
    // resilience without ever breaking the demo path.
    transientFailureRate: num(process.env.MOCK_FAILURE_RATE, 0.06),
  },
  demo: {
    // The simulation runs "on" the day of travel so every recovery decision is
    // aviation-coherent (feasible departures, valid connection maths).
    clockStart: process.env.DEMO_CLOCK_START || '2026-09-24T15:35:00+05:30',
    monitorIntervalMs: num(process.env.MONITOR_INTERVAL_MS, 24000),
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'template',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  },
  currency: { code: 'INR', symbol: '₹' },
};

export const isProduction = config.env === 'production';
