/**
 * Seed the PostgreSQL mirror with the current demo working set.
 *
 *   npm run seed                # in-memory summary only
 *   DATABASE_URL=postgres://… npm run seed
 *
 * The application itself never requires a database — this script exists so the
 * audit trail can be inspected in SQL after a demo.
 */
import { store } from '../src/domain/store.js';
import { db, databaseStatus } from '../src/db/client.js';
import { logger } from '../src/utils/logger.js';

const log = logger.child('seed');

async function main() {
  const state = store.snapshot();
  const trip = store.activeTrip();
  const bookingCount = state.bookings.length;

  log.info(`Working set: ${Object.keys(state.trips).length} trip(s), ${trip.segments.length} segments, ${bookingCount} booking(s)`);

  if (!databaseStatus().configured) {
    log.warn('DATABASE_URL is not set — nothing was written. The API runs entirely in memory without it.');
    log.info(`Reference data that would be mirrored: policy ${store.getPolicy(trip.policyId).id}, traveler ${trip.travelerId}`);
    return;
  }

  const results = await Promise.all([
    db.upsert('trips', { id: trip.id, payload: trip }),
    db.upsert('travelers', { id: trip.travelerId, payload: store.getTraveler(trip.travelerId) }),
    ...state.disruptions.map((entry) => db.upsert('disruptions', { id: entry.id, payload: entry })),
    ...Object.values(state.workflows).map((entry) => db.upsert('workflows', { id: entry.id, payload: entry })),
    ...state.bookings.map((entry) => db.upsert('bookings', { id: entry.id || entry.reference, payload: entry })),
    ...state.hotelUpdates.map((entry) => db.upsert('hotel_updates', { id: entry.id, payload: entry })),
    ...state.notifications.map((entry) => db.upsert('notifications', { id: entry.id, payload: entry })),
    ...state.events.slice(0, 50).map((entry) => db.upsert('agent_events', { id: entry.id, payload: entry })),
    ...state.manualCases.map((entry) => db.upsert('manual_cases', { id: entry.id, payload: entry })),
  ]);

  const written = results.filter((entry) => entry?.persisted).length;
  log.info(`Mirrored ${written} row(s) to PostgreSQL`);
  const stats = await db.stats();
  if (stats) log.info(`Row counts: ${JSON.stringify(stats)}`);
  await db.close();
}

main().catch((error) => {
  log.error(`Seed failed: ${error.message}`);
  process.exit(1);
});
