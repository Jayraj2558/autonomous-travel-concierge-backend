import { addMinutes, diffMinutes, hhmm, toDate } from '../utils/time.js';
import { getAirport } from '../domain/airports.js';

/**
 * Missed-connection detection.
 *
 *   earliestBoardableDeparture = estimatedArrival + minimumConnectionTime
 *   risk                       = earliestBoardableDeparture > nextDeparture
 *
 * The same helper powers the "Connection risk calculator" panel in the UI, so
 * what the traveler reads is literally the arithmetic the engine ran.
 */
export function evaluateConnection(inbound, outbound, options = {}) {
  const minimumConnectionMinutes = options.minimumConnectionMinutes ?? inbound?.minimumConnectionMinutes ?? 45;
  const inboundArrival = inbound?.arrival?.estimated || inbound?.arrival?.scheduled;
  const outboundDeparture = outbound?.departure?.estimated || outbound?.departure?.scheduled;

  if (!inboundArrival || !outboundDeparture) {
    return {
      status: 'UNKNOWN',
      viable: true,
      minimumConnectionMinutes,
      reason: 'Connection data unavailable',
      steps: [],
    };
  }

  const earliestBoardableDeparture = addMinutes(inboundArrival, minimumConnectionMinutes);
  const bufferMinutes = diffMinutes(outboundDeparture, earliestBoardableDeparture);
  const viable = bufferMinutes >= 0;

  const steps = [
    {
      label: `${inbound.flightNumber} estimated arrival`,
      value: hhmm(inboundArrival),
      source: inbound.arrival?.estimated && toDate(inbound.arrival.estimated).getTime() !== toDate(inbound.arrival.scheduled).getTime()
        ? 'live estimate'
        : 'schedule',
    },
    { label: 'Minimum connection time at DEL', value: `${minimumConnectionMinutes} min`, source: 'airport + airline MCT' },
    { label: 'Earliest boardable departure', value: hhmm(earliestBoardableDeparture), source: 'arrival + MCT' },
    { label: `${outbound.flightNumber} departure`, value: hhmm(outboundDeparture), source: 'schedule' },
  ];

  return {
    status: viable ? (bufferMinutes < 20 ? 'TIGHT' : 'PROTECTED') : 'AT_RISK',
    viable,
    minimumConnectionMinutes,
    inboundArrival: toDate(inboundArrival).toISOString(),
    earliestBoardableDeparture: earliestBoardableDeparture.toISOString(),
    outboundDeparture: toDate(outboundDeparture).toISOString(),
    bufferMinutes,
    shortfallMinutes: viable ? 0 : Math.abs(bufferMinutes),
    reason: viable
      ? `Connection protected with ${bufferMinutes} min of buffer above the ${minimumConnectionMinutes} min minimum.`
      : `Arrival + ${minimumConnectionMinutes} min minimum connection falls ${Math.abs(bufferMinutes)} min after the connection departs.`,
    steps,
    riskLabel: viable ? 'CONNECTION PROTECTED' : 'MISSED CONNECTION RISK',
  };
}

/** Connection maths for a *proposed* recovery option. */
export function evaluateOptionConnection(legs, minimumConnectionMinutes = 45) {
  if (!legs || legs.length < 2) return null;
  const checks = [];
  for (let i = 0; i < legs.length - 1; i += 1) {
    const leg = legs[i];
    const next = legs[i + 1];
    const layoverMinutes = diffMinutes(next.departure.scheduled, leg.arrival.scheduled);
    const stopAirport = getAirport(leg.to.code || leg.to);
    const ok = layoverMinutes >= minimumConnectionMinutes;
    checks.push({
      airport: stopAirport.code,
      airportName: stopAirport.name,
      layoverMinutes,
      requiredMinutes: minimumConnectionMinutes,
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `${layoverMinutes} min layover at ${stopAirport.code} — ${layoverMinutes - minimumConnectionMinutes} min above minimum.`
        : `Only ${layoverMinutes} min at ${stopAirport.code}; policy requires ${minimumConnectionMinutes} min.`,
    });
  }
  const failed = checks.filter((c) => c.status === 'FAIL');
  return {
    status: failed.length ? 'FAIL' : 'PASS',
    checks,
    minimumLayoverMinutes: Math.min(...checks.map((c) => c.layoverMinutes)),
  };
}

export function evaluateItineraryConnections(segments, minimumConnectionMinutes = 45) {
  const pairs = [];
  for (let i = 0; i < segments.length - 1; i += 1) {
    pairs.push(evaluateConnection(segments[i], segments[i + 1], { minimumConnectionMinutes }));
  }
  return pairs;
}
