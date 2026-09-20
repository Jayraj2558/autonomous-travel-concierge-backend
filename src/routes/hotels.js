import { Router } from 'express';
import { store } from '../domain/store.js';
import { confirmReservation, updateArrival } from '../mocks/hotelProvider.js';
import { notify } from '../services/notifications.js';
import { broadcastTripState, emit } from '../services/realtime.js';
import { asyncHandler, badRequest, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock, diffMinutes, hhmm, toIstIso } from '../utils/time.js';
import { formatDelta } from '../utils/money.js';

export const hotelsRouter = Router();

/** GET /api/hotels/updates — the property sync log for this journey. */
hotelsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.query.tripId) || store.activeTrip();
    const updates = store.listHotelUpdates(trip?.id);
    return ok(res, updates, {
      count: updates.length,
      lastSyncAt: updates[0]?.syncedAt || trip?.hotel?.lastSyncAt || null,
    });
  }),
);

/** GET /api/hotels/updates — the property sync log for this journey. */
hotelsRouter.get(
  '/updates',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.query.tripId) || store.activeTrip();
    const updates = store.listHotelUpdates(trip?.id);
    return ok(res, updates, {
      count: updates.length,
      lastSyncAt: updates[0]?.syncedAt || trip?.hotel?.lastSyncAt || null,
      property: trip?.hotel?.name || null,
    });
  }),
);

/** GET /api/hotels/:tripId — the reservation as the property currently holds it. */
hotelsRouter.get(
  '/:tripId',
  asyncHandler(async (req, res) => {
    const trip = store.getTrip(req.params.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${req.params.tripId}`);
    if (!trip.hotel) throw notFound('This trip has no hotel attached');

    const reservation = await confirmReservation({ hotel: trip.hotel, silent: true });
    return ok(
      res,
      {
        hotel: trip.hotel,
        propertyView: reservation.data,
        arrivals: {
          scheduled: trip.hotel.checkIn.scheduled,
          current: trip.hotel.checkIn.current,
          holdUntil: trip.hotel.checkIn.holdUntil,
          shiftedMinutes: trip.hotel.revision?.shiftedMinutes || 0,
        },
      },
      { provider: reservation.meta.provider, latencyMs: reservation.meta.latencyMs, confirmedAt: clock.now().toISOString() },
    );
  }),
);

/**
 * POST /api/hotels/update
 * Re-times the arrival on the reservation — the same call the autonomous
 * recovery makes, exposed for the hotel screen.
 */
hotelsRouter.post(
  '/update',
  asyncHandler(async (req, res) => {
    const payload = validate(
      req.body,
      {
        tripId: { type: 'string' },
        arrival: { type: 'string', required: true },
        reason: { type: 'string', default: 'Traveler requested a later check-in.' },
      },
      'hotel update',
    );

    const trip = store.getTrip(payload.tripId) || store.activeTrip();
    if (!trip) throw notFound(`No trip found for ${payload.tripId || 'the active trip'}`);
    if (!trip.hotel) throw badRequest('This trip has no hotel attached');

    const newArrival = new Date(payload.arrival);
    if (Number.isNaN(newArrival.getTime())) throw badRequest('arrival must be an ISO-8601 timestamp');

    const previousArrival = new Date(trip.hotel.checkIn.current);
    if (newArrival.getTime() === previousArrival.getTime()) {
      throw badRequest('The new arrival matches the current check-in time');
    }

    const isSameDay = toIstIso(newArrival).slice(0, 10) === toIstIso(previousArrival).slice(0, 10);
    const result = await updateArrival({
      hotel: trip.hotel,
      newArrival,
      previousArrival,
      reason: payload.reason,
      silent: Boolean(req.body?.silent),
    });

    const update = result.data;
    trip.hotel.checkIn.current = update.confirmedArrival;
    trip.hotel.checkIn.holdUntil = update.holdUntil;
    trip.hotel.status = 'CONFIRMED';
    trip.hotel.transferUpdated = true;
    trip.hotel.lastSyncAt = update.syncedAt;
    trip.hotel.revision = {
      previousArrival: update.previousArrival,
      newArrival: update.confirmedArrival,
      shiftedMinutes: diffMinutes(update.confirmedArrival, update.previousArrival),
      reason: payload.reason,
      at: update.syncedAt,
      provider: update.provider,
      holdExtended: update.holdExtended,
      approvedBy: update.extensionApprovedBy,
    };

    const record = { id: `htl_${Date.now().toString(36)}`, tripId: trip.id, ...update };
    store.addHotelUpdate(record);

    store.addEvent({
      type: 'HOTEL',
      level: 'success',
      actor: 'Hotel Coordinator',
      title: `Check-in re-timed to ${hhmm(update.confirmedArrival)}`,
      detail: `${trip.hotel.name} · ${update.notes[0]}`,
      tripId: trip.id,
    });

    await notify({
      trip,
      level: 'warning',
      category: 'HOTEL',
      title: `Hotel check-in moved to ${hhmm(update.confirmedArrival)}`,
      body: `${trip.hotel.name} has confirmed a ${isSameDay ? 'same-day' : 'next-day'} arrival at ${hhmm(update.confirmedArrival)}. The room is held until ${hhmm(update.holdUntil)}.`,
      action: { label: 'Open hotel detail', href: '/hotel' },
      channels: ['push', 'email'],
    });

    emit('hotel:updated', { hotel: trip.hotel, update: record, trip });
    broadcastTripState({ trip, workflow: store.getWorkflow(trip.id) });
    store.saveTrip(trip);

    return ok(res, record, {
      provider: result.meta.provider,
      latencyMs: result.meta.latencyMs,
      shiftedMinutes: diffMinutes(update.confirmedArrival, update.previousArrival),
      fareImpact: formatDelta(0),
    });
  }),
);

