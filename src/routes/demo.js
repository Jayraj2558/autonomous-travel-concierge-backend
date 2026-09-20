import { Router } from 'express';
import { store } from '../domain/store.js';
import { DEFAULT_SCENARIO, SCENARIOS, getScenario } from '../domain/scenarios.js';
import { restoreBaseline, startScenarioRun } from '../engine/workflow.js';
import { scenarioStatusPreview } from '../mocks/flightStatusProvider.js';
import { broadcastTripState, emit } from '../services/realtime.js';
import { asyncHandler, badRequest, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock } from '../utils/time.js';

export const demoRouter = Router();

/** GET /api/demo/scenarios — the curated disruptions, with the outcome each is expected to produce. */
demoRouter.get(
  '/scenarios',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    const scenarios = SCENARIOS.map((scenario) => ({
      ...scenario,
      expectedProviderStatus: scenarioStatusPreview(scenario.id),
      route: `${trip.segments[0].from.code} → ${trip.segments[1]?.to.code || trip.destination}`,
    }));
    return ok(res, scenarios, { count: scenarios.length, defaultScenario: DEFAULT_SCENARIO });
  }),
);

/**
 * POST /api/demo/run
 * Resets the journey to its ticketed baseline, injects the scenario and lets the
 * workflow stream the eight recovery stages.
 */
demoRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const payload = validate(
      req.body,
      {
        scenarioId: { type: 'string', default: DEFAULT_SCENARIO },
        tripId: { type: 'string' },
        resetFirst: { type: 'boolean', default: true },
        triggeredBy: { type: 'string', default: 'Demo Mode' },
      },
      'demo run',
    );

    const scenario = getScenario(payload.scenarioId);
    if (!scenario) throw badRequest(`Unknown scenario '${payload.scenarioId}'`, { available: SCENARIOS.map((entry) => entry.id) });

    const trip = store.getTrip(payload.tripId) || store.activeTrip();
    if (!trip) throw notFound('No trip available for the demo');

    if (payload.resetFirst) {
      restoreBaseline(trip);
      store.saveTrip(trip);
      broadcastTripState({ trip, workflow: store.getWorkflow(trip.id) });
    }

    const workflow = await startScenarioRun({ scenarioId: scenario.id, tripId: trip.id, triggeredBy: payload.triggeredBy });
    emit('demo:started', { scenario, tripId: trip.id, workflowId: workflow.id });

    return ok(res, { accepted: true, scenario, tripId: trip.id }, {
      stages: workflow.stages.length,
      stream: ['recovery:stage', 'recovery:workflow', 'agent:event', 'notification:new'],
    });
  }),
);

/**
 * POST /api/demo/reset
 * Puts the world back exactly as a judge would expect to find it: nominal
 * itinerary, clean workflow, clock at the demo anchor.
 */
demoRouter.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    restoreBaseline(trip);

    store.state.disruptions = [];
    store.state.workflows = {};
    store.state.bookings = [];
    store.state.hotelUpdates = [];
    store.state.manualCases = [];
    store.state.demo = { runs: 0, scenario: null, startedAt: null, completedAt: null };
    store.state.events = store.state.events.slice(0, 6);
    store.state.metrics = {
      ...store.state.metrics,
      disruptionsDetected: 0,
      automaticRecoveries: 0,
      manualInterventions: 0,
      approvalsRequested: 0,
      rebookingAttempts: 0,
      rebookingSuccesses: 0,
      alternativesEvaluated: 0,
      detectionMs: [],
      recoveryMs: [],
    };
    store.saveTrip(trip);

    clock.reset();
    emit('demo:reset', { trip, clock: clock.describe() });
    broadcastTripState({ trip, workflow: null });

    store.addEvent({
      type: 'MONITORING',
      level: 'info',
      actor: 'Demo Mode',
      title: 'Simulation reset',
      detail: 'Itinerary restored to the ticketed plan and the simulation clock returned to 15:35 IST.',
      tripId: trip.id,
    });

    return ok(res, { trip, clock: clock.describe() }, { reset: true });
  }),
);

/** GET /api/demo/state — what a judge should currently see on screen. */
demoRouter.get(
  '/state',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    const workflow = store.getWorkflow(trip.id);
    return ok(
      res,
      {
        trip,
        workflow,
        demo: store.snapshot().demo,
        clock: clock.describe(),
        progress: workflow
          ? {
              completed: workflow.stages.filter((stage) => stage.status === 'DONE').length,
              total: workflow.stages.length,
              percent: Math.round((workflow.stages.filter((stage) => stage.status === 'DONE').length / workflow.stages.length) * 100),
            }
          : { completed: 0, total: 8, percent: 0 },
      },
      { serverTime: new Date().toISOString() },
    );
  }),
);
