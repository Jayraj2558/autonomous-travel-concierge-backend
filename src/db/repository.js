import { db } from './client.js';
import { logger } from '../utils/logger.js';

const log = logger.child('audit');

/**
 * Audit mirror. Fire-and-forget writes: the recovery pipeline never waits on
 * persistence, and the Admin page shows the honest state of the mirror.
 */
export const audit = {
  trip(trip) {
    if (!db.enabled) return;
    db.upsert('trips', {
      id: trip.id,
      code: trip.code,
      traveler_id: trip.travelerId,
      status: trip.status,
      phase: trip.state?.phase || null,
      payload: { ...trip, updatedAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).catch((error) => log.warn(error.message));
  },

  disruption(disruption) {
    if (!db.enabled) return;
    db.upsert('disruptions', {
      id: disruption.id,
      trip_id: disruption.tripId,
      scenario_id: disruption.scenarioId,
      type: disruption.type,
      flight_number: disruption.flightNumber,
      reason: disruption.reason,
      severity: disruption.severity,
      detected_at: disruption.detectedAt,
      detection_ms: disruption.detectedInMs,
      payload: disruption,
    }).catch((error) => log.warn(error.message));
  },

  workflow(workflow) {
    if (!db.enabled) return;
    db.upsert('workflows', {
      id: workflow.id,
      trip_id: workflow.tripId,
      scenario_id: workflow.scenarioId,
      status: workflow.status,
      decision: workflow.decision?.decision || null,
      started_at: workflow.startedAt,
      completed_at: workflow.completedAt,
      recovery_ms: workflow.metrics?.recoveryMs || null,
      payload: workflow,
      updated_at: new Date().toISOString(),
    }).catch((error) => log.warn(error.message));
  },

  booking(booking) {
    if (!db.enabled) return;
    db.upsert('bookings', {
      id: booking.id,
      trip_id: booking.tripId,
      reference: booking.reference,
      status: booking.status,
      label: booking.label,
      added_fare: booking.addedFare,
      approved_by: booking.approvedBy,
      payload: booking,
      created_at: booking.createdAt,
    }).catch((error) => log.warn(error.message));
  },

  hotelUpdate(update) {
    if (!db.enabled) return;
    db.upsert('hotel_updates', {
      id: update.id,
      trip_id: update.tripId,
      confirmation: update.confirmation,
      previous_arrival: update.previousArrival,
      confirmed_arrival: update.confirmedArrival,
      hold_until: update.holdUntil,
      payload: update,
      created_at: update.syncedAt,
    }).catch((error) => log.warn(error.message));
  },

  notification(notification) {
    if (!db.enabled) return;
    db.upsert('notifications', {
      id: notification.id,
      trip_id: notification.tripId,
      level: notification.level,
      category: notification.category,
      title: notification.title,
      body: notification.body,
      channels: notification.channels,
      payload: notification,
      created_at: notification.at,
    }).catch((error) => log.warn(error.message));
  },

  event(event) {
    if (!db.enabled) return;
    db.upsert('agent_events', {
      id: event.id,
      trip_id: event.tripId,
      type: event.type,
      level: event.level,
      title: event.title,
      detail: event.detail,
      actor: event.actor,
      at: event.at,
      payload: event,
    }).catch((error) => log.warn(error.message));
  },
};
