/**
 * Engine smoke test — runs all three Demo Mode scenarios against a live API and
 * asserts the recovery maths (delay ordering, no crashed stages, correct
 * decision paths). Run with: npm run test:engine --prefix server
 */
import { ensureApi, stopApi } from './support/server.mjs';

let BASE = process.env.API_BASE || '';
let serverHandle = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} → ${response.status} ${JSON.stringify(payload).slice(0, 400)}`);
  return payload.data ?? payload;
}

let failures = 0;
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function runScenario(scenarioId, expectations) {
  console.log(`\n── ${scenarioId} ─────────────────────────────────────────`);
  await api('/api/demo/reset', { method: 'POST', body: {} });
  const accepted = await api('/api/disruptions/simulate', { method: 'POST', body: { scenarioId } });
  check('simulation accepted', accepted.accepted === true);
  check('planning clock pinned to scenario start', accepted.planningTime.startsWith('2026-09-24'), accepted.planningTime);

  let workflow = null;
  for (let i = 0; i < 60; i += 1) {
    await wait(500);
    const snapshot = await api('/api/recovery/trip_amd_del_bom');
    workflow = snapshot.workflow;
    if (workflow && ['AWAITING_APPROVAL', 'COMPLETED', 'ESCALATED', 'FAILED'].includes(workflow.status)) break;
  }

  check('workflow reached a terminal state', ['AWAITING_APPROVAL', 'COMPLETED', 'ESCALATED'].includes(workflow?.status), workflow?.status);
  const stages = workflow.stages;
  const done = stages.filter((s) => s.status === 'DONE');
  check('no stage failed', stages.every((s) => s.status !== 'FAILED'));
  check(
    'detect + impact + search + policy + decision all ran',
    ['DETECTED', 'IMPACT', 'SEARCH', 'POLICY', 'DECISION'].every((k) => done.some((s) => s.key === k)),
  );

  const decision = workflow.search.decision;
  check(`decision is ${expectations.decision}`, decision.decision === expectations.decision, decision.decision);
  check(
    `${decision.ranked.length} options evaluated`,
    decision.ranked.length >= expectations.minOptions,
    `${decision.ranked.length} options`,
  );
  check(`eligible count = ${expectations.eligible ?? 'any'}`, expectations.eligible === undefined || decision.eligibleCount === expectations.eligible, `eligible=${decision.eligibleCount} approval=${decision.approvalCount} ineligible=${decision.ineligibleCount}`);

  const selected = decision.selected || decision.bestApproval;
  check(
    `selected flight is ${expectations.flight}`,
    !expectations.flight || selected?.headlineFlight === expectations.flight,
    selected?.label,
  );

  if (expectations.arrival) {
    const arrival = new Date(selected.legs[selected.legs.length - 1].arrival.scheduled);
    const ist = new Date(arrival.getTime() + 330 * 60000).toISOString().slice(11, 16);
    check(`arrival ${expectations.arrival}`, ist === expectations.arrival, ist);
  }

  if (expectations.decision === 'APPROVAL_REQUIRED') {
    check('no booking created', !workflow.booking || workflow.booking.pnr === undefined, String(workflow.booking?.pnr));
    check('approval workflow offered a choice', workflow.status === 'AWAITING_APPROVAL', workflow.status);
  }

  if (expectations.autoRebook) {
    check('booking exists', Boolean(workflow.booking?.pnr), workflow.booking?.pnr);
    check('hotel arrival updated', Boolean(selected.hotelArrival), selected.hotelArrival);
    const shift = workflow.stages.find((s) => s.key === 'HOTEL').facts?.find((f) => f.label === 'New arrival')?.value;
    console.log(`     hotel check-in now ${shift}`);
    check('notification delivered', Boolean(workflow.notification?.id));
  } else if (expectations.decision === 'APPROVAL_REQUIRED') {
    check('seat hold offered', Boolean(workflow.holdOffer?.reference), workflow.holdOffer?.reference);
    check('approval notification sent', workflow.stages.find((s) => s.key === 'NOTIFY') !== undefined);
  }

  const trip = await api('/api/trips/trip_amd_del_bom');
  check('trip status reflects outcome', ['RECOVERED', 'DISRUPTED'].includes(trip.status), trip.status);
  check('itinerary segment count sane', trip.segments.length >= 1 && trip.segments.length <= 3, String(trip.segments.length));
  console.log('     itinerary:', trip.segments.map((s) => `${s.flightNumber}(${s.status})`).join(' → '));
  return { workflow, trip };
}

(async () => {
  serverHandle = await ensureApi();
  BASE = serverHandle.base;
  console.log(`API under test: ${BASE}`);

  const bootstrap = await api('/api/bootstrap');
  console.log('Bootstrap ok — traveler:', bootstrap.traveler.name, '| trip:', bootstrap.trip.title);
  check('demo trip has 2 segments', bootstrap.trip.segments.length === 2);
  check('hotel present', bootstrap.trip.hotel?.name === 'The Grand Mumbai');

  const s1 = await runScenario('S1_FLIGHT_CANCELLATION', {
    decision: 'AUTO_REBOOK',
    flight: '6E 421',
    arrival: '22:35',
    minOptions: 8,
    autoRebook: true,
  });
  const specFlights = ['6E 421', 'AI 512', 'UK 932'];
  const rows = s1.workflow.search.decision.ranked;
  specFlights.forEach((flight) => {
    const row = rows.find((r) => r.headlineFlight === flight);
    check(`${flight} is eligible`, row?.eligibility.status === 'ELIGIBLE', row?.eligibility.status);
  });
  check('original connection AI 721 shown as unavailable', rows.some((r) => r.originalConnection && r.eligibility.status === 'INELIGIBLE'));
  check('fare-checked option flagged for approval', rows.some((r) => r.eligibility.status === 'ELIGIBLE_WITH_APPROVAL'), rows.filter((r) => r.eligibility.status === 'ELIGIBLE_WITH_APPROVAL').map((r) => r.label).join(','));

  const s2 = await runScenario('S2_MISSED_CONNECTION', {
    decision: 'AUTO_REBOOK',
    flight: '6E 453',
    minOptions: 5,
    autoRebook: true,
  });
  const missed = s2.workflow.search.decision.ranked.find((r) => r.originalConnection);
  check('missed connection detected on the original service', missed?.eligibility.status === 'INELIGIBLE', missed?.eligibility.rules.find((r) => r.code === 'CON-02')?.detail?.slice(0, 120));
  const nonStopOption = s2.workflow.search.decision.ranked.find((r) => r.headlineFlight === '6E 453');
  check('non-stop replacement preferred over compliant multi-stop', s2.workflow.search.decision.selected?.headlineFlight === '6E 453', s2.workflow.search.decision.selected?.label);
  check('no earlier inbound seat available', s2.workflow.search.inboundConsidered.every((f) => !f.usable), s2.workflow.search.inboundConsidered.map((f) => `${f.flightNumber}:${f.usable}`).join(' '));
  check('only the broken leg is replaced', s2.workflow.booking.legs.length === 1, s2.workflow.booking.legs.map((l) => l.flightNumber).join('+'));

  const s3 = await runScenario('S3_NO_ELIGIBLE_OPTION', {
    decision: 'APPROVAL_REQUIRED',
    flight: 'SG 8193',
    minOptions: 7,
    autoRebook: false,
  });
  check('no compliant option flagged', s3.workflow.search.decision.noCompliantOption === true);
  check('manual intervention recommended', s3.workflow.search.decision.manualInterventionRecommended === true);
  check('decision label explains the escalation', /no policy-compliant alternative/i.test(s3.workflow.search.decision.decisionLabel), s3.workflow.search.decision.decisionLabel);
  check('honest about rejected rules', s3.workflow.search.decision.ineligibleCount >= 6, `ineligible=${s3.workflow.search.decision.ineligibleCount}`);
  check('ineligible options carry rule-level reasons', s3.workflow.search.decision.ranked.filter((r) => r.eligibility.status === 'INELIGIBLE').every((r) => r.eligibility.rules.some((x) => x.status === 'FAIL')), 'ok');
  check('fare ceiling breach surfaced', s3.workflow.search.decision.ranked.some((r) => r.eligibility.rules.some((x) => x.code === 'POL-03' && x.status === 'FAIL')));
  check('cabin/availability breach surfaced', s3.workflow.search.decision.ranked.some((r) => r.eligibility.rules.some((x) => x.code === 'AVL-01' && x.status === 'FAIL')));
  check('en-route layover rule applied', s3.workflow.search.decision.ranked.some((r) => r.eligibility.rules.some((x) => x.code === 'CON-03')), 'ok');

  // Escalation path + approval path for scenario 3.
  const disruption = s3.workflow.disruption;
  const escalated = await api(`/api/disruptions/${disruption.id}/escalate`, { method: 'POST', body: { note: 'Storm event — full fare buckets only.' } });
  check('manual case opened', /^CASE-/.test(escalated.case.id), escalated.case.id);
  check('case has audit bundle', escalated.case.bundle.auditTrail.length > 0);

  await api('/api/demo/reset', { method: 'POST', body: {} });
  const rerun = await api('/api/disruptions/simulate', { method: 'POST', body: { scenarioId: 'S3_NO_ELIGIBLE_OPTION' } });
  await wait(9000);
  const waiting = await api('/api/recovery/trip_amd_del_bom');
  check('scenario 3 waits for approval', waiting.workflow.status === 'AWAITING_APPROVAL', waiting.workflow.status);
  const approved = await api(`/api/disruptions/${waiting.workflow.disruption.id}/approve`, { method: 'POST', body: {} });
  check('approved rebooking executed', approved.status === 'COMPLETED' && Boolean(approved.booking?.pnr), approved.booking?.pnr);
  check('overage recorded', approved.booking.addedFare === 2450, String(approved.booking.addedFare));

  const metrics = await api('/api/admin/metrics');
  console.log('\n── Metrics ────────────────────────────────────────────');
  console.log(`   disruptions: ${metrics.disruptions.detected} · auto: ${metrics.disruptions.automaticRecoveries} · manual: ${metrics.disruptions.manualInterventions} · approvals: ${metrics.disruptions.approvalsRequested}`);
  console.log(`   avg detection ${metrics.performance.avgDetectionMs} ms · avg recovery ${metrics.performance.avgRecoveryMs} ms · success ${metrics.performance.rebookingSuccessRate}`);
  check('realtime provider stats captured', metrics.providers.length >= 4, metrics.providers.map((p) => p.name).join(', '));

  const prefs = await api('/api/preferences');
  const updated = await api('/api/preferences', {
    method: 'PUT',
    body: { maxAdditionalFare: 400, preferredAirlines: ['6E'] },
  });
  check('preference change re-scores live options', updated.decisionImpact !== null, JSON.stringify(updated.decisionImpact));
  await api('/api/preferences', { method: 'PUT', body: { maxAdditionalFare: 1500, preferredAirlines: ['AI', '6E', 'UK'] } });

  await stopApi(serverHandle);
  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error('\n❌ Test run crashed:', error.message);
  await stopApi(serverHandle);
  process.exit(1);
});
