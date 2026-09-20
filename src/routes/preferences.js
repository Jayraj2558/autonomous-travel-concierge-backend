import { Router } from 'express';
import { store } from '../domain/store.js';
import { resolveConstraints } from '../engine/policyEngine.js';
import { asyncHandler, notFound, ok } from '../utils/http.js';
import { validate } from '../utils/validate.js';
import { clock } from '../utils/time.js';

export const preferencesRouter = Router();

/** GET /api/preferences — the traveler's standing instructions to the engine. */
preferencesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trip = store.activeTrip();
    const travelerId = req.query.travelerId || trip?.travelerId;
    const preferences = store.getPreferences(travelerId);
    if (!preferences) throw notFound('No preferences found for this traveler');
    const policy = store.getPolicy(trip.policyId);

    return ok(res, preferences, {
      policyId: policy.id,
      constraints: resolveConstraints({ policy, preferences, trip }),
      updatedAt: preferences.updatedAt,
    });
  }),
);

/**
 * PUT /api/preferences
 * Merges a partial update. Every field here is read by the deterministic engine
 * on the next evaluation, so the effect is immediate and auditable.
 */
preferencesRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const payload = validate(
      req.body,
      {
        preferredAirlines: { type: 'array' },
        avoidAirlines: { type: 'array' },
        maxAdditionalFare: { type: 'number', min: 0, max: 50000 },
        maxAcceptableDelayMinutes: { type: 'number', min: 0, max: 1440 },
        nonStopPreferred: { type: 'boolean' },
        maxStops: { type: 'number', min: 0, max: 3 },
        cabin: { type: 'string', enum: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS'] },
        requireSameCabin: { type: 'boolean' },
        autoRebook: { type: 'boolean' },
        hotelAdjustment: { type: 'boolean' },
        seatPreference: { type: 'string' },
        mealPreference: { type: 'string' },
        accessibility: { type: 'object' },
        notifications: { type: 'object' },
      },
      'preferences',
    );

    const trip = store.activeTrip();
    const travelerId = req.query.travelerId || trip?.travelerId;
    const updated = store.savePreferences(travelerId, payload);
    if (!updated) throw notFound('No preferences found for this traveler');

    const policy = store.getPolicy(trip.policyId);
    const constraints = resolveConstraints({ policy, preferences: updated, trip });

    store.addEvent({
      type: 'POLICY',
      level: 'info',
      actor: 'Traveler',
      title: 'Travel preferences updated',
      detail: `Fare allowance ₹${updated.maxAdditionalFare.toLocaleString('en-IN')}, delay tolerance ${updated.maxAcceptableDelayMinutes} min, auto-rebooking ${updated.autoRebook ? 'on' : 'off'}.`,
      tripId: trip?.id || null,
    });

    return ok(res, updated, { constraints, appliedAt: clock.now().toISOString() });
  }),
);
