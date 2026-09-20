import { Router } from 'express';
import { tripsRouter } from './trips.js';
import { flightsRouter } from './flights.js';
import { casesRouter, disruptionsRouter } from './disruptions.js';
import { bookingsRouter, policiesRouter, recoveryRouter } from './bookings.js';
import { hotelsRouter } from './hotels.js';
import { notificationsRouter } from './notifications.js';
import { preferencesRouter } from './preferences.js';
import { demoRouter } from './demo.js';
import { adminRouter } from './admin.js';
import { buildSeedEvents, DEMO_POLICY, DEMO_TRAVELER, TRAVEL_DATE } from '../domain/seed.js';
import { SCENARIOS } from '../domain/scenarios.js';
import { AIRPORTS } from '../domain/airports.js';
import { AIRLINES } from '../domain/airlines.js';
import { store } from '../domain/store.js';
import { computeMetrics } from '../services/metrics.js';
import { resolveConstraints } from '../engine/policyEngine.js';
import { aiStatus } from '../services/ai.js';
import { databaseStatus } from '../db/client.js';
import { ok } from '../utils/http.js';
import { clock } from '../utils/time.js';
import { config } from '../config/index.js';

export const apiRouter = Router();

/**
 * GET /api/health — liveness for probes and the client's connection chip.
 */
apiRouter.get('/health', (req, res) =>
  ok(
    res,
    {
      status: 'ok',
      service: 'travelguard-api',
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      clock: clock.describe(),
      version: '1.0.0',
    },
    { route: 'GET /api/health' },
  ),
);

/** GET /api/reference — static domain data the UI renders (airports, airlines, policies, scenarios). */
apiRouter.get('/reference', (req, res) =>
  ok(
    res,
    {
      airports: Object.values(AIRPORTS),
      airlines: Object.values(AIRLINES),
      policies: Object.values(store.snapshot().policies),
      scenarios: SCENARIOS,
      travelDate: TRAVEL_DATE,
      currency: config.currency,
      cabinClasses: [
        { code: 'ECONOMY', label: 'Economy' },
        { code: 'PREMIUM_ECONOMY', label: 'Premium economy' },
        { code: 'BUSINESS', label: 'Business' },
      ],
    },
    { generatedAt: clock.now().toISOString() },
  ),
);

/**
 * GET /api/bootstrap — everything the client needs for a cold start in one
 * round trip, so the first paint never depends on a request waterfall.
 */
apiRouter.get('/bootstrap', async (req, res) => {
  const state = store.snapshot();
  const trip = store.activeTrip();
  const traveler = trip ? store.getTraveler(trip.travelerId) : DEMO_TRAVELER;
  const preferences = store.getPreferences(traveler.id);
  const policy = store.getPolicy(trip.policyId);
  const workflow = store.getWorkflow(trip.id);
  const events = store.listEvents(trip.id, 60);

  return ok(
    res,
    {
      traveler,
      trip,
      preferences,
      policy,
      constraints: resolveConstraints({ policy, preferences, trip }),
      notifications: store.listNotifications(trip.id).sort((a, b) => new Date(b.at) - new Date(a.at)),
      events: events.length ? events : buildSeedEvents(),
      workflow,
      disruptions: state.disruptions.filter((entry) => entry.tripId === trip.id),
      bookings: store.listBookings(trip.id),
      hotelUpdates: store.listHotelUpdates(trip.id),
      cases: state.manualCases,
      scenarios: SCENARIOS,
      demo: state.demo,
      clock: clock.describe(),
    },
    {
      serverTime: new Date().toISOString(),
      travelDate: TRAVEL_DATE,
      policyName: `${policy.name} v${policy.version}`,
      workflowStages: workflow ? workflow.stages.length : 8,
    },
  );
});

/** GET /api/metrics — public-facing summary of the same numbers the admin board uses. */
apiRouter.get('/metrics', (req, res) => ok(res, computeMetrics(store.snapshot()), { summary: true, persistence: databaseStatus(), ai: aiStatus() }));

apiRouter.use('/trips', tripsRouter);
apiRouter.use('/flights', flightsRouter);
apiRouter.use('/disruptions', disruptionsRouter);
apiRouter.use('/bookings', bookingsRouter);
apiRouter.use('/hotels', hotelsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/preferences', preferencesRouter);
apiRouter.use('/policies', policiesRouter);
apiRouter.use('/recovery', recoveryRouter);
apiRouter.use('/cases', casesRouter);
apiRouter.use('/demo', demoRouter);
apiRouter.use('/admin', adminRouter);
