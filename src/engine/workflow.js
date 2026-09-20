import { store } from '../domain/store.js';
import { clock, addMinutes, diffMinutes, hhmm, toIstIso, duration } from '../utils/time.js';
import { depth as deepCopy } from '../utils/clone.js';
import { sleep, id } from '../utils/random.js';
import { fetchFlightStatus } from '../mocks/flightStatusProvider.js';
import { createBooking, holdBooking } from '../mocks/flightBookingProvider.js';
import { checkAvailability } from '../mocks/flightSearchProvider.js';
import { updateArrival } from '../mocks/hotelProvider.js';
import { buildDisruption, applyDisruptionToTrip, analyzeImpact } from './disruptionEngine.js';
import { searchAlternatives } from './alternativeEngine.js';
import { resolveConstraints } from './policyEngine.js';
import { buildDecisionNarrative } from './decisionLayer.js';
import { getScenario } from '../domain/scenarios.js';
import { formatInr, formatDelta } from '../utils/money.js';
import { getAirport } from '../domain/airports.js';
import { notify } from '../services/notifications.js';
import { emit, broadcastWorkflow, broadcastStage, broadcastTripState, broadcastAgentEvent, broadcastMetrics } from '../services/realtime.js';
import { computeMetrics } from '../services/metrics.js';
import { logger } from '../utils/logger.js';

const log = logger.child('workflow');
const STAGE_DELAY = Number(process.env.DEMO_STAGE_MS || 640);
const runs = new Map();

const STAGE_TEMPLATE = [
  { key: 'DETECTED', title: 'Disruption detected', description: 'Airline ops feed is matched against the ticketed itinerary.' },
  { key: 'IMPACT', title: 'Impact analysis', description: 'Which legs, connections and hotel nights are affected — and how much time is left.' },
  { key: 'SEARCH', title: 'Searching alternatives', description: 'Live shopping across carrier and GDS inventory.' },
  { key: 'POLICY', title: 'Policy evaluation', description: 'Airline eligibility, fare, cabin, connection time and traveler preferences.' },
  { key: 'DECISION', title: 'Decision', description: 'The best eligible option is selected and explained.' },
  { key: 'REBOOK', title: 'Rebooking', description: 'Availability re-check, seat hold and ticket reissue.' },
  { key: 'HOTEL', title: 'Hotel adjustment', description: 'The property is told the new arrival time.' },
  { key: 'NOTIFY', title: 'Traveler notified', description: 'Confirmation pushed to every enabled channel.' },
];

const stage = (template) => ({
  ...template,
  status: 'PENDING',
  startedAt: null,
  completedAt: null,
  durationMs: null,
  summary: null,
  facts: [],
  items: [],
  providerCalls: [],
});

const stat = (label, value, tone = 'neutral') => ({ label, value, tone });
const item = (title, detail, status = 'DONE', meta) => ({ title, detail, status, meta });

/** Timeline + broadcast for a single operational event. */
function agentEvent(trip, { type, level, title, detail, actor }) {
  const event = store.addEvent({
    tripId: trip.id,
    at: toIstIso(clock.now()),
    type,
    level,
    title,
    detail,
    actor: actor || 'Recovery Orchestrator',
    workflowId: trip.state?.workflowId,
  });
  broadcastAgentEvent(event);
  return event;
}

export function getWorkflow(tripId) {
  return store.getWorkflow(tripId);
}

export function cancelRun(tripId) {
  const run = runs.get(tripId);
  if (run) {
    run.cancelled = true;
    runs.delete(tripId);
    log.info(`cancelled in-flight recovery for ${tripId}`);
  }
}

/** Restore the ticketed itinerary so each demo run starts from the same state. */
export function restoreBaseline(trip) {
  if (!trip.baseline) return trip;
  trip.segments = deepCopy(trip.baseline.segments);
  trip.hotel = deepCopy(trip.baseline.hotel);
  trip.status = 'ON_TRACK';
  trip.state = { activeDisruptionId: null, phase: 'MONITORING', recoveryOptionId: null, workflowId: null };
  return trip;
}

async function executeStage(workflow, key, runner) {
  const target = workflow.stages.find((s) => s.key === key);
  if (!target) return;
  if (workflow.cancelled) return;

  target.status = 'RUNNING';
  target.startedAt = new Date().toISOString();
  broadcastStage(workflow.id, target, workflow);
  await sleep(STAGE_DELAY);

  const result = await runner();
  if (workflow.cancelled) return;

  target.status = result?.status || 'DONE';
  target.completedAt = new Date().toISOString();
  target.durationMs = new Date(target.completedAt) - new Date(target.startedAt);
  target.summary = result?.summary || null;
  target.facts = result?.facts || [];
  target.items = result?.items || [];
  target.providerCalls = result?.providerCalls || [];
  broadcastStage(workflow.id, target, workflow);
  broadcastWorkflow(workflow);
  return result;
}

/**
 * Start the full autonomous recovery pipeline for a scenario.
 */
/**
 * Wipes everything a previous run left behind for this trip so a scenario can be
 * replayed without stale bookings, hotel updates or case files leaking into the
 * new recovery.
 */
function resetSimulationState(trip) {
  const state = store.snapshot();
  state.disruptions = state.disruptions.filter((entry) => entry.tripId !== trip.id);
  state.bookings = state.bookings.filter((entry) => entry.tripId !== trip.id);
  state.hotelUpdates = state.hotelUpdates.filter((entry) => entry.tripId !== trip.id);
  state.manualCases = state.manualCases.filter((entry) => entry.tripId !== trip.id);
  delete state.workflows[trip.id];
  state.metrics.alternativesEvaluated = 0;
  state.metrics.detectionMs = [];
  state.metrics.recoveryMs = [];
  state.demo = { ...(state.demo || {}), scenario: trip.state?.scenarioId || state.demo?.scenario || null };
}

export async function startScenarioRun({ scenarioId, tripId, triggeredBy = 'Demo Mode' }) {
  const trip = store.getTrip(tripId) || store.activeTrip();
  const scenario = getScenario(scenarioId);
  if (!scenario) throw Object.assign(new Error(`Unknown scenario ${scenarioId}`), { status: 400 });

  cancelRun(trip.id);
  resetSimulationState(trip);
  restoreBaseline(trip);

  // Deterministic demo clock: every scenario is planned from the same moment.
  clock.reset();
  const planningTime = clock.now();

  const run = { cancelled: false, id: id('run') };
  runs.set(trip.id, run);

  const preferences = store.getPreferences(trip.travelerId);
  const policy = store.getPolicy(trip.policyId);
  const constraints = resolveConstraints({ policy, preferences, trip });

  const workflow = {
    id: id('wf'),
    tripId: trip.id,
    scenarioId,
    scenarioName: scenario.name,
    triggeredBy,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    decision: null,
    stages: STAGE_TEMPLATE.map(stage),
    plan: [],
    disruption: null,
    impact: null,
    search: null,
    narrative: null,
    booking: null,
    hotelUpdate: null,
    notification: null,
    holdOffer: null,
    metrics: {},
    constraints,
    planningTime: toIstIso(planningTime),
  };

  trip.state = { ...(trip.state || {}), phase: 'DETECTING', workflowId: workflow.id, activeDisruptionId: null };
  store.saveWorkflow(trip.id, workflow);
  broadcastWorkflow(workflow);
  broadcastTripState({ trip, workflow });

  const startedWallClock = Date.now();

  // Scenario prelude — the operational chatter that precedes a disruption.
  agentEvent(trip, {
    type: 'MONITORING',
    level: 'info',
    title: `${scenario.name} drill started`,
    detail: `${triggeredBy} triggered "${scenario.tagline}". TravelGuard is re-checking every monitored item.`,
    actor: 'Demo Mode',
  });

  // -------------------------------------------------------------- 1 detection
  const detectionStart = Date.now();
  const firstSegment = trip.segments[0];
  const statusResult = await fetchFlightStatus({
    flightNumber: firstSegment.flightNumber,
    travelDate: trip.startDate,
    scenarioId,
  });

  const disruption = buildDisruption({
    trip,
    scenarioId,
    providerPayload: statusResult.data,
    detectedAt: toIstIso(clock.now()),
  });
  const detectionMs = Date.now() - detectionStart;
  disruption.detectedInMs = detectionMs;

  applyDisruptionToTrip(trip, disruption);
  store.addDisruption(disruption);
  trip.state.activeDisruptionId = disruption.id;
  store.recordDetection(detectionMs);
  store.state.metrics.flightsMonitored = Math.max(store.state.metrics.flightsMonitored, trip.segments.length);

  workflow.disruption = disruption;
  workflow.decisionLabel = scenario.expectedDecision;
  workflow.metrics.detectionMs = detectionMs;
  store.saveWorkflow(trip.id, workflow);

  emit('disruption:detected', { disruption, trip, workflow });
  broadcastTripState({ trip, workflow });
  agentEvent(trip, {
    type: 'DISRUPTION',
    level: 'critical',
    title: disruption.title,
    detail: `${disruption.flightNumber} · ${disruption.route} · ${disruption.reason}. ${disruption.remark || ''}`.trim(),
    actor: 'Disruption Detector',
  });

  await notify({
    trip,
    level: 'critical',
    category: 'DISRUPTION',
    priority: 'urgent',
    title: `${disruption.flightNumber} has been ${disruption.type === 'FLIGHT_CANCELLED' ? 'cancelled' : 'delayed'} — TravelGuard has taken over`,
    body:
      disruption.type === 'FLIGHT_CANCELLED'
        ? `${disruption.reason}. No action needed: we are re-planning your journey now.`
        : `${disruption.reason}. We are checking your Delhi connection and will rebook automatically if it breaks.`,
    action: { label: 'Track the recovery', href: '/disruptions' },
  });

  await executeStage(workflow, 'DETECTED', async () => ({
    summary: `${disruption.flightNumber} ${disruption.type === 'FLIGHT_CANCELLED' ? 'cancelled' : 'delayed'} · detected ${(detectionMs / 1000).toFixed(1)}s after the airline notification`,
    facts: [
      stat('Source', statusResult.data.provider),
      stat('Disruption code', disruption.disruptionCode),
      stat('Reason', disruption.reason, 'warn'),
      stat('Detection time', `${(detectionMs / 1000).toFixed(1)} s`, 'good'),
      stat('Confidence', `${Math.round(disruption.confidence * 100)}%`),
      stat('Provider latency', `${statusResult.meta.latencyMs} ms`),
    ],
    items: [
      item(`${disruption.flightNumber} · ${disruption.route}`, disruption.remark || 'Operational irregularity', 'ALERT'),
      item('Cross-check', 'Status verified against airline inventory before any rebooking is attempted.', 'DONE'),
    ],
    providerCalls: [{ provider: statusResult.meta.provider, latencyMs: statusResult.meta.latencyMs, status: 'OK' }],
  }));

  if (run.cancelled) return workflow;

  // ------------------------------------------------------------- 2 impact analysis
  const impact = analyzeImpact({ trip, disruption, constraints, hotel: trip.hotel });
  workflow.impact = impact;
  trip.state.phase = 'IMPACT_ANALYSIS';
  store.saveWorkflow(trip.id, workflow);
  broadcastTripState({ trip, workflow });

  agentEvent(trip, {
    type: 'IMPACT',
    level: 'warning',
    title: 'Impact analysis complete',
    detail: impact.downstreamNotes[0] + (impact.connection ? ` ${impact.connection.reason}` : ''),
    actor: 'Impact Analyzer',
  });

  await executeStage(workflow, 'IMPACT', async () => ({
    summary: impact.headline,
    facts: [
      stat('Severity', impact.severity, 'warn'),
      stat('Affected segments', String(impact.affectedSegments.length), 'warn'),
      ...(impact.connection
        ? [
            stat('Connection verdict', impact.connection.riskLabel, impact.connection.viable ? 'good' : 'bad'),
            stat('Buffer / shortfall', impact.connection.viable ? `${impact.connection.bufferMinutes} min buffer` : `${impact.connection.shortfallMinutes} min short`, impact.connection.viable ? 'good' : 'bad'),
          ]
        : []),
      stat('Hotel impact', impact.hotelImpact.impact.replace('_', ' ').toLowerCase(), 'warn'),
      stat('Ticket value protected', impact.commercialImpact.ticketValueAtRisk),
    ],
    items: [
      ...impact.affectedSegments.map((s) =>
        item(`${s.flightNumber} · ${s.route}`, s.detail, s.effect === 'PROTECTED' ? 'DONE' : 'ALERT', s.effect),
      ),
      ...(impact.connection
        ? impact.connection.steps.map((s) => item(`${s.label}`, `${s.value} · ${s.source}`, 'INFO'))
        : []),
    ],
  }));

  if (run.cancelled) return workflow;

  // --------------------------------------------------------- 3 alternative search
  trip.state.phase = 'SEARCHING';
  const search = await searchAlternatives({
    trip,
    disruption,
    constraints,
    policy,
    preferences,
    hotel: trip.hotel,
    scenarioId,
    planningTime,
  });
  search.constraints = constraints;
  search.policyName = policy.name;
  workflow.search = search;
  store.saveWorkflow(trip.id, workflow);
  store.state.metrics.alternativesEvaluated += search.options.length;
  broadcastTripState({ trip, workflow });

  agentEvent(trip, {
    type: 'SEARCH',
    level: 'info',
    title: `${search.options.length} recovery options assembled`,
    detail: `Screened ${search.search.servicesConsidered} services across ${search.search.providers.length} providers in ${search.search.durationMs} ms.`,
    actor: 'Alternative Flight Engine',
  });

  await executeStage(workflow, 'SEARCH', async () => ({
    summary: `${search.search.servicesConsidered} services screened · ${search.options.length} complete itineraries assembled`,
    facts: [
      stat('Route', search.outboundRoute),
      ...(search.inboundRoute ? [stat('Re-accommodation', search.inboundRoute)] : []),
      stat('Providers queried', search.search.providers.length),
      stat('Search time', `${search.search.durationMs} ms`),
      stat('Options held until', hhmm(search.options[0]?.holdExpiresAt || planningTime)),
    ],
    items: [
      ...search.search.queries.map((q) => item(q.label, `${q.resultCount} services returned by ${q.provider} · ${q.latencyMs} ms`, 'DONE')),
      ...search.inboundConsidered.slice(0, 5).map((f) =>
        item(
          `${f.flightNumber} · ${f.from.code} → ${f.to.code} · ${hhmm(f.departure.scheduled)} → ${hhmm(f.arrival.scheduled)}`,
          f.usable
            ? `Usable — ${f.seatsAvailable} seats, ${f.cushionMinutes} min connection cushion at ${f.to.code}.`
            : f.unavailableReason || 'Not usable.',
          f.usable ? 'DONE' : 'REJECTED',
        ),
      ),
      ...search.options.map((o) =>
        item(
          o.label,
          `${o.legs.map((l) => `${l.from.code} ${hhmm(l.departure.scheduled)} → ${l.to.code} ${hhmm(l.arrival.scheduled)}`).join('  ·  ')} — ${duration(o.totalDurationMinutes)}, ${o.stopsLabel.toLowerCase()}, ${o.addedFare === 0 ? 'no extra fare' : formatInr(o.addedFare)} extra.`,
          'INFO',
        ),
      ),
    ],
    providerCalls: search.search.queries.map((q) => ({ provider: q.provider, latencyMs: q.latencyMs, status: 'OK' })),
  }));

  if (run.cancelled) return workflow;

  // ----------------------------------------------------------- 4 policy evaluation
  trip.state.phase = 'POLICY_CHECK';
  const { decision } = search;
  agentEvent(trip, {
    type: 'POLICY',
    level: decision.eligibleCount ? 'success' : 'warning',
    title: `Policy engine: ${decision.eligibleCount} eligible · ${decision.approvalCount} need approval · ${decision.ineligibleCount} rejected`,
    detail: `${decision.ranked.length} options evaluated against ${policy.name} v${policy.version} and your saved preferences.`,
    actor: 'Policy Engine',
  });

  await executeStage(workflow, 'POLICY', async () => ({
    summary: decision.reasons[1],
    facts: [
      stat('Policy', `${policy.name} v${policy.version}`),
      stat('Rules applied', String(decision.ranked[0]?.eligibility.rules.length || 0)),
      stat('Eligible', String(decision.eligibleCount), 'good'),
      stat('Need approval', String(decision.approvalCount), decision.approvalCount ? 'warn' : 'neutral'),
      stat('Ineligible', String(decision.ineligibleCount), decision.ineligibleCount ? 'bad' : 'neutral'),
      stat('Fare allowance', formatInr(constraints.maxAdditionalFare)),
      stat('Min connection', `${constraints.minimumConnectionMinutes} min`),
    ],
    items: decision.ranked.map((o) => ({
      title: `${o.label} · fit ${o.eligibility.fitScore}/100`,
      detail: `${o.eligibility.summary} ${o.eligibility.rules.filter((r) => r.status !== 'PASS').map((r) => `${r.code} ${r.label}: needs ${r.requirement}, observed ${r.actual}`).join(' · ') || 'All rules passed.'}`,
      status: o.eligibility.status,
      meta: { optionId: o.id, rules: o.eligibility.rules, fitScore: o.eligibility.fitScore, highlights: o.eligibility.highlights },
    })),
  }));

  if (run.cancelled) return workflow;

  // -------------------------------------------------------------- 5 decision
  const narrative = await buildDecisionNarrative({
    trip,
    disruption,
    impact,
    search,
    policy,
    preferences,
    hotel: trip.hotel,
    scenario,
  });
  workflow.narrative = narrative;
  workflow.decision = {
    decision: decision.decision,
    selectedOptionId: decision.selected?.id || null,
    approvalOptionId: decision.bestApproval?.id || null,
    fitScore: decision.selected?.eligibility.fitScore || decision.bestApproval?.eligibility.fitScore || null,
    reasons: decision.reasons,
  };
  store.saveWorkflow(trip.id, workflow);

  agentEvent(trip, {
    type: 'DECISION',
    level: decision.decision === 'AUTO_REBOOK' ? 'success' : 'warning',
    title:
      decision.decision === 'AUTO_REBOOK'
        ? `Decision: ${decision.selected.label}`
        : decision.decision === 'APPROVAL_REQUIRED'
          ? 'Decision: traveler approval required'
          : 'Decision: no compliant option — escalating',
    detail: narrative.summary,
    actor: 'AI Decision Layer',
  });

  await executeStage(workflow, 'DECISION', async () => ({
    summary: narrative.headline,
    facts: [
      stat('Verdict', decision.decision.replace(/_/g, ' '), decision.decision === 'AUTO_REBOOK' ? 'good' : 'warn'),
      ...(decision.selected
        ? [
            stat('Selected', decision.selected.label, 'good'),
            stat('Fit score', `${decision.selected.eligibility.fitScore}/100`, 'good'),
            stat('Arrival', hhmm(decision.selected.legs[decision.selected.legs.length - 1].arrival.scheduled)),
            stat('Additional fare', formatDelta(decision.selected.addedFare)),
          ]
        : []),
      stat('Narration', narrative.generatedBy),
      stat('Reasoning time', `${narrative.latencyMs} ms`),
    ],
    items: [
      item('Natural-language explanation', narrative.summary, 'AI'),
      ...narrative.bullets.map((b) => item('Evidence', b, 'INFO')),
      ...(decision.selected ? decision.selected.eligibility.highlights.map((h) => item(h.label, h.detail, h.status)) : []),
    ],
  }));

  if (run.cancelled) return workflow;

  // ------------------------------------------------ 6/7/8 act, or await approval
  if (decision.decision === 'AUTO_REBOOK' && preferences.autoRebook !== false) {
    await executeRecovery({ trip, workflow, option: decision.selected, scenarioId, constraints });
  } else {
    const offer = decision.bestApproval || decision.selected;
    const hold = offer ? await holdBooking({ option: offer, holdMinutes: 24 }) : null;
    workflow.holdOffer = hold
      ? {
          optionId: offer.id,
          label: offer.label,
          reference: hold.data.holdReference,
          expiresAt: hold.data.expiresAt,
          holdMinutes: hold.data.holdMinutes,
          addedFare: offer.addedFare,
        }
      : null;
    workflow.status = 'AWAITING_APPROVAL';
    trip.state.phase = 'AWAITING_APPROVAL';
    store.state.metrics.approvalsRequested += 1;

    const rebookStage = workflow.stages.find((s) => s.key === 'REBOOK');
    rebookStage.status = 'WAITING';
    rebookStage.summary = offer
      ? `${offer.label} held · awaiting your approval (${formatDelta(offer.addedFare)})`
      : 'Seat hold unavailable — manual intervention required';
    rebookStage.items = offer
      ? [
          item('Seat hold', `${hold?.data.holdReference} · ${offer.legs.map((l) => l.flightNumber).join(' + ')}`, 'WAITING'),
          item('Held until', hold ? hhmm(hold.data.expiresAt) : '—', 'INFO'),
          item('Why approval', offer.eligibility.summary, 'WARN'),
        ]
      : [];
    ['HOTEL', 'NOTIFY'].forEach((key) => {
      const s = workflow.stages.find((x) => x.key === key);
      s.status = 'PENDING';
      s.summary = 'Starts as soon as a booking exists.';
    });

    store.saveWorkflow(trip.id, workflow);
    broadcastWorkflow(workflow);
    broadcastTripState({ trip, workflow });
    broadcastStage(workflow.id, rebookStage, workflow);

    agentEvent(trip, {
      type: 'APPROVAL',
      level: 'warning',
      title: 'Awaiting traveler approval',
      detail: offer
        ? `${offer.label} held for ${hold?.data.holdMinutes || 24} minutes — ${formatDelta(offer.addedFare)}, outside auto-rebooking limits.`
        : 'No bookable option; travel desk will take over.',
      actor: 'Action Executor',
    });

    await notify({
      trip,
      level: 'warning',
      category: 'APPROVAL',
      priority: 'urgent',
      title: 'Your approval is needed to finish the recovery',
      body: offer
        ? `${offer.label} is held for you — ${formatDelta(offer.addedFare)} and arrives ${hhmm(offer.legs[offer.legs.length - 1].arrival.scheduled)}. Approve in the app and everything else happens automatically.`
        : 'We could not find a policy-compliant seat. The travel desk has been engaged.',
      action: { label: 'Review the offer', href: '/alternatives' },
    });

    workflow.completedAt = null;
    store.saveWorkflow(trip.id, workflow);
    runs.delete(trip.id);
    return workflow;
  }

  workflow.status = 'COMPLETED';
  workflow.completedAt = new Date().toISOString();
  workflow.metrics.recoveryMs = Date.now() - startedWallClock;
  store.recordRecovery(workflow.metrics.recoveryMs);
  store.saveWorkflow(trip.id, workflow);
  broadcastWorkflow(workflow);
  broadcastTripState({ trip, workflow });
  broadcastMetrics(computeMetrics(store.snapshot()));
  runs.delete(trip.id);
  log.info(`recovery completed for ${trip.id} in ${workflow.metrics.recoveryMs} ms`);
  return workflow;
}

/**
 * Stages 6 → 8: book the flight, tell the hotel, tell the traveler.
 * Shared by the autonomous path and the traveler-approval path.
 */
export async function executeRecovery({ trip, workflow, option, scenarioId, constraints, approval = null }) {
  const policy = store.getPolicy(trip.policyId);
  const preferences = store.getPreferences(trip.travelerId);
  const passenger = trip.passengers[0];

  // ----------------------------------------------------------------- rebooking
  trip.state.phase = 'REBOOKING';
  store.state.metrics.rebookingAttempts += 1;

  const availabilityResult = await checkAvailability({
    flightNumber: option.legs[option.legs.length - 1].flightNumber,
    cabin: option.cabin,
    scenarioId,
  });

  const bookingResult = await createBooking({
    trip,
    option,
    passenger,
    paymentReference: approval?.paymentReference,
  });
  const booking = bookingResult.data;
  workflow.booking = {
    ...booking,
    optionId: option.id,
    label: option.label,
    addedFare: option.addedFare,
    legs: option.legs,
    providerCalls: [availabilityResult.meta, bookingResult.meta],
    approvedBy: approval?.approvedBy || (approval ? 'Traveler approval in app' : 'Autonomous — inside policy'),
  };
  store.state.metrics.rebookingSuccesses += 1;
  store.addBooking({
    id: id('bkg'),
    tripId: trip.id,
    reference: booking.pnr,
    status: booking.status,
    createdAt: booking.issuedAt,
    optionId: option.id,
    label: option.label,
    addedFare: option.addedFare,
    segments: booking.segments,
    provider: booking.provider,
    approvedBy: workflow.booking.approvedBy,
  });

  // Rewrite the itinerary in place.
  const recoveredSegments = buildRecoveredSegments({ trip, option, booking, constraints });
  trip.segments = recoveredSegments;
  trip.status = 'RECOVERED';
  trip.state.recoveryOptionId = option.id;
  trip.state.phase = 'HOTEL_SYNC';
  trip.updatedAt = new Date().toISOString();

  emit('booking:created', { booking: workflow.booking, trip, workflow });
  broadcastTripState({ trip, workflow });

  agentEvent(trip, {
    type: 'BOOKING',
    level: 'success',
    title: `Rebooked on ${option.headlineFlight} · PNR ${booking.pnr}`,
    detail: `${option.legs.map((l) => `${l.flightNumber} ${l.from.code} ${hhmm(l.departure.scheduled)} → ${l.to.code} ${hhmm(l.arrival.scheduled)}`).join(' · ')}. ${booking.addedFare === 0 ? 'No additional fare.' : `${formatInr(option.addedFare)} charged to the corporate account.`}`,
    actor: 'Action Executor',
  });

  const rebookStage = workflow.stages.find((s) => s.key === 'REBOOK');
  Object.assign(rebookStage, {
    status: 'DONE',
    startedAt: rebookStage.startedAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: rebookStage.durationMs || 1800,
    summary: `PNR ${booking.pnr} · ${option.label} confirmed${option.addedFare ? ` · ${formatInr(option.addedFare)} charged` : ' · no additional fare'}`,
    facts: [
      stat('PNR', booking.pnr, 'good'),
      stat('Status', booking.status, 'good'),
      stat('Additional cost', formatDelta(option.addedFare), option.addedFare ? 'warn' : 'good'),
      stat('Paid by', booking.paidBy),
      stat('Approved by', workflow.booking.approvedBy),
      stat('Ticket reissued', `${bookingResult.meta.latencyMs} ms`),
    ],
    items: booking.segments.map((s) =>
      item(`${s.flightNumber} · ${s.from} → ${s.to}`, `${hhmm(s.departure)} → ${hhmm(s.arrival)} · seat ${s.seat} · ${s.cabin}${s.baggage ? ` · ${s.baggage}` : ''}`, 'CONFIRMED'),
    ),
    providerCalls: [
      { provider: availabilityResult.meta.provider, latencyMs: availabilityResult.meta.latencyMs, status: 'OK' },
      { provider: bookingResult.meta.provider, latencyMs: bookingResult.meta.latencyMs, status: 'OK' },
    ],
  });
  broadcastStage(workflow.id, rebookStage, workflow);
  broadcastWorkflow(workflow);

  // ------------------------------------------------------------ hotel adjustment
  const lastLeg = option.legs[option.legs.length - 1];
  const previousHotelArrival = trip.hotel.checkIn.current;
  const newHotelArrival = addMinutes(lastLeg.arrival.scheduled, trip.hotel.airportTransferMinutes);
  const hotelUpdateResult = await updateArrival({
    hotel: trip.hotel,
    newArrival: newHotelArrival,
    previousArrival: previousHotelArrival,
    reason: `${option.label} recovery after ${workflow.disruption?.flightNumber} ${workflow.disruption?.type === 'FLIGHT_CANCELLED' ? 'cancellation' : 'delay'}`,
  });
  const hotelUpdate = hotelUpdateResult.data;

  trip.hotel.checkIn.current = toIstIso(newHotelArrival);
  trip.hotel.checkIn.holdUntil = hotelUpdate.holdUntil;
  trip.hotel.status = 'CONFIRMED';
  trip.hotel.transferUpdated = true;
  trip.hotel.revision = {
    previousArrival: toIstIso(previousHotelArrival),
    newArrival: toIstIso(newHotelArrival),
    shiftedMinutes: diffMinutes(newHotelArrival, previousHotelArrival),
    reason: hotelUpdate.notes[0],
    at: hotelUpdate.syncedAt,
    provider: hotelUpdate.provider,
    holdExtended: hotelUpdate.holdExtended,
    approvedBy: hotelUpdate.extensionApprovedBy,
  };
  trip.hotel.lastSyncAt = hotelUpdate.syncedAt;
  trip.state.phase = 'RECOVERED';

  const hotelRecord = store.addHotelUpdate({
    id: id('htl'),
    tripId: trip.id,
    ...hotelUpdate,
    previousArrival: toIstIso(previousHotelArrival),
    newArrival: toIstIso(newHotelArrival),
    shiftedMinutes: diffMinutes(newHotelArrival, previousHotelArrival),
    reason: `${option.label} recovery after ${workflow.disruption?.flightNumber} ${workflow.disruption?.type === 'FLIGHT_CANCELLED' ? 'cancellation' : 'delay'}`,
  });
  // The aggregate the UI reads must carry the same record the property sync produced.
  workflow.hotelUpdate = hotelRecord;
  store.saveWorkflow(trip.id, workflow);
  emit('hotel:updated', { hotel: trip.hotel, update: hotelRecord, trip });
  broadcastTripState({ trip, workflow });

  agentEvent(trip, {
    type: 'HOTEL',
    level: 'success',
    title: `Hotel arrival updated to ${hhmm(newHotelArrival)}`,
    detail: `${trip.hotel.name} · ${trip.hotel.confirmation}. ${
      hotelUpdate.holdExtended
        ? `Hold extended to ${hhmm(hotelUpdate.holdUntil)} and approved by the night manager.`
        : `Room held until ${hhmm(hotelUpdate.holdUntil)} — inside the existing hold window.`
    } Airport transfer rescheduled to match.`,
    actor: 'Hotel Coordinator',
  });

  const hotelStage = workflow.stages.find((s) => s.key === 'HOTEL');
  Object.assign(hotelStage, {
    status: 'DONE',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: hotelUpdateResult.meta.latencyMs + 600,
    summary: `Late check-in ${hhmm(newHotelArrival)} · reservation ${hotelUpdate.status}`,
    facts: [
      stat('Previous arrival', hhmm(previousHotelArrival)),
      stat('New arrival', hhmm(newHotelArrival), 'good'),
      stat('Shift', `${diffMinutes(newHotelArrival, previousHotelArrival) >= 0 ? '+' : ''}${diffMinutes(newHotelArrival, previousHotelArrival)} min`, 'warn'),
      stat('Room held until', hhmm(hotelUpdate.holdUntil), hotelUpdate.holdExtended ? 'warn' : 'good'),
      stat('Reservation', hotelUpdate.status, 'good'),
      stat('Transfer', trip.hotel.transfer),
    ],
    items: [
      ...hotelUpdate.notes.map((n) => item('Hotel notified', n, 'DONE')),
      item('Arrival time', `Airport transfer re-timed to ${hhmm(addMinutes(newHotelArrival, -45))} pickup.`, 'DONE'),
      ...(hotelUpdate.extensionApprovedBy ? [item('Hold extension', `Approved by ${hotelUpdate.extensionApprovedBy}.`, 'DONE')] : []),
    ],
    providerCalls: [{ provider: hotelUpdateResult.meta.provider, latencyMs: hotelUpdateResult.meta.latencyMs, status: 'OK' }],
  });
  broadcastStage(workflow.id, hotelStage, workflow);
  broadcastWorkflow(workflow);

  // ----------------------------------------------------------- traveler notified
  const notification = await notify({
    trip,
    level: 'success',
    category: 'RECOVERY',
    title: `Trip recovered — rebooked on ${option.headlineFlight}`,
    body: `${option.label} confirmed (PNR ${booking.pnr}). You now arrive Mumbai ${hhmm(lastLeg.arrival.scheduled)} and ${
      trip.hotel.name
    } expects you at ${hhmm(newHotelArrival)}.${option.addedFare ? ` ${formatInr(option.addedFare)} was charged to your corporate account.` : ' No additional fare.'}`,
    action: { label: 'View new itinerary', href: '/booking' },
  });
  workflow.notification = notification;

  const notifyStage = workflow.stages.find((s) => s.key === 'NOTIFY');
  Object.assign(notifyStage, {
    status: 'DONE',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 420,
    summary: `Delivered on ${(notification.receipts || []).map((r) => r.channel).join(', ') || 'in-app'} in ${(notification.receipts || []).reduce((max, r) => Math.max(max, r.latencyMs), 0) || 240} ms`,
    facts: [
      stat('Channels', (notification.receipts || []).map((r) => r.channel).join(' · ') || 'in-app'),
      stat('Priority', notification.priority, 'good'),
      stat('New PNR', booking.pnr, 'good'),
      stat('Boarding pass', 'Attached (PDF) to the email receipt'),
    ],
    items: [
      item('Message', notification.body, 'SENT'),
      ...(notification.receipts || []).map((r) => item(`${r.channel.toUpperCase()} · ${r.provider}`, r.status === 'DELIVERED' ? `Delivered in ${r.latencyMs} ms` : r.status, r.status === 'DELIVERED' ? 'DONE' : 'WARN')),
    ],
  });
  broadcastStage(workflow.id, notifyStage, workflow);

  workflow.summary = {
    headline: `Recovered on ${option.label}`,
    newPnr: booking.pnr,
    arrival: toIstIso(lastLeg.arrival.scheduled),
    hotelArrival: toIstIso(newHotelArrival),
    addedFare: option.addedFare,
    totalJourney: duration(option.totalDurationMinutes),
    approvedBy: workflow.booking.approvedBy,
  };

  if (workflow.disruption) {
    workflow.disruption.status = 'RESOLVED';
    workflow.disruption.resolvedAt = new Date().toISOString();
    const stored = store.getDisruption(workflow.disruption.id);
    if (stored) {
      stored.status = 'RESOLVED';
      stored.resolvedAt = workflow.disruption.resolvedAt;
      stored.resolution = { optionId: option.id, label: option.label, pnr: booking.pnr, addedFare: option.addedFare };
    }
  }

  store.saveWorkflow(trip.id, workflow);
  broadcastWorkflow(workflow);
  broadcastTripState({ trip, workflow });
  return workflow;
}

/** Replace only the segments that cannot be flown, keep the rest of the PNR order. */
function buildRecoveredSegments({ trip, option, booking, constraints }) {
  const replaced = new Set(option.replacesSegments);
  const out = [];
  let inserted = false;

  trip.segments.forEach((segment) => {
    if (replaced.has(segment.id)) {
      if (!inserted) {
        option.legs.forEach((leg, index) => {
          const booked = booking.segments[index];
          out.push({
            id: leg.id.startsWith('seg_') ? leg.id : `seg_${leg.flightNumber.replace(/\s/g, '').toLowerCase()}`,
            sequence: 0,
            type: 'FLIGHT',
            airline: leg.airline,
            flightNumber: leg.flightNumber,
            aircraft: leg.aircraft,
            pnr: booking.pnr,
            from: { ...getAirport(leg.from.code), gate: null },
            to: { ...getAirport(leg.to.code), gate: null },
            departure: { scheduled: leg.departure.scheduled, estimated: leg.departure.scheduled, terminal: leg.departure.terminal || getAirport(leg.from.code).terminal, gate: null },
            arrival: { scheduled: leg.arrival.scheduled, estimated: leg.arrival.scheduled, terminal: leg.arrival.terminal || getAirport(leg.to.code).terminal },
            durationMinutes: leg.durationMinutes,
            stops: leg.stops,
            via: leg.via,
            viaDetail: leg.viaDetail,
            cabin: leg.cabin,
            seat: booked?.seat || '12A',
            fare: {
              currency: 'INR',
              amount: segment.fare?.amount || 0,
              tax: segment.fare?.tax || 0,
              baggage: booked?.baggage || '25 kg check-in + 7 kg cabin',
              difference: leg.fareDifference || 0,
            },
            status: 'CONFIRMED',
            isConnection: out.length > 0,
            minimumConnectionMinutes: constraints.minimumConnectionMinutes,
            inventorySource: leg.inventorySource,
            rebookedBy: 'TravelGuard AI',
            replacedFrom: replaced.has(segment.id) ? segment.flightNumber : null,
            rebookedAt: booking.issuedAt,
          });
        });
        inserted = true;
      }
      return;
    }
    out.push(segment);
  });

  return out.map((segment, index) => ({ ...segment, sequence: index + 1, isConnection: index > 0 }));
}

/** Traveler approves the held option — recovery resumes from stage 6. */
export async function approveOption({ tripId, optionId, approvedBy = 'Traveler approval in app' }) {
  const trip = store.getTrip(tripId) || store.activeTrip();
  const workflow = store.getWorkflow(trip.id);
  if (!workflow) throw Object.assign(new Error('No recovery workflow for this trip'), { status: 404 });

  const option =
    workflow.search?.options.find((o) => o.id === optionId) ||
    workflow.search?.decision.selected ||
    workflow.search?.decision.bestApproval;
  if (!option) throw Object.assign(new Error('Option no longer available'), { status: 404 });

  workflow.status = 'RUNNING';
  trip.state.phase = 'REBOOKING';
  store.saveWorkflow(trip.id, workflow);
  broadcastWorkflow(workflow);

  agentEvent(trip, {
    type: 'APPROVAL',
    level: 'success',
    title: 'Traveler approved the recovery option',
    detail: `${approvedBy} · ${option.label}${option.addedFare ? ` · ${formatInr(option.addedFare)} overage accepted` : ''}.`,
    actor: 'Action Executor',
  });

  const startedWallClock = new Date(workflow.startedAt).getTime();
  await executeRecovery({
    trip,
    workflow,
    option,
    scenarioId: workflow.scenarioId,
    constraints: workflow.constraints,
    approval: { approvedBy, paymentReference: 'PAY-NW-88213' },
  });

  workflow.status = 'COMPLETED';
  workflow.completedAt = new Date().toISOString();
  workflow.metrics.recoveryMs = Date.now() - startedWallClock;
  store.recordRecovery(workflow.metrics.recoveryMs);
  store.saveWorkflow(trip.id, workflow);
  broadcastWorkflow(workflow);
  broadcastTripState({ trip, workflow });
  broadcastMetrics(computeMetrics(store.snapshot()));
  return workflow;
}

/** Escalate to the human travel desk (used by scenario 3). */
export async function escalateToDesk({ tripId, note = 'No policy-compliant alternative available.' }) {
  const trip = store.getTrip(tripId) || store.activeTrip();
  const workflow = store.getWorkflow(trip.id);
  const caseRecord = store.addManualCase({
    id: `CASE-${Math.floor(100000 + Math.random() * 899999)}`,
    tripId: trip.id,
    createdAt: new Date().toISOString(),
    status: 'OPEN',
    priority: 'HIGH',
    slaMinutes: 12,
    note,
    assignee: 'Northwind Travel Desk · Pune',
    disruptionId: workflow?.disruption?.id || null,
    bundle: {
      optionsEvaluated: workflow?.search?.decision.ranked.length || 0,
      bestAvailable: workflow?.search?.decision.bestApproval?.label || null,
      auditTrail: (workflow?.search?.decision.ranked || []).map((o) => ({
        option: o.label,
        verdict: o.eligibility.status,
        fitScore: o.eligibility.fitScore,
      })),
    },
  });

  if (workflow) {
    workflow.status = 'ESCALATED';
    workflow.manualCase = caseRecord;
    workflow.completedAt = new Date().toISOString();
    const notifyStage = workflow.stages.find((s) => s.key === 'NOTIFY');
    Object.assign(notifyStage, {
      status: 'DONE',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 380,
      summary: `Travel desk case ${caseRecord.id} opened · SLA ${caseRecord.slaMinutes} min`,
      facts: [
        stat('Case', caseRecord.id, 'warn'),
        stat('Priority', caseRecord.priority, 'warn'),
        stat('Assignee', caseRecord.assignee),
        stat('SLA', `${caseRecord.slaMinutes} min`),
      ],
      items: [
        item('Audit trail attached', `${caseRecord.bundle.optionsEvaluated} evaluated options with rule-level results sent to the desk.`, 'DONE'),
        item('Ticket value protected', 'Unflown segments stay refundable while the desk works the case.', 'DONE'),
      ],
    });
    store.saveWorkflow(trip.id, workflow);
    broadcastWorkflow(workflow);
  }

  trip.state.phase = 'ESCALATED';
  store.saveTrip(trip);
  broadcastTripState({ trip, workflow });

  agentEvent(trip, {
    type: 'ESCALATION',
    level: 'warning',
    title: `Travel desk case ${caseRecord.id} opened`,
    detail: `${note} Priority HIGH, SLA ${caseRecord.slaMinutes} minutes, ${caseRecord.bundle.optionsEvaluated} options with rule-level audit attached.`,
    actor: 'Human-in-the-loop',
  });

  await notify({
    trip,
    level: 'warning',
    category: 'ESCALATION',
    title: `Travel desk engaged · case ${caseRecord.id}`,
    body: `No policy-compliant seat is available right now, so a human specialist has taken the case (SLA ${caseRecord.slaMinutes} minutes). We are holding the best available option and will confirm as soon as it is secured.`,
    action: { label: 'View the case', href: '/disruptions' },
  });

  broadcastMetrics(computeMetrics(store.snapshot()));
  return { case: caseRecord, workflow };
}

export { restoreBaseline as resetTripForDemo };
