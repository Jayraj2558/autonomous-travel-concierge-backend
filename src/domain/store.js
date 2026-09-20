import {
  DEMO_POLICY,
  DEMO_PREFERENCES,
  DEMO_TRAVELER,
  buildDemoTrip,
  buildSeedEvents,
  buildSeedNotifications,
} from './seed.js';
import { logger } from '../utils/logger.js';
import { audit } from '../db/repository.js';

/**
 * In-memory working set for the simulation. The same mutations are mirrored to
 * PostgreSQL (see src/db/repository.js) when a database is configured, which keeps
 * the hot path fast while still producing a durable audit trail.
 */
class Store {
  constructor() {
    this.reset({ silent: true });
  }

  reset({ silent = false } = {}) {
    const trip = buildDemoTrip();
    // Keep a pristine copy of the ticketed itinerary. Demo scenarios restore from
    // this snapshot, which is what makes every replay identical.
    trip.baseline = {
      segments: structuredClone(trip.segments),
      hotel: trip.hotel ? structuredClone(trip.hotel) : null,
    };
    this.state = {
      travelers: { [DEMO_TRAVELER.id]: DEMO_TRAVELER },
      trips: { [trip.id]: trip },
      policies: { [DEMO_POLICY.id]: DEMO_POLICY },
      preferences: { [DEMO_TRAVELER.id]: DEMO_PREFERENCES },
      notifications: buildSeedNotifications(),
      events: buildSeedEvents(),
      disruptions: [],
      workflows: {},
      bookings: [],
      hotelUpdates: [],
      manualCases: [],
      demo: { runs: 0, scenario: null, startedAt: null, completedAt: null },
      metrics: {
        flightsMonitored: 2,
        connectionsMonitored: 1,
        hotelsMonitored: 1,
        disruptionsDetected: 0,
        automaticRecoveries: 0,
        manualInterventions: 0,
        approvalsRequested: 0,
        rebookingAttempts: 0,
        rebookingSuccesses: 0,
        alternativesEvaluated: 0,
        notificationsSent: 0,
        providerCalls: 0,
        providerFailures: 0,
        detectionMs: [],
        recoveryMs: [],
      },
    };
    if (!silent) logger.info('Demo state reset to a nominal journey');
    return this.state;
  }

  // ---------------------------------------------------------------- travelers
  getTraveler(id) {
    return Object.values(this.state.travelers).find((t) => t.id === id) ||
      this.state.travelers[DEMO_TRAVELER.id];
  }

  getTravelerForTrip(tripId) {
    return this.getTraveler(this.getTrip(tripId)?.travelerId);
  }

  // -------------------------------------------------------------------- trips
  listTrips() {
    return Object.values(this.state.trips);
  }

  getTrip(id) {
    if (!id) return undefined;
    return this.state.trips[id] || Object.values(this.state.trips).find((t) => t.code === id);
  }

  saveTrip(trip) {
    trip.updatedAt = new Date().toISOString();
    this.state.trips[trip.id] = trip;
    audit.trip(trip);
    return trip;
  }

  activeTrip() {
    return this.listTrips()[0];
  }

  // -------------------------------------------------------------- preferences
  getPreferences(travelerId = DEMO_TRAVELER.id) {
    return this.state.preferences[travelerId] || DEMO_PREFERENCES;
  }

  savePreferences(travelerId, patch) {
    const merged = { ...this.getPreferences(travelerId), ...patch, updatedAt: new Date().toISOString() };
    this.state.preferences[travelerId] = merged;
    return merged;
  }

  getPolicy(policyId) {
    return this.state.policies[policyId] || DEMO_POLICY;
  }

  // ------------------------------------------------------------------- events
  addEvent(event) {
    const record = { id: event.id || `evt_${this.state.events.length + 1}`, ...event };
    this.state.events.push(record);
    if (this.state.events.length > 500) this.state.events.shift();
    audit.event(record);
    return record;
  }

  listEvents(tripId, limit = 60) {
    const filtered = this.state.events.filter((e) => !tripId || e.tripId === tripId);
    return filtered.slice(-limit).reverse();
  }

  // ------------------------------------------------------------ notifications
  addNotification(notification) {
    const record = { id: `ntf_${this.state.notifications.length + 1}`, read: false, ...notification };
    this.state.notifications.unshift(record);
    this.state.metrics.notificationsSent += 1;
    audit.notification(record);
    return record;
  }

  listNotifications(tripId) {
    return this.state.notifications.filter((n) => !tripId || n.tripId === tripId);
  }

  markNotificationsRead(ids = []) {
    const targets = ids.length ? new Set(ids) : null;
    this.state.notifications = this.state.notifications.map((n) =>
      !targets || targets.has(n.id) ? { ...n, read: true } : n,
    );
    return this.listNotifications().filter((n) => !n.read).length;
  }

  // ------------------------------------------------------------- disruptions
  addDisruption(disruption) {
    this.state.disruptions.unshift(disruption);
    this.state.metrics.disruptionsDetected += 1;
    audit.disruption(disruption);
    return disruption;
  }

  getDisruption(id) {
    return this.state.disruptions.find((d) => d.id === id);
  }

  activeDisruption(tripId) {
    const trip = this.getTrip(tripId);
    if (!trip?.state?.activeDisruptionId) return null;
    return this.getDisruption(trip.state.activeDisruptionId) || null;
  }

  // --------------------------------------------------------------- workflows
  saveWorkflow(tripId, workflow) {
    this.state.workflows[tripId] = { ...workflow, updatedAt: new Date().toISOString() };
    audit.workflow(this.state.workflows[tripId]);
    return this.state.workflows[tripId];
  }

  getWorkflow(tripId) {
    return this.state.workflows[tripId] || null;
  }

  // ---------------------------------------------------------------- bookings
  addBooking(booking) {
    this.state.bookings.unshift(booking);
    audit.booking(booking);
    return booking;
  }

  listBookings(tripId) {
    return this.state.bookings.filter((b) => !tripId || b.tripId === tripId);
  }

  addHotelUpdate(update) {
    this.state.hotelUpdates.unshift(update);
    audit.hotelUpdate(update);
    return update;
  }

  listHotelUpdates(tripId) {
    return this.state.hotelUpdates.filter((u) => !tripId || u.tripId === tripId);
  }

  addManualCase(record) {
    this.state.manualCases.unshift(record);
    this.state.metrics.manualInterventions += 1;
    return record;
  }

  trackProvider({ name, ok, latencyMs }) {
    this.state.metrics.providerCalls += 1;
    if (!ok) this.state.metrics.providerFailures += 1;
    const stats = this.state.providerStats || (this.state.providerStats = {});
    const entry = stats[name] || (stats[name] = { name, calls: 0, failures: 0, latencyMs: [], lastCallAt: null });
    entry.calls += 1;
    if (!ok) entry.failures += 1;
    entry.latencyMs.push(latencyMs);
    if (entry.latencyMs.length > 50) entry.latencyMs.shift();
    entry.lastCallAt = new Date().toISOString();
    return entry;
  }

  providerStats() {
    return Object.values(this.state.providerStats || {});
  }

  recordDetection(ms) {
    this.state.metrics.detectionMs.push(ms);
  }

  recordRecovery(ms) {
    this.state.metrics.recoveryMs.push(ms);
  }

  snapshot() {
    return this.state;
  }
}

export const store = new Store();
