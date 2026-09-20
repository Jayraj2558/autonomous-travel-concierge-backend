import { addMinutes, diffMinutes, hhmm, toIstIso } from '../utils/time.js';
import { evaluateConnection, evaluateItineraryConnections } from './connection.js';
import { getAirport } from '../domain/airports.js';
import { formatInr } from '../utils/money.js';
import { getScenario } from '../domain/scenarios.js';
import { id } from '../utils/random.js';

/**
 * Disruption detection + impact analysis.
 *
 * Detection compares the airline's live status feed against the ticketed
 * itinerary. Impact analysis then answers the human question: what breaks, for
 * whom, and how much time do we have to fix it?
 */
export function buildDisruption({ trip, scenarioId, providerPayload, detectedAt, source = 'Airline Ops Feed · mock' }) {
  const scenario = getScenario(scenarioId);
  const segment = trip.segments.find((s) => s.flightNumber === providerPayload.flightNumber) || trip.segments[0];

  return {
    id: id('dsp'),
    tripId: trip.id,
    scenarioId,
    type: providerPayload.status === 'CANCELLED' ? 'FLIGHT_CANCELLED' : 'FLIGHT_DELAYED',
    segmentId: segment.id,
    flightNumber: providerPayload.flightNumber,
    route: `${segment.from.code} → ${segment.to.code}`,
    reason: providerPayload.reason || scenario?.reason || 'Operational disruption',
    severity: scenario?.severity || 'high',
    disruptionCode: providerPayload.disruptionCode || 'OPS-IRREG',
    remark: providerPayload.remark,
    detectedAt: detectedAt || new Date().toISOString(),
    detectedInMs: null,
    source,
    confidence: 0.98,
    providerPayload: {
      status: providerPayload.status,
      revisedDeparture: providerPayload.revisedDeparture || null,
      revisedArrival: providerPayload.revisedArrival || null,
      delayMinutes: providerPayload.delayMinutes || 0,
      rebookAllowed: providerPayload.rebookAllowed !== false,
    },
    title:
      providerPayload.status === 'CANCELLED'
        ? `${providerPayload.flightNumber} cancelled`
        : `${providerPayload.flightNumber} delayed ${providerPayload.delayMinutes || 0} min`,
    status: 'DETECTED',
  };
}

/** Apply the airline's operational change onto the ticketed itinerary. */
export function applyDisruptionToTrip(trip, disruption) {
  const segment = trip.segments.find((s) => s.id === disruption.segmentId);
  if (!segment) return trip;

  if (disruption.type === 'FLIGHT_CANCELLED') {
    segment.status = 'CANCELLED';
    segment.disruption = {
      type: disruption.type,
      reason: disruption.reason,
      remark: disruption.remark,
      detectedAt: disruption.detectedAt,
    };
  } else {
    const revisedDeparture = disruption.providerPayload.revisedDeparture;
    const revisedArrival = disruption.providerPayload.revisedArrival;
    segment.status = 'DELAYED';
    segment.delayMinutes = disruption.providerPayload.delayMinutes;
    segment.disruption = {
      type: disruption.type,
      reason: disruption.reason,
      remark: disruption.remark,
      detectedAt: disruption.detectedAt,
      previousDeparture: segment.departure.scheduled,
      previousArrival: segment.arrival.scheduled,
    };
    if (revisedDeparture) {
      const day = segment.departure.scheduled;
      segment.departure.estimated = toIstIso(addMinutes(day, 0)).replace(/T.+/, `T${revisedDeparture}:00+05:30`);
    }
    if (revisedArrival) {
      const day = segment.arrival.scheduled;
      segment.arrival.estimated = toIstIso(addMinutes(day, 0)).replace(/T.+/, `T${revisedArrival}:00+05:30`);
    }
  }
  trip.status = 'DISRUPTED';
  trip.state = { ...(trip.state || {}), phase: 'IMPACT_ANALYSIS', activeDisruptionId: disruption.id };
  return trip;
}

/**
 * Impact analysis — the arithmetic behind "what happens next".
 */
export function analyzeImpact({ trip, disruption, constraints, hotel }) {
  // Once a recovery has replaced the affected leg the disruption is no longer on
  // the live itinerary — analyse against the baseline so the explanation of what
  // broke stays available (and stays stable) after the recovery completes.
  const replaced = !trip.segments.some((s) => s.id === disruption.segmentId);
  const analysisTrip =
    replaced && trip.baseline?.segments?.length
      ? { segments: trip.baseline.segments, hotel: trip.baseline.hotel || hotel }
      : { segments: trip.segments, hotel };
  const segments = analysisTrip.segments;
  const analysisHotel = analysisTrip.hotel || hotel;

  const brokenSegment = segments.find((s) => s.id === disruption.segmentId) || segments[0];
  const downstream = segments.filter((s) => s.sequence > brokenSegment.sequence);
  const originalArrival = segments[segments.length - 1].arrival.scheduled;
  const analysedAgainst = replaced ? 'baseline' : 'current';

  const affectedSegments = [
    {
      segmentId: brokenSegment.id,
      flightNumber: brokenSegment.flightNumber,
      route: `${brokenSegment.from.code} → ${brokenSegment.to.code}`,
      effect: disruption.type === 'FLIGHT_CANCELLED' ? 'CANCELLED' : 'DELAYED',
      detail:
        disruption.type === 'FLIGHT_CANCELLED'
          ? `${brokenSegment.flightNumber} will not operate. ${disruption.reason}.`
          : `${brokenSegment.flightNumber} now arrives ${hhmm(brokenSegment.arrival.estimated)} — ${disruption.providerPayload.delayMinutes} min late.`,
    },
    ...downstream.map((segment) => ({
      segmentId: segment.id,
      flightNumber: segment.flightNumber,
      route: `${segment.from.code} → ${segment.to.code}`,
      effect: 'AT_RISK',
      detail: `${segment.flightNumber} is ticketed as the connection.`,
    })),
  ];

  let connection = downstream.length
    ? evaluateConnection(brokenSegment, downstream[0], { minimumConnectionMinutes: constraints.minimumConnectionMinutes })
    : null;

  if (connection && disruption.type === 'FLIGHT_CANCELLED') {
    connection = {
      ...connection,
      viable: false,
      status: 'MISSED',
      riskLabel: 'Connection broken',
      shortfallMinutes: connection.shortfallMinutes ?? null,
      reason: `${brokenSegment.flightNumber} is cancelled, so ${downstream[0].flightNumber} cannot be boarded from this itinerary.`,
    };
  }

  if (connection) {
    const target = affectedSegments.find((s) => s.segmentId === downstream[0].id);
    target.effect = connection.viable ? 'PROTECTED' : 'MISSED';
    target.detail = connection.viable
      ? `${downstream[0].flightNumber} remains reachable — ${connection.bufferMinutes} min of buffer.`
      : `${downstream[0].flightNumber} departs ${hhmm(connection.outboundDeparture)} but you cannot board before ${hhmm(connection.earliestBoardableDeparture)}. Shortfall: ${connection.shortfallMinutes} min.`;
  }

  const itineraryConnections = evaluateItineraryConnections(
    segments.map((s) => ({
      ...s,
      arrival: { ...s.arrival, estimated: s.arrival.estimated || s.arrival.scheduled },
      departure: { ...s.departure, estimated: s.departure.estimated || s.departure.scheduled },
    })),
    constraints.minimumConnectionMinutes,
  );

  // Hotel impact is derived from the *current* best-case arrival at Mumbai.
  const projectedArrival = disruption.type === 'FLIGHT_CANCELLED'
    ? null
    : segments[segments.length - 1].arrival.estimated;
  const projectedHotelArrival = projectedArrival
    ? addMinutes(projectedArrival, hotel.airportTransferMinutes)
    : null;
  const hotelImpact = {
    property: analysisHotel.name,
    previousArrival: analysisHotel.checkIn.scheduled,
    previousHotelArrival: analysisHotel.checkIn.current,
    holdUntil: analysisHotel.checkIn.holdUntil,
    projectedHotelArrival: projectedHotelArrival ? toIstIso(projectedHotelArrival) : null,
    impact: projectedArrival
      ? diffMinutes(projectedHotelArrival, hotel.checkIn.current) > 15
        ? 'UPDATE_REQUIRED'
        : 'MONITOR'
      : 'UPDATE_REQUIRED',
    detail:
      disruption.type === 'FLIGHT_CANCELLED'
        ? `Room booked from ${hhmm(analysisHotel.checkIn.scheduled)}. The replacement itinerary decides the new arrival time — TravelGuard will confirm it with the property.`
        : `You are now expected at ${hhmm(projectedHotelArrival)} instead of ${hhmm(analysisHotel.checkIn.current)}. Room held until ${hhmm(analysisHotel.checkIn.holdUntil)}.`,
  };

  const downstreamNotes = [
    disruption.type === 'FLIGHT_CANCELLED'
      ? `${brokenSegment.flightNumber} will not operate — ${String(disruption.reason).toLowerCase()}.`
      : `${brokenSegment.flightNumber} now arrives ${hhmm(brokenSegment.arrival.estimated)}, ${disruption.providerPayload.delayMinutes} min behind schedule.`,
    downstream.length
      ? disruption.type === 'FLIGHT_CANCELLED'
        ? `${downstream[0].flightNumber} departs ${downstream[0].from.code} at ${hhmm(downstream[0].departure.scheduled)} and can no longer be reached on the original ticket.`
        : connection?.viable
          ? `Connection at ${downstream[0].from.code} still works: ${connection.bufferMinutes} min of buffer above the ${constraints.minimumConnectionMinutes} min minimum.`
          : `Connection at ${downstream[0].from.code} is broken: arrival + ${constraints.minimumConnectionMinutes} min minimum connection = ${hhmm(connection.earliestBoardableDeparture)}, after ${downstream[0].flightNumber} departs at ${hhmm(connection.outboundDeparture)}.`
      : 'No onward connection on this itinerary.',
    `${analysisHotel.name} check-in at ${hhmm(analysisHotel.checkIn.current)} will shift with the new arrival time.`,
    'Wardrobe, seat and meal preferences are carried over to any replacement service.',
    ...(replaced
      ? ['This file is analysed against the original ticketed itinerary — the live itinerary has already been recovered.']
      : []),
  ];


  const severity = disruption.type === 'FLIGHT_CANCELLED'
    ? 'HIGH'
    : connection && !connection.viable
      ? 'HIGH'
      : 'MEDIUM';

  return {
    severity,
    analysedAgainst,
    analysedAt: toIstIso(new Date()),
    headline:
      disruption.type === 'FLIGHT_CANCELLED'
        ? `${disruption.flightNumber} has been cancelled — your journey needs a new plan.`
        : `${disruption.flightNumber} is running ${disruption.providerPayload.delayMinutes} min late.`,
    summary:
      disruption.type === 'FLIGHT_CANCELLED'
        ? `The ${brokenSegment.from.code} → ${brokenSegment.to.code} leg will not operate because of ${String(disruption.reason).toLowerCase()}. ${downstream.length ? `Your ${downstream[0].flightNumber} connection at ${downstream[0].from.code} cannot be protected on the original ticket.` : ''}`
        : `The delay pushes your arrival at ${brokenSegment.to.code} to ${hhmm(brokenSegment.arrival.estimated)}, which breaks the ${constraints.minimumConnectionMinutes}-minute minimum connection time for ${downstream[0]?.flightNumber}.`,
    affectedSegments,
    itineraryConnections,
    connection: connection
      ? {
          ...connection,
          inbound: {
            flightNumber: brokenSegment.flightNumber,
            from: brokenSegment.from.code,
            to: brokenSegment.to.code,
            estimatedArrival: brokenSegment.arrival.estimated,
          },
          outbound: {
            flightNumber: downstream[0]?.flightNumber,
            from: downstream[0]?.from.code,
            to: downstream[0]?.to.code,
            departure: downstream[0]?.departure.scheduled,
            arrival: downstream[0]?.arrival.scheduled,
          },
        }
      : null,
    hotelImpact,
    downstreamNotes,
    affectedPassengers: trip.passengers.length,
    commercialImpact: {
      ticketValueAtRisk: formatInr(segments.reduce((sum, s) => sum + (s.fare?.amount || 0), 0)),
      hotelNightAtRisk: formatInr(hotel.ratePerNight),
      commitment: trip.subtitle,
    },
    originalArrival: toIstIso(originalArrival),
  };
}
