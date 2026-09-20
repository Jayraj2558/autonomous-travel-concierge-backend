import { Router } from 'express';
import { store } from '../domain/store.js';
import { searchAlternatives } from '../engine/alternativeEngine.js';
import { resolveConstraints } from '../engine/policyEngine.js';
import { analyzeImpact } from '../engine/disruptionEngine.js';
import { checkAvailability, searchFlights } from '../mocks/flightSearchProvider.js';
import { fetchFlightStatus } from '../mocks/flightStatusProvider.js';
import { getScenario } from '../domain/scenarios.js';
import { asyncHandler, badRequest, notFound, ok } from '../utils/http.js';
import { clock, hhmm } from '../utils/time.js';

export const flightsRouter = Router();

const matchSegment = (trip, key) => {
  const needle = decodeURIComponent(key).replace(/\s+/g, '').toUpperCase();
  return (
    trip.segments.find((segment) => segment.id === key) ||
    trip.segments.find((segment) => segment.flightNumber.replace(/\s+/g, '').toUpperCase() === needle) ||
    null
  );
};

/**
 * GET /api/flights/:flightNumber/status
 * Live carrier status for one monitored flight. `scenarioId` lets the mock feed
 * report the pre-disruption state for a scenario preview.
 */
flightsRouter.get(
  '/:flightNumber/status',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    const segment = matchSegment(trip, req.params.flightNumber);
    const scenarioId = req.query.scenarioId || store.snapshot().demo.scenario || undefined;
    const flightNumber = segment?.flightNumber || decodeURIComponent(req.params.flightNumber).toUpperCase();

    const providerPayload = await fetchFlightStatus({
      flightNumber,
      travelDate: trip.startDate,
      scenarioId,
      silent: Boolean(req.query.silent),
    });

    const disruption = store.activeDisruption(trip.id);
    return ok(
      res,
      {
        flightNumber,
        route: segment ? `${segment.from.code} → ${segment.to.code}` : providerPayload.route,
        scheduled: segment ? { departure: segment.departure.scheduled, arrival: segment.arrival.scheduled } : null,
        current: {
          status: disruption && disruption.flightNumber === flightNumber ? disruption.type : segment?.status || providerPayload.status,
          delayMinutes: segment?.delayMinutes || providerPayload.delayMinutes || 0,
          estimatedDeparture: segment?.departure.estimated || null,
          estimatedArrival: segment?.arrival.estimated || null,
        },
        provider: 'Airline Ops Feed · mock',
        providerPayload,
        lastChecked: segment?.lastStatusCheck || clock.now().toISOString(),
        source: 'GET /api/flights/:flightNumber/status',
      },
      { silent: Boolean(req.query.silent) },
    );
  }),
);

/** GET /api/flights/:flightNumber/availability — seat inventory for one service. */
flightsRouter.get(
  '/:flightNumber/availability',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    const segment = matchSegment(trip, req.params.flightNumber);
    const cabin = req.query.cabin || trip.cabin || 'ECONOMY';
    const availability = await checkAvailability({
      flightNumber: segment?.flightNumber || decodeURIComponent(req.params.flightNumber).toUpperCase(),
      cabin,
      scenarioId: req.query.scenarioId || undefined,
      silent: Boolean(req.query.silent),
    });
    return ok(res, availability, { cabin, checkedAt: clock.now().toISOString() });
  }),
);

/**
 * GET /api/flights/alternatives
 * Returns the ranked options for the active disruption. Re-executes the search
 * when `refresh=true` or when no search has been run yet.
 */
flightsRouter.get(
  '/alternatives',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.query.tripId) || store.activeTrip();
    if (!trip) throw notFound('No active trip to plan against');

    const workflow = store.getWorkflow(trip.id);
    const scenarioId = req.query.scenarioId || workflow?.scenarioId || store.snapshot().demo.scenario || undefined;
    const wantsFresh = req.query.refresh === 'true' || !workflow?.search;

    if (!wantsFresh && workflow?.search) {
      return ok(res, { ...workflow.search, cached: true }, { tripId: trip.id, scenarioId: workflow.scenarioId });
    }

    const preferences = store.getPreferences(trip.travelerId);
    const policy = store.getPolicy(trip.policyId);
    const constraints = resolveConstraints({ policy, preferences, trip });
    const disruption =
      workflow?.disruption ||
      store.activeDisruption(trip.id) ||
      {
        id: 'adhoc',
        type: 'FLIGHT_CANCELLED',
        segmentId: trip.segments[0].id,
        flightNumber: trip.segments[0].flightNumber,
        route: `${trip.segments[0].from.code} → ${trip.segments[0].to.code}`,
        reason: 'Severe weather',
        severity: 'high',
      };

    const search = await searchAlternatives({
      trip,
      disruption,
      constraints,
      policy,
      preferences,
      hotel: trip.hotel,
      scenarioId,
      planningTime: clock.now(),
      silent: true,
    });

    const impact = analyzeImpact({ trip, disruption, constraints, hotel: trip.hotel });

    return ok(
      res,
      { ...search, impactSummary: impact.downstreamNotes, cached: false },
      { tripId: trip.id, scenarioId: scenarioId || null, planningTime: hhmm(clock.now()) },
    );
  }),
);

/** GET /api/flights/search — raw provider search, useful for the "why not this?" view. */
flightsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { from, to, cabin = 'economy', scenarioId } = req.query;
    if (!from || !to) throw badRequest('from and to query parameters are required');
    const trip = store.activeTrip();
    const result = await searchFlights({
      from: String(from).toUpperCase(),
      to: String(to).toUpperCase(),
      afterIso: clock.now().toISOString(),
      cabin,
      scenarioId,
      travelDate: trip.startDate,
    });
    return ok(res, result.data, { provider: result.meta.provider, latencyMs: result.meta.latencyMs, scenarioId: scenarioId || null });
  }),
);

/** GET /api/flights/scenarios/:scenarioId/preview — what each scenario would inject. */
flightsRouter.get(
  '/scenarios/:scenarioId/preview',
  asyncHandler(async (req, res) => {
    const scenario = getScenario(req.params.scenarioId);
    if (!scenario) throw notFound(`Unknown scenario ${req.params.scenarioId}`);
    const trip = store.activeTrip();
    const providerPayload = await fetchFlightStatus({
      flightNumber: trip.segments[0].flightNumber,
      travelDate: trip.startDate,
      scenarioId: scenario.id,
      silent: true,
    });
    return ok(res, { scenario, providerPayload }, { preview: true });
  }),
);
