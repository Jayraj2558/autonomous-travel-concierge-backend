import { formatInr } from '../utils/money.js';
import { duration, hhmm, diffMinutes } from '../utils/time.js';
import { getAirport } from '../domain/airports.js';
import { evaluateOptionConnection } from './connection.js';

/**
 * Deterministic policy engine.
 *
 * The AI layer never decides what is allowed — it only explains what this
 * engine already proved. Every rule below returns a PASS / WARN / FAIL with the
 * exact requirement and the exact observed value so the "Why this decision?"
 * panel can show real audit output rather than prose.
 *
 *   hard failure  → option is INELIGIBLE
 *   soft failure  → option is ELIGIBLE_WITH_APPROVAL (human in the loop)
 *   no failures   → option is ELIGIBLE for autonomous rebooking
 */

const STATUS = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };

const rule = (input) => ({
  status: STATUS.PASS,
  severity: 'soft',
  group: 'POLICY',
  ...input,
});

/**
 * Effective constraints = corporate policy (hard floor) + traveler preferences
 * (personal layer). Where a traveler preference is stricter than policy, the
 * stricter value wins; the source of each number is reported back.
 */
export function resolveConstraints({ policy, preferences, trip }) {
  const t = policy.thresholds || {};
  const cabin = preferences.cabin || trip.cabin || 'economy';

  const maxAdditionalFare = Math.min(
    Number(preferences.maxAdditionalFare ?? Infinity),
    Number(t.maxAdditionalFare ?? Infinity),
  );
  const maxArrivalDelayMinutes = Math.min(
    Number(preferences.maxAcceptableDelayMinutes ?? Infinity),
    Number(t.maxArrivalDelayMinutes ?? Infinity),
  );

  return {
    cabin,
    requireSameCabin: preferences.requireSameCabin !== false,
    maxAdditionalFare: Number.isFinite(maxAdditionalFare) ? maxAdditionalFare : 1500,
    absoluteFareCeiling: Number(t.absoluteFareCeiling ?? 3500),
    maxArrivalDelayMinutes: Number.isFinite(maxArrivalDelayMinutes) ? maxArrivalDelayMinutes : 180,
    approvalDelayToleranceMinutes: Number(t.approvalDelayToleranceMinutes ?? 60),
    minimumConnectionMinutes: Number(t.minimumConnectionMinutes ?? 45),
    minimumDepartureBufferMinutes: Number(t.minimumDepartureBufferMinutes ?? 45),
    maxStopsForAutoRebook: Number(
      Math.min(Number(t.maxStopsForAutoRebook ?? 1), Number(preferences.maxStops ?? 1)),
    ),
    allowedAirlines: policy.allowedAirlines || [],
    preferredAirlines: preferences.preferredAirlines || [],
    avoidedAirlines: preferences.avoidAirlines || [],
    hotelHoldUntil: t.hotelHoldUntil || '02:00',
    allowCabinUpgrade: Boolean(t.allowCabinUpgrade),
    allowCabinDowngrade: Boolean(t.allowCabinDowngrade),
    sources: {
      maxAdditionalFare:
        Number(preferences.maxAdditionalFare ?? Infinity) <= Number(t.maxAdditionalFare ?? Infinity)
          ? 'traveler preference'
          : 'corporate policy',
      maxArrivalDelayMinutes:
        Number(preferences.maxAcceptableDelayMinutes ?? Infinity) <= Number(t.maxArrivalDelayMinutes ?? Infinity)
          ? 'traveler preference'
          : 'corporate policy',
      minimumConnectionMinutes: 'airport + airline MCT',
      absoluteFareCeiling: 'corporate policy',
    },
  };
}

/** Stops/via summary for an option's legs. */
export function stopSummary(legs) {
  const totalStops = legs.reduce((sum, leg) => sum + (leg.stops || 0), 0);
  const vias = legs.flatMap((leg) => leg.via || []);
  return {
    totalStops,
    vias,
    label: totalStops === 0 ? 'Non-stop' : `${totalStops} stop${totalStops > 1 ? 's' : ''}`,
    detail: totalStops === 0 ? 'No intermediate stop' : `via ${vias.map((v) => getAirport(v).code).join(' · ')}`,
  };
}

/**
 * Evaluate one candidate recovery option against the effective constraints.
 * Returns the option decorated with a full `eligibility` audit record.
 */
export function evaluateOption(option, context) {
  const { constraints: c, policy, preferences, originalArrival, planningTime, hotel } = context;
  const legs = option.legs;
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  const airlines = [...new Set(legs.map((l) => l.airline))];
  const stops = stopSummary(legs);
  const arrival = lastLeg.arrival.scheduled;
  const arrivalDelayMinutes = diffMinutes(arrival, originalArrival);
  const departureBufferMinutes = diffMinutes(firstLeg.departure.scheduled, planningTime);
  const connection = evaluateOptionConnection(legs, c.minimumConnectionMinutes);
  const hotelArrival = new Date(new Date(arrival).getTime() + (hotel?.airportTransferMinutes || 20) * 60000);
  const seatMinimum = Math.min(...legs.map((l) => l.seatsAvailable ?? 0));

  const rules = [];

  // ---------------------------------------------------------------- feasibility
  rules.push(
    rule({
      code: 'FEA-01',
      group: 'FEASIBILITY',
      label: 'Departure still boardable',
      requirement: `≥ ${c.minimumDepartureBufferMinutes} min before departure`,
      actual: `${departureBufferMinutes} min before ${firstLeg.flightNumber} departs ${hhmm(firstLeg.departure.scheduled)}`,
      status: departureBufferMinutes >= c.minimumDepartureBufferMinutes ? STATUS.PASS : STATUS.FAIL,
      severity: 'hard',
      detail:
        departureBufferMinutes >= c.minimumDepartureBufferMinutes
          ? `You can still be checked in and cleared for ${hhmm(firstLeg.departure.scheduled)}.`
          : `Airline check-in for ${firstLeg.flightNumber} closes inside the ${c.minimumDepartureBufferMinutes}-minute boarding cutoff.`,
    }),
  );

  rules.push(
    rule({
      code: 'AVL-01',
      group: 'FEASIBILITY',
      label: 'Seats in your cabin',
      requirement: `≥ 1 seat in ${c.cabin}`,
      actual: seatMinimum > 0 ? `${seatMinimum} seats available` : 'No seats bookable',
      status: seatMinimum > 0 ? STATUS.PASS : STATUS.FAIL,
      severity: 'hard',
      detail:
        seatMinimum > 0
          ? `${seatMinimum} ${c.cabin} seat${seatMinimum > 1 ? 's' : ''} held with the airline inventory.`
          : 'The airline inventory shows no bookable seat in your cabin for this service.',
    }),
  );

  rules.push(
    rule({
      code: 'CON-01',
      group: 'FEASIBILITY',
      label: 'Connection time at transit',
      requirement: `≥ ${c.minimumConnectionMinutes} min layover`,
      actual: connection
        ? `${connection.minimumLayoverMinutes} min layover at ${connection.checks[0].airport}`
        : 'Direct — no connection',
      status: connection ? connection.status : STATUS.PASS,
      severity: 'hard',
      detail: connection
        ? connection.checks.map((chk) => chk.detail).join(' ')
        : 'No intermediate connection is required on this option.',
    }),
  );

  // Layovers inside a multi-stop service (spec: connection maths applies to
  // every change of aircraft, not just the ones between ticketed segments).
  const stopLegs = legs.filter((leg) => (leg.stops || 0) > 0);
  if (stopLegs.length) {
    stopLegs.forEach((leg) => {
      const through = Boolean(leg.throughFlight);
      const layover = leg.viaLayoverMinutes;
      const ok = through || (typeof layover === 'number' && layover >= c.minimumConnectionMinutes);
      rules.push(
        rule({
          code: 'CON-03',
          group: 'FEASIBILITY',
          label: `En-route stop at ${leg.via?.length ? getAirport(leg.via[0]).code : 'transit'}`,
          requirement: through ? 'through flight — no minimum applies' : `≥ ${c.minimumConnectionMinutes} min layover`,
          actual: through ? 'same aircraft, through service' : `${layover ?? 'unknown'} min layover`,
          status: ok ? STATUS.PASS : STATUS.FAIL,
          severity: 'hard',
          detail: through
            ? `${leg.flightNumber} is a through flight: the aircraft continues to destination, so no minimum connection time applies at the intermediate stop.`
            : ok
              ? `${layover} min at ${getAirport(leg.via[0]).code} — ${layover - c.minimumConnectionMinutes} min above the ${c.minimumConnectionMinutes} min minimum.`
              : `Only ${layover} min at ${getAirport(leg.via[0]).code}; the ${c.minimumConnectionMinutes} min minimum connection time cannot be met if the aircraft changes.`,
        }),
      );
    });
  }

  // The traveler keeps their original inbound flight: the replacement must be
  // boardable after arrival + minimum connection time (spec §12).
  if (option.usesOriginalInbound && context.retainedInbound) {
    const retained = context.retainedInbound;
    const inboundArrival = retained.arrival.estimated || retained.arrival.scheduled;
    const earliestBoardable = new Date(
      new Date(inboundArrival).getTime() + c.minimumConnectionMinutes * 60000,
    );
    const departsAt = firstLeg.departure.scheduled;
    const feasible = new Date(departsAt).getTime() >= earliestBoardable.getTime();
    rules.push(
      rule({
        code: 'CON-02',
        group: 'FEASIBILITY',
        label: 'Departs after the inbound connection minimum',
        requirement: `departure ≥ ${hhmm(earliestBoardable)}`,
        actual: `departs ${hhmm(departsAt)}`,
        status: feasible ? STATUS.PASS : STATUS.FAIL,
        severity: 'hard',
        detail: feasible
          ? `${retained.flightNumber} arrives ${hhmm(inboundArrival)}; adding the ${c.minimumConnectionMinutes} min minimum connection allows boarding from ${hhmm(earliestBoardable)} and this service leaves ${hhmm(departsAt)}.`
          : `${retained.flightNumber} arrives ${hhmm(inboundArrival)}. Arrival + ${c.minimumConnectionMinutes} min minimum connection = ${hhmm(earliestBoardable)}, which is after ${option.label} departs at ${hhmm(departsAt)} — this connection cannot be flown.`,
      }),
    );
  }

  // -------------------------------------------------------------------- policy
  rules.push(
    rule({
      code: 'POL-01',
      group: 'POLICY',
      label: 'Airline inside travel policy',
      requirement: `${c.allowedAirlines.join(', ')} approved`,
      actual: airlines.map((a) => a).join(' + '),
      status: airlines.every((a) => c.allowedAirlines.includes(a)) ? STATUS.PASS : STATUS.FAIL,
      severity: 'hard',
      detail: `${policy.name} v${policy.version} approves ${c.allowedAirlines.join(', ')} for domestic legs.`,
    }),
  );

  rules.push(
    rule({
      code: 'POL-02',
      group: 'POLICY',
      label: 'Cabin class preserved',
      requirement: c.requireSameCabin ? `${c.cabin} only` : 'Any cabin',
      actual: legs.map((l) => l.cabin).join(' + '),
      status:
        !c.requireSameCabin || legs.every((l) => l.cabin === c.cabin) ? STATUS.PASS : STATUS.FAIL,
      severity: 'hard',
      detail:
        !c.requireSameCabin || legs.every((l) => l.cabin === c.cabin)
          ? `All replacement legs stay in ${c.cabin}; your seat and baggage allowance carry across.`
          : 'A cabin change is not permitted on an autonomous rebooking under this policy.',
    }),
  );

  rules.push(
    rule({
      code: 'POL-03',
      group: 'POLICY',
      label: 'Fare inside hard ceiling',
      requirement: `≤ ${formatInr(c.absoluteFareCeiling)} extra`,
      actual: formatInr(option.addedFare),
      status: option.addedFare <= c.absoluteFareCeiling ? STATUS.PASS : STATUS.FAIL,
      severity: 'hard',
      detail:
        option.addedFare <= c.absoluteFareCeiling
          ? 'Fare difference is inside the maximum the policy will ever absorb.'
          : `Fare difference exceeds the ${formatInr(c.absoluteFareCeiling)} hard ceiling the policy permits.`,
    }),
  );

  rules.push(
    rule({
      code: 'POL-04',
      group: 'POLICY',
      label: 'Arrival maintains the itinerary',
      requirement: `≤ ${c.maxArrivalDelayMinutes} min delay`,
      actual: `${arrivalDelayMinutes <= 0 ? '' : '+'}${arrivalDelayMinutes} min vs original 23:50 arrival`,
      status:
        arrivalDelayMinutes <= c.maxArrivalDelayMinutes
          ? STATUS.PASS
          : arrivalDelayMinutes <= c.maxArrivalDelayMinutes + c.approvalDelayToleranceMinutes
            ? STATUS.WARN
            : STATUS.FAIL,
      severity: arrivalDelayMinutes <= c.maxArrivalDelayMinutes + c.approvalDelayToleranceMinutes ? 'soft' : 'hard',
      blocking: arrivalDelayMinutes > c.maxArrivalDelayMinutes,
      detail:
        arrivalDelayMinutes <= 0
          ? `Lands at ${hhmm(arrival)} — earlier than your original ${hhmm(originalArrival)} arrival.`
          : `Lands at ${hhmm(arrival)}, ${arrivalDelayMinutes} min later than planned; your hotel is only ${hotel?.airportTransferMinutes || 20} min from the terminal.`,
    }),
  );

  // --------------------------------------------------------------- preferences
  rules.push(
    rule({
      code: 'PRF-01',
      group: 'PREFERENCE',
      label: 'Fare within your allowance',
      requirement: `≤ ${formatInr(c.maxAdditionalFare)} extra`,
      actual: formatInr(option.addedFare),
      status: option.addedFare <= c.maxAdditionalFare ? STATUS.PASS : STATUS.WARN,
      severity: 'soft',
      blocking: option.addedFare > c.maxAdditionalFare,
      detail:
        option.addedFare <= c.maxAdditionalFare
          ? `Inside the ${formatInr(c.maxAdditionalFare)} you allow without asking.`
          : `Above the ${formatInr(c.maxAdditionalFare)} you set — TravelGuard will ask before spending.`,
    }),
  );

  rules.push(
    rule({
      code: 'PRF-02',
      group: 'PREFERENCE',
      label: 'Airline preference',
      requirement: c.preferredAirlines.length ? `${c.preferredAirlines.join(', ')} preferred` : 'No preference',
      actual: airlines.join(' + '),
      status: airlines.some((a) => c.avoidedAirlines.includes(a))
        ? STATUS.WARN
        : airlines.every((a) => c.preferredAirlines.includes(a))
          ? STATUS.PASS
          : STATUS.WARN,
      severity: 'soft',
      // A carrier on the traveler's avoid list always needs a human decision;
      // simply sitting outside the preferred list is only a scoring penalty.
      blocking: airlines.some((a) => c.avoidedAirlines.includes(a)),
      detail: airlines.some((a) => c.avoidedAirlines.includes(a))
        ? `${airlines.join(', ')} is on your avoid list — TravelGuard will not book this without asking.`
        : airlines.every((a) => c.preferredAirlines.includes(a))
          ? `${airlines.join(', ')} is on your preferred list and inside policy.`
          : `${airlines.join(', ')} is approved by policy but outside your preferred list.`,
    }),
  );

  rules.push(
    rule({
      code: 'PRF-03',
      group: 'PREFERENCE',
      label: 'Non-stop preference',
      requirement: stops.totalStops === 0 ? 'Non-stop' : `≤ ${c.maxStopsForAutoRebook} stop`,
      actual: stops.label,
      status: stops.totalStops === 0 ? STATUS.PASS : stops.totalStops <= c.maxStopsForAutoRebook ? STATUS.WARN : STATUS.FAIL,
      severity: stops.totalStops <= c.maxStopsForAutoRebook ? 'soft' : 'hard',
      blocking: stops.totalStops > c.maxStopsForAutoRebook,
      detail: stops.detail,
    }),
  );

  rules.push(
    rule({
      code: 'HTL-01',
      group: 'PREFERENCE',
      label: 'Hotel arrival inside hold window',
      requirement: `room held until ${c.hotelHoldUntil}`,
      actual: `reach hotel ${hhmm(hotelArrival)}`,
      status: diffMinutes(hotelArrival, new Date(`2026-09-25T${c.hotelHoldUntil}:00+05:30`)) <= 0 ? STATUS.PASS : STATUS.WARN,
      severity: 'soft',
      blocking: false, // the property hold is extended automatically

      detail:
        diffMinutes(hotelArrival, new Date(`2026-09-25T${c.hotelHoldUntil}:00+05:30`)) <= 0
          ? `${hotel?.name || 'Hotel'} holds the room until ${c.hotelHoldUntil}; you arrive ${hhmm(hotelArrival)}.`
          : `${hotel?.name || 'Hotel'} hold ends at ${c.hotelHoldUntil} and you reach at ${hhmm(hotelArrival)} — the hold will be extended automatically.`,
    }),
  );

  const hardFailures = rules.filter((r) => r.status === STATUS.FAIL && r.severity === 'hard');
  const warnings = rules.filter((r) => r.status !== STATUS.PASS && r.blocking === false);
  const softFailures = rules.filter(
    (r) => r.status !== STATUS.PASS && r.severity !== 'hard' && r.blocking !== false,
  );

  const fit = fitScore({ option, constraints: c, stops, arrivalDelayMinutes, rules });
  const status = hardFailures.length
    ? 'INELIGIBLE'
    : softFailures.length
      ? 'ELIGIBLE_WITH_APPROVAL'
      : 'ELIGIBLE';

  return {
    ...option,
    stops: stops.totalStops,
    stopsLabel: stops.label,
    stopsDetail: stops.detail,
    cabin: legs[0].cabin,
    airlines,
    arrivalDelayMinutes,
    hotelArrival: hotelArrival.toISOString(),
    connection,
    eligibility: {
      status,
      fitScore: fit.score,
      scoreBreakdown: fit.breakdown,
      rules,
      hardFailures: hardFailures.map((r) => r.code),
      softFailures: softFailures.map((r) => r.code),
      warnings: warnings.map((r) => r.code),
      summary:
        status === 'ELIGIBLE'
          ? 'Clears every policy and preference rule — eligible for autonomous rebooking.'
          : status === 'ELIGIBLE_WITH_APPROVAL'
            ? `Needs your approval: ${softFailures.map((r) => r.label.toLowerCase()).join(', ')}.`
            : `Not bookable: ${hardFailures.map((r) => r.label.toLowerCase()).join(', ')}.`,
      highlights: highlights({ option, rules, stops, airlines, arrivalDelayMinutes, constraints: c, policy, connection }),
    },
  };
}

/** Transparent, weighted fit score — the number the decision layer ranks on. */
function fitScore({ option, constraints: c, stops, arrivalDelayMinutes, rules }) {
  const breakdown = [];
  let score = 100;

  const farePenalty = option.addedFare === 0 ? 0 : Math.min(18, 6 + (option.addedFare / Math.max(1, c.maxAdditionalFare)) * 10);
  if (farePenalty) breakdown.push({ label: 'Additional fare', points: -Math.round(farePenalty) });
  score -= farePenalty;

  const stopPenalty = stops.totalStops === 0 ? 0 : 8 * stops.totalStops;
  if (stopPenalty) breakdown.push({ label: 'Stops', points: -stopPenalty });
  score -= stopPenalty;

  if (arrivalDelayMinutes <= 0) {
    const bonus = Math.min(8, Math.abs(arrivalDelayMinutes) / 12);
    breakdown.push({ label: 'Arrives earlier than planned', points: Math.round(bonus) });
    score += bonus;
  } else {
    const penalty = Math.min(14, arrivalDelayMinutes / 12);
    breakdown.push({ label: 'Arrival delay', points: -Math.round(penalty) });
    score -= penalty;
  }

  const onTime = option.onTimeScore ?? 0.85;
  const reliabilityPenalty = Math.round((1 - onTime) * 24);
  if (reliabilityPenalty) breakdown.push({ label: 'On-time reliability', points: -reliabilityPenalty });
  score -= reliabilityPenalty;

  const airlineRule = rules.find((r) => r.code === 'PRF-02');
  if (airlineRule?.status === 'WARN' && !airlineRule.detail.includes('avoid list')) {
    breakdown.push({ label: 'Outside preferred airlines', points: -6 });
    score -= 6;
  }

  const hotelRule = rules.find((r) => r.code === 'HTL-01');
  if (hotelRule?.status === 'WARN') {
    breakdown.push({ label: 'Hotel hold needs extending', points: -4 });
    score -= 4;
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown };
}

/**
 * The five checks the decision panel shows, in the order a traveler reads them.
 */
function highlights({ option, rules, stops, airlines, arrivalDelayMinutes, constraints: c, policy, connection }) {
  const policyRules = rules.filter((r) => r.group === 'POLICY');
  const policyOk = policyRules.every((r) => r.status === 'PASS');
  const preferred = airlines.every((a) => c.preferredAirlines.includes(a)) && !airlines.some((a) => c.avoidedAirlines.includes(a));

  return [
    {
      label: 'Within travel policy',
      detail: `Meets ${policy.name} v${policy.version} — ${c.cabin} cabin, ${formatInr(c.maxAdditionalFare)} fare allowance.`,
      status: policyOk ? STATUS.PASS : 'WARN',
    },
    {
      label: stops.totalStops === 0 ? 'Non-stop' : `${stops.label} (max ${c.maxStopsForAutoRebook})`,
      detail: stops.detail,
      status: stops.totalStops === 0 ? STATUS.PASS : stops.totalStops <= c.maxStopsForAutoRebook ? STATUS.WARN : 'FAIL',
    },
    {
      label: connection ? 'Connection protected' : 'Direct to destination',
      detail: connection
        ? `${connection.minimumLayoverMinutes} min layover at ${connection.checks[0].airport}, ${connection.minimumLayoverMinutes - c.minimumConnectionMinutes} min above the ${c.minimumConnectionMinutes} min minimum.`
        : `Lands directly at ${option.legs[option.legs.length - 1].to.code} — no connection to protect.`,
      status: connection ? connection.status : STATUS.PASS,
    },
    {
      label: option.addedFare === 0 ? 'No additional fare' : `${formatInr(option.addedFare)} additional fare`,
      detail:
        option.addedFare === 0
          ? 'Original ticket value accepted by the airline — no extra cost to you or the corporate account.'
          : `Inside the ${formatInr(c.maxAdditionalFare)} allowance you configured.`,
      status: option.addedFare <= c.maxAdditionalFare ? STATUS.PASS : 'WARN',
    },
    {
      label: 'Matches traveler preference',
      detail: preferred
        ? `${airlines.join(' + ')} is on your preferred list; cabin, seat preference and meal request carry across.`
        : `${airlines.join(' + ')} is policy-approved but outside your preferred list.`,
      status: preferred ? STATUS.PASS : 'WARN',
    },
  ].concat(
    arrivalDelayMinutes <= 0
      ? [
          {
            label: 'Arrives earlier than planned',
            detail: `Reaches Mumbai at ${hhmm(option.legs[option.legs.length - 1].arrival.scheduled)}, ${Math.abs(arrivalDelayMinutes)} min ahead of the original itinerary.`,
            status: STATUS.PASS,
          },
        ]
      : [],
  );
}

/**
 * Rank every evaluated option and produce the decision.
 *   AUTO_REBOOK        — a clean, fully compliant option exists
 *   APPROVAL_REQUIRED  — only options that break a *soft* rule exist
 *   MANUAL_INTERVENTION— nothing is bookable automatically
 */
export function decide(evaluatedOptions, context) {
  const duration10 = (m) => duration(m);

  const ranked = [...evaluatedOptions].sort((a, b) => {
    const order = { ELIGIBLE: 0, ELIGIBLE_WITH_APPROVAL: 1, INELIGIBLE: 2 };
    if (order[a.eligibility.status] !== order[b.eligibility.status]) {
      return order[a.eligibility.status] - order[b.eligibility.status];
    }
    if (b.eligibility.fitScore !== a.eligibility.fitScore) return b.eligibility.fitScore - a.eligibility.fitScore;
    return a.addedFare - b.addedFare;
  });

  const eligible = ranked.filter((o) => o.eligibility.status === 'ELIGIBLE');
  const approval = ranked.filter((o) => o.eligibility.status === 'ELIGIBLE_WITH_APPROVAL');
  const selected = eligible[0] || null;
  const bestApproval = approval[0] || null;

  const decision = selected
    ? 'AUTO_REBOOK'
    : bestApproval
      ? 'APPROVAL_REQUIRED'
      : 'MANUAL_INTERVENTION';
  const noCompliantOption = !selected;
  const manualInterventionRecommended = !selected;

  const reasons = [];
  reasons.push(
    `${ranked.length} alternative${ranked.length === 1 ? '' : 's'} evaluated against ${context.policy.name} v${context.policy.version} and your ${context.preferences.preferredAirlines.join('/')} preference.`,
  );
  reasons.push(`${eligible.length} cleared every rule, ${approval.length} need approval, ${ranked.length - eligible.length - approval.length} are not bookable.`);
  if (selected) {
    reasons.push(
      `${selected.label} ranks first with a fit score of ${selected.eligibility.fitScore}/100 — ${selected.stopsLabel.toLowerCase()}, ${selected.addedFare === 0 ? 'no additional fare' : `${formatInr(selected.addedFare)} extra`}, total journey time ${duration10(selected.totalDurationMinutes)}.`,
    );
  }
  if (!selected && bestApproval) {
    reasons.push(
      `No option clears every rule. Best available is ${bestApproval.label}, which needs your approval because ${bestApproval.eligibility.softFailures.length} soft constraint${bestApproval.eligibility.softFailures.length === 1 ? '' : 's'} would be exceeded.`,
    );
  }
  if (!selected && !bestApproval) {
    reasons.push(
      'Every available service today breaks at least one hard rule (fare ceiling, cabin, seat availability or connection time). A human travel desk will take over with the full audit trail attached.',
    );
  }

  return {
    decision,
    decisionLabel: selected
      ? 'Autonomous rebooking approved'
      : bestApproval
        ? 'No policy-compliant alternative — traveler approval required'
        : 'No compliant or approvable option — manual intervention required',
    noCompliantOption,
    manualInterventionRecommended,
    selected,
    bestApproval,
    ranked,
    eligibleCount: eligible.length,
    approvalCount: approval.length,
    ineligibleCount: ranked.length - eligible.length - approval.length,
    reasons,
    evaluatedAt: new Date().toISOString(),
  };
}
