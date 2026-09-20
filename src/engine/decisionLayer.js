import { generateNarrative } from '../services/ai.js';
import { formatInr } from '../utils/money.js';
import { duration, hhmm } from '../utils/time.js';
import { getAirport } from '../domain/airports.js';

/**
 * AI Decision Layer.
 *
 * The decision itself (which option, and whether it may be booked without a
 * human) was already taken by the deterministic policy engine. This layer turns
 * that decision plus its audit trail into language a traveler can act on, and
 * records exactly which facts the narration was allowed to use.
 */
export async function buildDecisionNarrative({
  trip,
  disruption,
  impact,
  search,
  policy,
  preferences,
  hotel,
  scenario,
}) {
  const { decision } = search;
  const selected = decision.selected;
  const bestApproval = decision.bestApproval;

  const counterfactuals = decision.ranked
    .filter((option) => option.id !== selected?.id && option.id !== bestApproval?.id)
    .slice(0, 4)
    .map((option) => ({
      optionId: option.id,
      label: option.label,
      route: option.legs.map((l) => `${l.from.code} → ${l.to.code}`).join(' · '),
      arrival: hhmm(option.legs[option.legs.length - 1].arrival.scheduled),
      addedFare: option.addedFare,
      fitScore: option.eligibility.fitScore,
      verdict: option.eligibility.status,
      why: option.eligibility.summary,
      failedRules: option.eligibility.rules
        .filter((r) => r.status !== 'PASS')
        .map((r) => ({ code: r.code, label: r.label, requirement: r.requirement, actual: r.actual, status: r.status })),
    }));

  const buildFacts = () => ({
    decision: decision.decision,
    disruption: {
      type: disruption.type,
      flight: disruption.flightNumber,
      route: disruption.route,
      reason: disruption.reason,
      severity: disruption.severity,
    },
    selectedOption: selected
      ? {
          flights: selected.label,
          itinerary: selected.legs.map((l) => `${l.flightNumber} ${l.from.code} ${hhmm(l.departure.scheduled)} → ${l.to.code} ${hhmm(l.arrival.scheduled)}`),
          stops: selected.stopsLabel,
          addedFare: formatInr(selected.addedFare),
          cabin: selected.cabin,
          fitScore: selected.eligibility.fitScore,
          arrival: hhmm(selected.legs[selected.legs.length - 1].arrival.scheduled),
          arrivalDelayMinutes: selected.arrivalDelayMinutes,
          connectionBufferMinutes: selected.connection?.minimumLayoverMinutes ?? null,
          hotelArrival: hhmm(selected.hotelArrival),
        }
      : null,
    bestApprovalOption: bestApproval
      ? {
          flights: bestApproval.label,
          addedFare: formatInr(bestApproval.addedFare),
          arrival: hhmm(bestApproval.legs[bestApproval.legs.length - 1].arrival.scheduled),
          softFailures: bestApproval.eligibility.rules.filter((r) => r.status !== 'PASS').map((r) => r.label),
        }
      : null,
    policy: {
      name: `${policy.name} v${policy.version}`,
      maxAdditionalFare: formatInr(search.constraints?.maxAdditionalFare ?? 1500),
      maxArrivalDelayMinutes: search.constraints?.maxArrivalDelayMinutes ?? 180,
      minConnectionMinutes: search.constraints?.minimumConnectionMinutes ?? 45,
    },
    traveler: {
      preferredAirlines: preferences.preferredAirlines,
      cabin: preferences.cabin,
      autoRebook: preferences.autoRebook,
    },
    hotel: { name: hotel.name, checkIn: hhmm(hotel.checkIn.current), holdUntil: hhmm(hotel.checkIn.holdUntil) },
    eligibleOptions: decision.eligibleCount,
    approvalOptions: decision.approvalCount,
    ineligibleOptions: decision.ineligibleCount,
    confidence: decision.decision === 'AUTO_REBOOK' ? 0.96 : decision.decision === 'APPROVAL_REQUIRED' ? 0.88 : 0.82,
  });

  const facts = buildFacts();
  const fallback =
    decision.decision === 'AUTO_REBOOK'
      ? autoRebookNarration({ selected, trip, hotel, impact, search })
      : decision.decision === 'APPROVAL_REQUIRED'
        ? approvalNarration({ bestApproval, hotel, search })
        : manualNarration({ search, impact, disruption });

  const narrative = await generateNarrative({
    facts,
    fallback:
      fallback.summary +
      (fallback.extra ? ` ${fallback.extra}` : ''),
  });

  const bullets =
    decision.decision === 'AUTO_REBOOK'
      ? [
          `${selected.label} — ${selected.legs.map((l) => `${l.from.code}→${l.to.code} ${hhmm(l.departure.scheduled)}`).join(', ')}.`,
          `Arrives Mumbai ${hhmm(selected.legs[selected.legs.length - 1].arrival.scheduled)}${selected.arrivalDelayMinutes <= 0 ? `, ${Math.abs(selected.arrivalDelayMinutes)} min ahead of your original plan` : `, ${selected.arrivalDelayMinutes} min later than planned`}.`,
          `${selected.addedFare === 0 ? 'No additional fare' : `${formatInr(selected.addedFare)} extra, inside your ${formatInr(search.constraints.maxAdditionalFare)} allowance`} — booked on ${selected.legs[0].airline} inventory, ${selected.cabin} cabin preserved.`,
          `Hotel arrival moves to ${hhmm(selected.hotelArrival)}; ${hotel.name} is being updated automatically.`,
          `Total journey time ${duration(selected.totalDurationMinutes)} with a fit score of ${selected.eligibility.fitScore}/100.`,
        ]
      : decision.decision === 'APPROVAL_REQUIRED'
        ? [
            `No option clears every rule without a human decision.`,
            `Closest option: ${bestApproval.label}, arriving ${hhmm(bestApproval.legs[bestApproval.legs.length - 1].arrival.scheduled)}, ${formatInr(bestApproval.addedFare)} extra.`,
            ...bestApproval.eligibility.rules
              .filter((r) => r.status !== 'PASS')
              .map((r) => `${r.label}: ${r.actual} (needs ${r.requirement}).`),
            `Seats are held for ${bestApproval.holdMinutes || 24} minutes while you decide.`,
          ]
        : [
            `All ${decision.ranked.length} available services break at least one hard rule today.`,
            ...impact.downstreamNotes.slice(0, 2),
            `Best available seat: ${bestApproval.label} at ${formatInr(bestApproval.addedFare)} extra (above the ${formatInr(search.constraints.absoluteFareCeiling)} hard ceiling).`,
            `A human travel desk case is being raised with the full audit trail attached.`,
          ];

  const policyTrace = (selected || bestApproval)?.eligibility.rules.map((r) => ({
    code: r.code,
    group: r.group,
    label: r.label,
    requirement: r.requirement,
    actual: r.actual,
    status: r.status,
    detail: r.detail,
  }));

  return {
    decision: decision.decision,
    headline:
      decision.decision === 'AUTO_REBOOK'
        ? `Rebook onto ${selected.headlineFlight} — the itinerary is protected`
        : decision.decision === 'APPROVAL_REQUIRED'
          ? 'Approval required for the only workable alternative'
          : 'No policy-compliant alternative — escalating to a human desk',
    summary: narrative.text,
    bullets,
    counterfactuals,
    policyTrace,
    whySelected: (selected || bestApproval)?.eligibility.highlights || [],
    fitScore: (selected || bestApproval)?.eligibility.fitScore ?? null,
    confidence: narrative.confidence,
    generatedBy: narrative.generatedBy,
    mode: narrative.mode,
    latencyMs: narrative.latencyMs,
    facts,
    signature: `Decision taken ${new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })} IST · ${policy.name} v${policy.version} · ${decision.eligibleCount} eligible / ${decision.approvalCount} approval / ${decision.ineligibleCount} rejected`,
    scenarioId: scenario?.id,
  };
}

function autoRebookNarration({ selected, trip, hotel, impact, search }) {
  const arrival = selected.legs[selected.legs.length - 1].arrival.scheduled;
  const connection = selected.connection;
  const parts = [];

  parts.push(
    `Flight ${selected.headlineFlight} was selected because it is inside ${search.constraints.cabin} travel policy, ${
      selected.addedFare === 0 ? 'carries no additional fare' : `adds only ${formatInr(selected.addedFare)}`
    } and preserves your ${selected.cabin} cabin.`,
  );
  if (selected.stops === 0) parts.push('It is a non-stop service, which matches your standing preference.');
  if (connection) {
    parts.push(
      `Your ${connection.checks[0].airport} connection is protected with ${connection.minimumLayoverMinutes} minutes of layover, ${connection.minimumLayoverMinutes - search.constraints.minimumConnectionMinutes} minutes above the airline minimum.`,
    );
  }
  parts.push(
    `You reach ${getAirport(selected.legs[selected.legs.length - 1].to.code).city} at ${hhmm(arrival)}, ${
      selected.arrivalDelayMinutes <= 0 ? `${Math.abs(selected.arrivalDelayMinutes)} minutes earlier than the original plan` : `${selected.arrivalDelayMinutes} minutes later than the original plan`
    }, and ${hotel.name} has been told you arrive at ${hhmm(selected.hotelArrival)}.`,
  );
  parts.push('Rebooking is running now — no action is needed from you.');

  return {
    summary: parts.join(' '),
    extra: `I compared ${search.decision.ranked.length} alternatives and rejected ${search.decision.ineligibleCount} that broke a hard rule.`,
  };
}

function approvalNarration({ bestApproval, hotel, search }) {
  const arrival = bestApproval.legs[bestApproval.legs.length - 1].arrival.scheduled;
  return {
    summary: `Every compliant option today is sold out or priced above policy, so I have not booked anything. ${
      bestApproval.label
    } is the best remaining service — it reaches Mumbai at ${hhmm(arrival)} for ${formatInr(
      bestApproval.addedFare,
    )} extra, which is above the ${formatInr(search.constraints.maxAdditionalFare)} you let me spend without asking. I have held ${
      bestApproval.legs[0].seatsAvailable
    } seats for 24 minutes; approve and I will rebook, update ${hotel.name} and send you the new boarding passes immediately.`,
    extra: `Policy reference ${search.policyName || 'Northwind Analytics'} — ${bestApproval.eligibility.softFailures.length} soft constraint(s) exceeded.`,
  };
}

function manualNarration({ search, impact, disruption }) {
  return {
    summary: `Today's weather has removed most of the evening Delhi–Mumbai inventory, and everything still selling breaks a hard rule — either the ${formatInr(
      search.constraints.absoluteFareCeiling,
    )} fare ceiling, your cabin requirement or the minimum connection time. I will not override a policy limit on my own. Your options have been packaged with the full audit trail and sent to the Northwind travel desk, and I am holding the best available seat while they work. Meanwhile your ${disruption.flightNumber} ticket value of ${impact.commercialImpact.ticketValueAtRisk} stays refundable and protected.`,
    extra: `${search.decision.ranked.length} services evaluated, ${search.decision.ineligibleCount} rejected, ${search.decision.approvalCount} awaiting approval.`,
  };
}
