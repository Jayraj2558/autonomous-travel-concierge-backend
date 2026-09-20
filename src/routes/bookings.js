import { Router } from 'express';
import { store } from '../domain/store.js';
import { approveOption, executeRecovery, getWorkflow } from '../engine/workflow.js';
import { asyncHandler, badRequest, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock } from '../utils/time.js';

export const bookingsRouter = Router();
export const recoveryRouter = Router();
export const policiesRouter = Router();

const rebookSchema = {
  tripId: { type: 'string' },
  optionId: { type: 'string' },
  approvedBy: { type: 'string', default: 'TravelGuard AI (autonomous)' },
};

/**
 * POST /api/bookings/rebook
 * Books a specific option. Called automatically inside the pipeline, and
 * directly by the UI when a traveler approves a held option.
 */
bookingsRouter.post(
  '/rebook',
  asyncHandler(async (req, res) => {
    const payload = validate(req.body, rebookSchema, 'rebooking request');
    const trip = store.getTrip(payload.tripId) || store.activeTrip();
    if (!trip) throw notFound('No trip available to rebook');

    const workflow = getWorkflow(trip.id);
    if (!workflow) throw badRequest('No recovery is in progress for this trip');

    const option =
      (payload.optionId && workflow.search?.options.find((entry) => entry.id === payload.optionId)) ||
      workflow.search?.decision.selected;

    if (!option) throw badRequest('No bookable option was supplied or available');

    if (workflow.status === 'AWAITING_APPROVAL') {
      const result = await approveOption({ tripId: trip.id, optionId: option.id, approvedBy: payload.approvedBy });
      return ok(res, result, { resumed: true });
    }

    const result = await executeRecovery({
      trip,
      workflow,
      option,
      scenarioId: workflow.scenarioId,
      constraints: workflow.constraints,
      approval: payload.approvedBy,
    });
    return ok(res, result, { resumed: false });
  }),
);

/** GET /api/bookings — every ticket issued on this journey, newest first. */
bookingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.query.tripId) || store.activeTrip();
    const bookings = store.listBookings(trip?.id);
    return ok(res, bookings, {
      count: bookings.length,
      totalAdditionalFare: bookings.reduce((sum, booking) => sum + (booking.totalFareDifference || 0), 0),
    });
  }),
);

/** GET /api/bookings/:pnr — the confirmation payload the traveler receives. */
bookingsRouter.get(
  '/:pnr',
  asyncHandler(async (req, res) => {
    const pnr = req.params.pnr.toUpperCase();
    const booking = store.snapshot().bookings.find((entry) => entry.pnr === pnr || entry.reference === pnr);
    if (!booking) throw notFound(`No booking found for ${pnr}`);
    const trip = store.getTrip(booking.tripId);
    const workflow = store.getWorkflow(booking.tripId);
    return ok(res, booking, {
      tripCode: trip?.code || null,
      hotelArrival: trip?.hotel?.checkIn.current || null,
      recoverySummary: workflow?.summary || null,
    });
  }),
);

/* ----------------------------------------------------------------- recovery router */

/**
 * GET /api/recovery/:tripId
 * The whole recovery state in one call: stages, disruption file, alternatives,
 * decision narrative, booking and hotel revision. This is what the Disruption
 * Center hydrates from before the socket takes over.
 */
recoveryRouter.get(
  '/:tripId',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    const workflow = getWorkflow(trip.id);
    const preferences = store.getPreferences(trip.travelerId);
    const policy = store.getPolicy(trip.policyId);
    return ok(
      res,
      { trip, workflow, preferences, policy },
      {
        hasRecovery: Boolean(workflow),
        stageCount: workflow?.stages.length || 0,
        clock: clock.now().toISOString(),
      },
    );
  }),
);

/** GET /api/recovery/:tripId/timeline — compact stage timeline for progress UI. */
recoveryRouter.get(
  '/:tripId/timeline',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    const workflow = getWorkflow(trip.id);
    if (!workflow) return ok(res, [], { empty: true });

    return ok(
      res,
      workflow.stages.map((stage) => ({
        key: stage.key,
        title: stage.title,
        status: stage.status,
        summary: stage.summary,
        durationMs: stage.durationMs,
        startedAt: stage.startedAt,
        completedAt: stage.completedAt,
      })),
      {
        workflowId: workflow.id,
        status: workflow.status,
        detectionMs: workflow.metrics.detectionMs || null,
        recoveryMs: workflow.metrics.recoveryMs || null,
      },
    );
  }),
);

/* ---------------------------------------------------------------- policies router */

/** GET /api/policies — the travel policies the platform can enforce. */
policiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    return ok(res, Object.values(store.snapshot().policies), { count: Object.keys(store.snapshot().policies).length });
  }),
);

/** GET /api/policies/current — the policy in force, merged with this traveler's limits. */
policiesRouter.get(
  '/current',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    const policy = store.getPolicy(trip.policyId);
    const preferences = store.getPreferences(trip.travelerId);
    return ok(res, { policy, preferences }, { tripId: trip.id, effectiveAt: clock.now().toISOString() });
  }),
);

/**
 * POST /api/policies/evaluate
 * Deterministic evaluation for one option (or all of them). Always returns the
 * per-rule result set that the UI renders in "Why this decision?".
 */
policiesRouter.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const payload = validate(
      req.body,
      { tripId: { type: 'string' }, optionId: { type: 'string' }, reevaluate: { type: 'boolean', default: false } },
      'evaluation request',
    );
    const trip = store.getTrip(payload.tripId) || store.activeTrip();
    const workflow = getWorkflow(trip.id);
    if (!workflow?.search) throw badRequest('No alternative search is available to evaluate');

    const options = payload.optionId
      ? workflow.search.options.filter((option) => option.id === payload.optionId)
      : workflow.search.options;
    if (!options.length) throw notFound('No matching option to evaluate');

    return ok(
      res,
      {
        tripId: trip.id,
        options,
        decision: workflow.search.decision,
        narrative: workflow.narrative,
      },
      { rules: options[0].eligibility.rules.length, evaluatedAt: clock.now().toISOString() },
    );
  }),
);
