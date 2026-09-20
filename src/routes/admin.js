import { Router } from 'express';
import { store } from '../domain/store.js';
import { computeMetrics } from '../services/metrics.js';
import { databaseStatus, db } from '../db/client.js';
import { aiStatus } from '../services/ai.js';
import { asyncHandler, ok } from '../utils/http.js';
import { clock } from '../utils/time.js';
import { config } from '../config/index.js';

export const adminRouter = Router();

/** GET /api/admin/metrics — the operations numbers behind the admin board. */
adminRouter.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    const metrics = computeMetrics(store.snapshot());
    return ok(res, metrics, {
      generatedAt: metrics.generatedAt,
      clock: clock.describe(),
      ai: aiStatus(),
      persistence: databaseStatus(),
    });
  }),
);

/** GET /api/admin/providers — latency and failure behaviour per external service. */
adminRouter.get(
  '/providers',
  asyncHandler(async (req, res) => {
    const providers = store.providerStats().map((entry) => ({
      name: entry.name,
      calls: entry.calls,
      failures: entry.failures,
      errorRate: entry.calls ? Number((entry.failures / entry.calls).toFixed(3)) : null,
      avgLatencyMs: entry.latencyMs.length
        ? Math.round(entry.latencyMs.reduce((sum, value) => sum + value, 0) / entry.latencyMs.length)
        : null,
      lastCallAt: entry.lastCallAt,
    }));
    return ok(res, providers, { count: providers.length, simulatedLatency: config.mocks });
  }),
);

/** GET /api/admin/health — deep health for the ops dashboard. */
adminRouter.get(
  '/health',
  asyncHandler(async (req, res) => {
    const state = store.snapshot();
    const database = databaseStatus();
    return ok(
      res,
      {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        node: process.version,
        env: config.env,
        clock: clock.describe(),
        counts: {
          travelers: Object.keys(state.travelers).length,
          trips: Object.keys(state.trips).length,
          disruptions: state.disruptions.length,
          workflows: Object.keys(state.workflows).length,
          bookings: state.bookings.length,
          notifications: state.notifications.length,
          events: state.events.length,
          cases: state.manualCases.length,
        },
        database,
        ai: aiStatus(),
        checkedAt: new Date().toISOString(),
      },
      { route: 'GET /api/admin/health' },
    );
  }),
);

/** GET /api/admin/events — raw audit trail with optional filters. */
adminRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const { type, level, tripId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 80, 400);
    let events = store.listEvents(tripId, 400);
    if (type) events = events.filter((event) => event.type === type);
    if (level) events = events.filter((event) => event.level === level);
    return ok(res, events.slice(0, limit), { count: events.length, limit });
  }),
);

/** POST /api/admin/seed — writes the current working set to PostgreSQL when configured. */
adminRouter.post(
  '/seed',
  asyncHandler(async (req, res) => {
    const state = store.snapshot();
    const trip = store.activeTrip();
    const results = await Promise.all([
      db.upsert('trips', { id: trip.id, payload: trip }),
      ...state.bookings.map((booking) => db.upsert('bookings', { id: booking.id || booking.reference, payload: booking })),
      ...state.manualCases.map((entry) => db.upsert('manual_cases', { id: entry.id, payload: entry })),
    ]);
    return ok(res, { written: results.filter(Boolean).length }, { persistence: databaseStatus() });
  }),
);
