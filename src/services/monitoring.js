import { store } from '../domain/store.js';
import { clock, toIstIso, hhmm } from '../utils/time.js';
import { broadcastMonitoring, broadcastAgentEvent, broadcastMetrics } from './realtime.js';
import { computeMetrics } from './metrics.js';

/**
 * Continuous monitoring loop.
 *
 * In production this would be an event stream from carrier ops feeds. Here it is
 * a scheduled sweep that keeps the "last checked" timestamps alive and writes a
 * nominal audit event every few sweeps, so the Live Monitoring page reads like a
 * real operations console instead of a static mock.
 */
const NOMINAL_MESSAGES = [
  (trip) => ({
    title: `Flight status checked · ${trip.segments.map((s) => s.flightNumber).join(', ')}`,
    detail: trip.segments
      .map((s) => `${s.flightNumber} ${s.status === 'CONFIRMED' ? 'confirmed' : s.status.toLowerCase()}`)
      .join(' · ') + '. No schedule change published.',
    type: 'FLIGHT_STATUS',
  }),
  (trip) => ({
    title: 'Connection verified · DEL',
    detail: `Connection buffer recalculated against the latest estimates; minimum connection time ${trip.segments[1]?.minimumConnectionMinutes || 45} min respected.`,
    type: 'CONNECTION',
  }),
  (trip) => ({
    title: 'Hotel availability checked',
    detail: `${trip.hotel.name} confirms reservation ${trip.hotel.confirmation}; room held until ${hhmm(trip.hotel.checkIn.holdUntil)}.`,
    type: 'HOTEL',
  }),
  () => ({
    title: 'Policy re-validated',
    detail: 'Travel policy is current; no amendments since the last sweep. Alternatives inventory pre-cached.',
    type: 'POLICY',
  }),
  () => ({
    title: 'No disruption detected',
    detail: 'All monitored items nominal. Next sweep scheduled.',
    type: 'MONITORING',
  }),
];

let timer = null;
let sweep = 0;

export function startMonitoring() {
  if (timer) return timer;

  timer = setInterval(() => {
    sweep += 1;
    const now = clock.now();
    const trips = store.listTrips();

    trips.forEach((trip) => {
      const checks = trip.monitoring?.checks;
      if (!checks) return;
      const advanced =
        trip.state?.phase === 'RECOVERED' || trip.state?.phase === 'MONITORING' || trip.state?.phase === 'AWAITING_APPROVAL';

      if (advanced) {
        Object.entries(checks).forEach(([key, entry], index) => {
          if ((sweep + index) % 2 === 0) entry.lastChecked = toIstIso(now);
          if (trip.state?.phase !== 'AWAITING_APPROVAL') entry.checks += 1;
        });
      }

      if (sweep % 3 === 0) {
        trip.monitoring.checks.flight.checks += 1;
        trip.monitoring.checks.connection.checks += 1;
      }
    });

    const tripsWithMonitoring = trips.filter((t) => t.monitoring);
    broadcastMonitoring({
      at: toIstIso(now),
      sweep,
      trips: tripsWithMonitoring.map((trip) => ({
        tripId: trip.id,
        phase: trip.state?.phase || 'MONITORING',
        checks: trip.monitoring.checks,
        status: trip.status,
      })),
    });

    // A nominal audit line every fourth sweep keeps the timeline alive without noise.
    if (sweep % 4 === 0 && tripsWithMonitoring.length) {
      const trip = tripsWithMonitoring[0];
      const generator = NOMINAL_MESSAGES[(sweep / 4) % NOMINAL_MESSAGES.length];
      const message = generator(trip);
      const event = store.addEvent({
        tripId: trip.id,
        at: toIstIso(clock.now()),
        type: message.type,
        level: 'info',
        title: message.title,
        detail: message.detail,
        actor: 'Monitoring Service',
      });
      broadcastAgentEvent(event);
    }

    if (sweep % 6 === 0) broadcastMetrics(computeMetrics(store.snapshot()));
  }, 12000);

  return timer;
}

export function stopMonitoring() {
  if (timer) clearInterval(timer);
  timer = null;
}
