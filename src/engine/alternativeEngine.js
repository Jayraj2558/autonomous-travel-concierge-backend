import { searchFlights } from '../mocks/flightSearchProvider.js';
import { evaluateOption, decide } from './policyEngine.js';
import { addMinutes, diffMinutes, toIstIso } from '../utils/time.js';
import { getAirport } from '../domain/airports.js';
import { formatInr } from '../utils/money.js';

/**
 * Alternative Flight Engine.
 *
 * 1. Works out which ticketed segments are no longer flyable.
 * 2. Shops every remaining service on those routes (mock GDS/Navitaire).
 * 3. Pairs inbound replacements with outbound replacements.
 * 4. Hands each complete option to the deterministic policy engine.
 */

const OPTION_HOLD_MINUTES = 45;

/** A feeder is only useful if it can still be boarded and connects legally. */
function annotateFeeder(feeder, { planningTime, minimumDepartureBufferMinutes, minimumConnectionMinutes, connectionDeparture }) {
  const departureBufferMinutes = diffMinutes(feeder.departure.scheduled, planningTime);
  const boardable = departureBufferMinutes >= minimumDepartureBufferMinutes;
  const latestDelArrival = connectionDeparture
    ? addMinutes(connectionDeparture, -minimumConnectionMinutes)
    : null;
  const cushionMinutes = latestDelArrival ? diffMinutes(latestDelArrival, feeder.arrival.scheduled) : null;
  const connects = cushionMinutes === null ? true : cushionMinutes >= 0;

  let reason = null;
  if (!boardable) {
    reason = `Departs ${formatClock(feeder.departure.scheduled)} — inside the ${minimumDepartureBufferMinutes}-minute boarding cutoff.`;
  } else if (!connects) {
    reason = `Reaches Delhi ${formatClock(feeder.arrival.scheduled)}, after the ${formatClock(latestDelArrival)} latest check-in for the connection.`;
  } else if (feeder.seatsAvailable <= 0) {
    reason = feeder.inventoryNote || 'No bookable seat in Economy.';
  }

  return {
    ...feeder,
    boardable,
    connects,
    cushionMinutes,
    departureBufferMinutes,
    usable: boardable && connects && feeder.seatsAvailable > 0,
    unavailableReason: reason,
  };
}

const formatClock = (value) => {
  const date = new Date(value);
  const ist = new Date(date.getTime() + 330 * 60000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * Choose the inbound replacement that protects the connection best: enough
 * cushion to be safe, but not so early that the traveler loses the day.
 */
function pickFeeder(feeders, { preferredAirlines }) {
  const usable = feeders.filter((f) => f.usable);
  if (!usable.length) return null;
  const scored = usable.map((feeder) => {
    const cushion = feeder.cushionMinutes;
    const cushionScore = cushion >= 45 && cushion <= 120 ? 30 : cushion < 45 ? cushion / 3 : Math.max(0, 30 - (cushion - 120) / 6);
    const airlineScore = preferredAirlines.includes(feeder.airline) ? 18 : 6;
    const reliabilityScore = (feeder.onTimeScore || 0.8) * 20;
    const seatsScore = Math.min(10, (feeder.seatsAvailable || 0) * 2);
    return { feeder, score: cushionScore + airlineScore + reliabilityScore + seatsScore };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].feeder;
}

export async function searchAlternatives({
  trip,
  disruption,
  constraints,
  policy,
  preferences,
  hotel,
  scenarioId,
  planningTime,
  silent = false,
}) {
  const startedAt = new Date();
  const inboundSegment = trip.segments[0];
  const outboundSegment = trip.segments[trip.segments.length - 1];

  // Only a *cancellation* of the first leg removes it from the plan. A delay
  // keeps the flight but breaks the connection, so only the onward leg is re-planned.
  const inboundBroken =
    disruption.type === 'FLIGHT_CANCELLED' && inboundSegment && disruption.segmentId === inboundSegment.id;
  const retainedInbound = inboundBroken ? null : inboundSegment;

  const queries = [];
  const providers = [];

  // ------------------------------------------------ search the outbound route
  const outboundSearch = await searchFlights({
    from: outboundSegment.from.code,
    to: outboundSegment.to.code,
    afterIso: planningTime.toISOString(),
    cabin: constraints.cabin,
    scenarioId,
    travelDate: trip.startDate,
    silent,
  });
  providers.push(outboundSearch.meta.provider);
  queries.push({
    label: `${outboundSegment.from.code} → ${outboundSegment.to.code} alternatives`,
    provider: outboundSearch.meta.provider,
    resultCount: outboundSearch.data.results.length,
    latencyMs: outboundSearch.meta.latencyMs,
  });

  // ------------------------------------------- search the inbound route too
  // Always shopped: even when the inbound still operates, the engine checks
  // whether an earlier arrival could rescue the original connection.
  const inboundSearch = await searchFlights({
    from: inboundSegment.from.code,
    to: inboundSegment.to.code,
    afterIso: planningTime.toISOString(),
    cabin: constraints.cabin,
    scenarioId,
    travelDate: trip.startDate,
    silent,
  });
  providers.push(inboundSearch.meta.provider);
  queries.push({
    label: `${inboundSegment.from.code} → ${inboundSegment.to.code} ${inboundBroken ? 're-accommodation' : 'earlier-arrival check'}`,
    provider: inboundSearch.meta.provider,
    resultCount: inboundSearch.data.results.length,
    latencyMs: inboundSearch.meta.latencyMs,
  });
  const feeders = inboundSearch.data.results;

  const originalArrival = new Date(trip.segments[trip.segments.length - 1].arrival.scheduled);
  const evaluated = [];

  for (const connection of outboundSearch.data.results) {
    const connectionDeparture = new Date(connection.departure.scheduled);
    const annotateCtx = {
      planningTime,
      minimumDepartureBufferMinutes: constraints.minimumDepartureBufferMinutes,
      minimumConnectionMinutes: constraints.minimumConnectionMinutes,
      connectionDeparture,
    };

    // Inbound replacement(s) for this specific connection.
    const annotatedFeeders = feeders.map((f) => annotateFeeder(f, annotateCtx));
    const feeder = inboundBroken ? pickFeeder(annotatedFeeders, constraints) : null;

    const retainedSegments = inboundBroken ? [] : [inboundSegment.id];
    const legs = [
      ...(feeder ? [toLeg(feeder)] : []),
      toLeg(connection),
    ];

    const firstDeparture = new Date(legs[0].departure.scheduled);
    const lastArrival = new Date(legs[legs.length - 1].arrival.scheduled);
    const addedFare = legs.reduce((sum, l) => sum + (l.fareDifference || 0), 0);

    const option = {
      id: `opt_${legs.map((l) => l.flightNumber.replace(/\s/g, '').toLowerCase()).join('_')}`,
      label: legs.map((l) => l.flightNumber).join(' + '),
      headlineFlight: legs[legs.length - 1].flightNumber,
      legs,
      feeder: feeder || null,
      replacesSegments: [...(feeder ? [trip.segments[0].id] : []), outboundSegment.id],
      retainedSegments,
      usesOriginalInbound: !inboundBroken,
      originalConnection: Boolean(connection.original),
      containsOriginalService: Boolean(connection.original) || legs.some((l) => l.id === 'c_ai721'),
      addedFare,
      currency: 'INR',
      totalDurationMinutes: diffMinutes(lastArrival, firstDeparture),
      arrival: toIstIso(lastArrival),
      arrivalDelayMinutes: diffMinutes(lastArrival, originalArrival),
      seatsAvailable: Math.min(...legs.map((l) => l.seatsAvailable)),
      onTimeScore: Math.min(...legs.map((l) => l.onTimeScore || 0.85)),
      cabin: legs[0].cabin,
      provider: outboundSearch.meta.provider,
      holdExpiresAt: toIstIso(addMinutes(planningTime, OPTION_HOLD_MINUTES)),
      holdMinutes: OPTION_HOLD_MINUTES,
      feasibilityNotes: [
        ...(feeder
          ? [
              {
                label: `${feeder.flightNumber} re-accommodation`,
                detail: `Departure ${formatClock(feeder.departure.scheduled)} gives ${feeder.departureBufferMinutes} min before boarding closes.`,
                status: feeder.boardable ? 'PASS' : 'FAIL',
              },
              {
                label: `${connection.from.code} connection cushion`,
                detail: `${feeder.cushionMinutes} min above the ${constraints.minimumConnectionMinutes} min minimum connection time.`,
                status: feeder.cushionMinutes >= 0 ? 'PASS' : 'FAIL',
              },
            ]
          : [
              {
                label: 'Inbound service retained',
                detail: `${inboundSegment.flightNumber} still operates${inboundSegment.status === 'DELAYED' ? ` (delayed to ${formatClock(inboundSegment.arrival.estimated)})` : ''}; only the broken onward connection is re-planned.`,
                status: 'PASS',
              },
            ]),
      ],
    };

    evaluated.push(
      evaluateOption(option, {
        constraints,
        policy,
        preferences,
        originalArrival,
        planningTime,
        hotel,
        retainedInbound: option.usesOriginalInbound ? retainedInbound : null,
      }),
    );
  }

  const decision = decide(evaluated, { constraints, policy, preferences, hotel });

  // Every inbound service the engine looked at, so the traveler can see that an
  // earlier arrival was genuinely checked before the connection was re-planned.
  const inboundConsidered = feeders.map((feeder) =>
    annotateFeeder(feeder, {
      planningTime,
      minimumDepartureBufferMinutes: constraints.minimumDepartureBufferMinutes,
      minimumConnectionMinutes: constraints.minimumConnectionMinutes,
      connectionDeparture: decision.selected?.legs?.[decision.selected.legs.length - 1]?.departure?.scheduled
        ? new Date(decision.selected.legs[decision.selected.legs.length - 1].departure.scheduled)
        : new Date(outboundSearch.data.results[0]?.departure.scheduled || planningTime),
    }),
  ).sort((a, b) => new Date(a.departure.scheduled) - new Date(b.departure.scheduled));

  const completedAt = new Date();
  return {
    search: {
      startedAt: toIstIso(startedAt),
      completedAt: toIstIso(completedAt),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      providers,
      queries,
      optionsConsidered: evaluated.length,
      servicesConsidered: outboundSearch.data.servicesConsidered + inboundSearch.data.servicesConsidered,
      inboundChecked: !inboundBroken,
      inboundBroken,
      planningTime: toIstIso(planningTime),
      holdMinutes: OPTION_HOLD_MINUTES,
    },
    options: evaluated,
    decision,
    inboundConsidered,
    originalArrival: originalArrival.toISOString(),
    outboundRoute: `${outboundSegment.from.code} → ${outboundSegment.to.code}`,
    inboundRoute: `${inboundSegment.from.code} → ${inboundSegment.to.code}`,
  };
}

/**
 * Re-score an existing option set — used when the traveler changes preferences
 * or when the policy engine is queried directly. No provider calls are made.
 */
export function reevaluate(options, context) {
  const evaluated = options.map((option) =>
    evaluateOption(
      { ...option, eligibility: undefined },
      context,
    ),
  );
  const decision = decide(evaluated, context);
  return { options: evaluated, decision };
}

/** Map a searched service onto the leg shape the policy engine understands. */
function toLeg(service) {
  return {
    id: service.id,
    flightNumber: service.flightNumber,
    airline: service.airline,
    aircraft: service.aircraft,
    from: { code: service.from.code, city: service.from.city, name: service.from.name },
    to: { code: service.to.code, city: service.to.city, name: service.to.name },
    departure: {
      scheduled: toIstIso(service.departure.scheduled),
      estimated: toIstIso(service.departure.estimated),
      terminal: service.from.terminal,
    },
    arrival: {
      scheduled: toIstIso(service.arrival.scheduled),
      estimated: toIstIso(service.arrival.estimated),
      terminal: service.to.terminal,
    },
    durationMinutes: service.durationMinutes,
    stops: service.stops,
    via: service.via,
    viaDetail: service.viaDetail || null,
    viaLayoverMinutes: service.viaLayoverMinutes ?? null,
    throughFlight: Boolean(service.throughFlight),
    original: Boolean(service.original),
    cabin: service.cabin,
    seatsAvailable: service.seatsAvailable,
    fareDifference: service.fareDifference,
    currency: service.currency,
    onTimeScore: service.onTimeScore,
    inventorySource: service.inventorySource,
    inventoryNote: service.inventoryNote,
    cabinNote: service.cabinNote,
    baggageAllowanceKg: service.airline === 'AI' ? 25 : service.airline === 'UK' ? 20 : 15,
    status: service.seatsAvailable > 0 ? 'SCHEDULED' : 'WAITLIST',
  };
}

export { formatClock, OPTION_HOLD_MINUTES };
export const airportName = (code) => getAirport(code).name;
export const money = formatInr;
