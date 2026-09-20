import { Router } from 'express';
import { store } from '../domain/store.js';
import { SCENARIOS, getScenario } from '../domain/scenarios.js';
import { analyzeImpact } from '../engine/disruptionEngine.js';
import { resolveConstraints } from '../engine/policyEngine.js';
import { approveOption, cancelRun, escalateToDesk, getWorkflow, startScenarioRun } from '../engine/workflow.js';
import { evaluateOption } from '../engine/policyEngine.js';
import { asyncHandler, badRequest, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock } from '../utils/time.js';

export const disruptionsRouter = Router();
export const casesRouter = Router();

const simulateSchema = {
  scenarioId: { type: 'string', required: true },
  tripId: { type: 'string' },
  triggeredBy: { type: 'string', default: 'Traveler (app)' },
};

/**
 * POST /api/disruptions/simulate
 * Injects one of the Demo Mode disruptions and runs the full recovery pipeline.
 * The response is returned as soon as the disruption is *detected* — every later
 * stage streams over Socket.IO, which is what the UI listens to.
 */
disruptionsRouter.post(
  '/simulate',
  asyncHandler(async (req, res) => {
    const payload = validate(req.body, simulateSchema, 'simulation request');
    const scenario = getScenario(payload.scenarioId);
    if (!scenario) throw badRequest(`Unknown scenario '${payload.scenarioId}'`, { available: SCENARIOS.map((entry) => entry.id) });

    const trip = store.getTrip(payload.tripId) || store.activeTrip();
    if (!trip) throw notFound('No trip available to disrupt');

    const existing = store.getWorkflow(trip.id);
    if (existing && existing.status === 'RUNNING') cancelRun(trip.id);

    const workflow = await startScenarioRun({ scenarioId: scenario.id, tripId: trip.id, triggeredBy: payload.triggeredBy });

    return ok(
      res,
      {
        accepted: true,
        scenario,
        tripId: trip.id,
        trip,
        planningTime: workflow.planningTime,
        stages: workflow.stages.map((stage) => stage.key),
        workflow,
      },
      {
        mode: 'stream',
        stages: workflow.stages.length,
        clock: clock.describe(),
        hint: 'Follow recovery:stage and recovery:workflow events on the socket',
      },
    );
  }),
);

/** GET /api/disruptions — disruption files, newest first. */
disruptionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.query.tripId) || store.activeTrip();
    const disruptions = store.snapshot().disruptions.filter((entry) => !trip || entry.tripId === trip.id);
    return ok(res, disruptions, {
      count: disruptions.length,
      open: disruptions.filter((entry) => entry.status !== 'RESOLVED').length,
    });
  }),
);

/** GET /api/disruptions/:disruptionId */
disruptionsRouter.get(
  '/:disruptionId',
  asyncHandler(async (req, res) => {
    const disruption = store.getDisruption(req.params.disruptionId);
    if (!disruption) throw notFound(`No disruption ${req.params.disruptionId}`);
    const workflow = store.getWorkflow(disruption.tripId);
    return ok(res, disruption, {
      workflowId: workflow?.id || null,
      workflowStatus: workflow?.status || null,
      recoveryStages: workflow?.stages.map((stage) => ({ key: stage.key, status: stage.status })) || [],
    });
  }),
);

/**
 * GET /api/disruptions/:disruptionId/impact
 * The connection maths and downstream consequences, recalculated live so the
 * numbers on screen always match the current itinerary state.
 */
disruptionsRouter.get(
  '/:disruptionId/impact',
  asyncHandler(async (req, res) => {
    const disruption = store.getDisruption(req.params.disruptionId);
    if (!disruption) throw notFound(`No disruption ${req.params.disruptionId}`);
    const trip = store.getTrip(disruption.tripId);
    const preferences = store.getPreferences(trip.travelerId);
    const policy = store.getPolicy(trip.policyId);
    const constraints = resolveConstraints({ policy, preferences, trip });
    const impact = analyzeImpact({ trip, disruption, constraints, hotel: trip.hotel });

    const workflow = store.getWorkflow(trip.id);
    return ok(res, impact, {
      disruptionId: disruption.id,
      evaluatedAt: clock.now().toISOString(),
      alternativesConsidered: workflow?.search?.options.length || 0,
    });
  }),
);

/**
 * POST /api/disruptions/:disruptionId/approve
 * Traveler approval for an option that sits outside the automatic band.
 */
disruptionsRouter.post(
  '/:disruptionId/approve',
  asyncHandler(async (req, res) => {
    const disruption = store.getDisruption(req.params.disruptionId);
    if (!disruption) throw notFound(`No disruption ${req.params.disruptionId}`);
    const { optionId, approvedBy } = validate(
      req.body,
      { optionId: { type: 'string' }, approvedBy: { type: 'string', default: 'Traveler approval in app' } },
      'approval',
    );

    const result = await approveOption({ tripId: disruption.tripId, optionId, approvedBy });
    return ok(res, result, { approved: true, disruptionId: disruption.id });
  }),
);

/** POST /api/disruptions/:disruptionId/escalate — hand the case to a human desk. */
disruptionsRouter.post(
  '/:disruptionId/escalate',
  asyncHandler(async (req, res) => {
    const disruption = store.getDisruption(req.params.disruptionId);
    if (!disruption) throw notFound(`No disruption ${req.params.disruptionId}`);
    const { note } = validate(req.body, { note: { type: 'string' } }, 'escalation');
    const result = await escalateToDesk({ tripId: disruption.tripId, note });
    return ok(res, result, { escalated: true });
  }),
);

/**
 * GET /api/disruptions/:disruptionId/evaluate?optionId=...
 * Re-runs the policy engine for a single option — used by the "Why this
 * decision?" panel so the rules shown are the ones just executed.
 */
disruptionsRouter.get(
  '/:disruptionId/evaluate',
  asyncHandler(async (req, res) => {
    const disruption = store.getDisruption(req.params.disruptionId);
    if (!disruption) throw notFound(`No disruption ${req.params.disruptionId}`);
    const trip = store.getTrip(disruption.tripId);
    const workflow = getWorkflow(trip.id);
    if (!workflow?.search) throw badRequest('No alternative search has run for this disruption yet');

    const preferences = store.getPreferences(trip.travelerId);
    const policy = store.getPolicy(trip.policyId);
    const constraints = resolveConstraints({ policy, preferences, trip });

    const optionId = req.query.optionId;
    const options = optionId ? workflow.search.options.filter((option) => option.id === optionId) : workflow.search.options;
    if (!options.length) throw notFound(`No option ${optionId} in this search`);

    const evaluated = options.map((option) =>
      evaluateOption(option, {
        constraints,
        policy,
        preferences,
        trip,
        disruption,
        hotel: trip.hotel,
        planningTime: new Date(workflow.search.search.planningTime || clock.now().toISOString()),
      }),
    );

    return ok(
      res,
      { disruptionId: disruption.id, constraints, options: evaluated },
      { evaluatedAt: clock.now().toISOString(), policyVersion: policy.version, rulesPerOption: evaluated[0]?.eligibility.rules.length || 0 },
    );
  }),
);

/* ------------------------------------------------------------------ cases router */

/** GET /api/cases — manual intervention queue. */
casesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const cases = store.snapshot().manualCases;
    return ok(res, cases, { count: cases.length, open: cases.filter((entry) => entry.status === 'OPEN').length });
  }),
);

/** GET /api/cases/:caseId */
casesRouter.get(
  '/:caseId',
  asyncHandler(async (req, res) => {
    const found = store.snapshot().manualCases.find((entry) => entry.id === req.params.caseId);
    if (!found) throw notFound(`No case ${req.params.caseId}`);
    return ok(res, found, { slaMinutes: found.slaMinutes, priority: found.priority });
  }),
);

/** POST /api/cases/:caseId/resolve — close the loop after a human has acted. */
casesRouter.post(
  '/:caseId/resolve',
  asyncHandler(async (req, res) => {
    const found = store.snapshot().manualCases.find((entry) => entry.id === req.params.caseId);
    if (!found) throw notFound(`No case ${req.params.caseId}`);
    const { resolution } = validate(req.body, { resolution: { type: 'string', default: 'Handled by the travel desk.' } }, 'resolution');
    found.status = 'RESOLVED';
    found.resolution = resolution;
    found.resolvedAt = clock.now().toISOString();
    found.resolvedBy = 'Northwind Travel Desk';
    store.addEvent({
      type: 'ESCALATION',
      level: 'success',
      actor: 'Travel desk',
      title: `Case ${found.id} resolved`,
      detail: resolution,
      tripId: found.tripId,
    });
    return ok(res, found, { resolved: true });
  }),
);
