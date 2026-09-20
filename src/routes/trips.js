import { Router } from 'express';
import { store } from '../domain/store.js';
import { createTrip } from '../domain/tripFactory.js';
import { asyncHandler, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock, hhmm } from '../utils/time.js';

export const tripsRouter = Router();

const createTripSchema = {
  origin: { type: 'string', required: true, max: 3 },
  destination: { type: 'string', required: true, max: 3 },
  startDate: { type: 'string', default: '2026-09-24' },
  cabin: { type: 'string', enum: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS'], default: 'ECONOMY' },
  passengers: { type: 'number', min: 1, max: 9, default: 1 },
  via: { type: 'array' },
  airline: { type: 'string', default: '6E' },
  hotelName: { type: 'string' },
};

/** GET /api/trips — every trip this traveler has on file, newest first. */
tripsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trips = store.listTrips();
    return ok(res, trips, { count: trips.length, demoClock: clock.now().toISOString() });
  }),
);

/** POST /api/trips — register a journey and start monitoring it. */
tripsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = validate(req.body, createTripSchema, 'trip');
    const trip = createTrip({
      origin: payload.origin,
      destination: payload.destination,
      via: payload.via || [],
      date: payload.startDate,
      cabin: payload.cabin,
      airline: payload.airline,
      hotelName: payload.hotelName || 'The Grand Mumbai',
      hotelArea: 'Bandra Kurla Complex',
    });
    store.saveTrip(trip);
    store.addEvent({
      type: 'MONITORING',
      level: 'success',
      actor: 'TravelGuard',
      title: `Monitoring started for ${trip.code}`,
      detail: `${trip.segments.length} flights, ${trip.segments.length - 1} connection(s) and the hotel stay are now watched.`,
      tripId: trip.id,
    });
    return ok(res, trip, { created: true });
  }),
);

/** GET /api/trips/:tripId */
tripsRouter.get(
  '/:tripId',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    return ok(res, trip, { clock: clock.now().toISOString() });
  }),
);

/** GET /api/trips/:tripId/itinerary — flights, connections and the stay in one view. */
tripsRouter.get(
  '/:tripId/itinerary',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    return ok(
      res,
      {
        trip,
        segments: trip.segments,
        connections: trip.segments.filter((segment) => segment.isConnection),
        hotel: trip.hotel,
        handling: trip.state.phase,
      },
      { segments: trip.segments.length },
    );
  }),
);

/** GET /api/trips/:tripId/events — the agent activity stream for this trip. */
tripsRouter.get(
  '/:tripId/events',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const events = store.listEvents(trip.id, limit);
    return ok(res, events, { count: events.length, limit });
  }),
);

/** GET /api/trips/:tripId/monitoring — live status of every monitor attached to the trip. */
tripsRouter.get(
  '/:tripId/monitoring',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    return ok(res, trip.monitoring, {
      phase: trip.state.phase,
      nextSweepInSeconds: trip.monitoring.tickSeconds || null,
      statuses: trip.segments.map((segment) => ({
        flightNumber: segment.flightNumber,
        status: segment.status,
        route: `${segment.from.code} → ${segment.to.code}`,
        lastStatusCheck: segment.lastStatusCheck || null,
      })),
    });
  }),
);

/** POST /api/trips/:tripId/reset — restore the itinerary to its ticketed state. */
tripsRouter.post(
  '/:tripId/reset',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    const { restoreBaseline } = await import('../engine/workflow.js');
    restoreBaseline(trip);
    store.saveTrip(trip);
    store.addEvent({
      type: 'MONITORING',
      level: 'info',
      actor: 'TravelGuard',
      title: 'Itinerary restored to the ticketed plan',
      detail: `Baseline re-applied at ${hhmm(clock.now())} IST.`,
      tripId: trip.id,
    });
    return ok(res, trip, { restored: true });
  }),
);
