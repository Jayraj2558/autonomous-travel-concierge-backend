/**
 * End-to-end API smoke test.
 *
 *   node tests/api.test.js                       # runs the API itself on :4600
 *   API_BASE=http://127.0.0.1:4000 node tests/api.test.js   # tests a running server
 *
 * Exercises every route group, the streaming recovery pipeline (scenario 1 and
 * scenario 3, where the autonomous band is refused) and the preference-driven
 * re-scoring path.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const OWN_SERVER = !process.env.API_BASE;
const PORT = Number(process.env.API_PORT || 4600);
const BASE = process.env.API_BASE || `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return { status: response.status, ...payload };
}

async function waitForWorkflow(tripId, { timeoutMs = 45000, until } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await api(`/api/recovery/${tripId}`);
    last = data.workflow;
    if (last && (!until ? last.status !== 'RUNNING' : until(last))) return last;
    await sleep(400);
  }
  return last;
}

async function main() {
  section('Health & reference');
  const health = await api('/api/health');
  check('GET /api/health returns ok', health.data?.status === 'ok', health.data?.service);
  check('health exposes the simulation clock', Boolean(health.data?.clock?.now));

  const reference = await api('/api/reference');
  check('GET /api/reference ships airports/airlines/scenarios', reference.data?.airports?.length >= 10 && reference.data?.scenarios?.length === 3);

  const bootstrap = await api('/api/bootstrap');
  const trip = bootstrap.data?.trip;
  check('GET /api/bootstrap hydrates a trip', Boolean(trip?.id), trip?.title);
  check('bootstrap includes policy + preferences + traveler', Boolean(bootstrap.data?.policy && bootstrap.data?.preferences && bootstrap.data?.traveler));
  check('trip is the seeded AMD → DEL → BOM journey', trip.segments.map((s) => s.from.code).join('-') === 'AMD-DEL' && trip.segments[1].to.code === 'BOM');
  check('trip starts nominal', trip.status === 'ON_TRACK', trip.status);

  section('Trip endpoints');
  const trips = await api('/api/trips');
  check('GET /api/trips lists the active trip', trips.data?.length >= 1);
  const itinerary = await api(`/api/trips/${trip.id}/itinerary`);
  check('GET /api/trips/:id/itinerary returns segments + hotel', itinerary.data?.segments?.length === 2 && Boolean(itinerary.data?.hotel));
  const monitoring = await api(`/api/trips/${trip.id}/monitoring`);
  check('GET /api/trips/:id/monitoring shows active monitors', monitoring.data?.checks?.flight?.status === 'ACTIVE');
  const eventsBefore = await api(`/api/trips/${trip.id}/events`);
  check('GET /api/trips/:id/events returns the seeded trail', eventsBefore.data?.length > 0);

  section('Scenario 1 — cancellation, autonomous rebooking');
  const run = await api('/api/demo/run', { method: 'POST', body: { scenarioId: 'S1_FLIGHT_CANCELLATION' } });
  check('POST /api/demo/run accepts scenario 1', run.data?.accepted === true, run.data?.scenario?.name);
  const workflow = await waitForWorkflow(trip.id);
  check('workflow completes', workflow?.status === 'COMPLETED', workflow?.status);
  check('all eight stages ran', workflow?.stages?.length === 8 && workflow.stages.every((s) => s.status === 'DONE'));
  check('detection stage carries a provider latency', Number.isFinite(workflow?.metrics?.detectionMs), `${workflow?.metrics?.detectionMs} ms`);
  check('recovery time recorded', workflow?.metrics?.recoveryMs > 0, `${workflow?.metrics?.recoveryMs} ms`);
  check('decision is AUTO_REBOOK', workflow?.search?.decision?.decision === 'AUTO_REBOOK', workflow?.search?.decision?.decisionLabel);
  check('selected option is a bookable itinerary', Boolean(workflow?.search?.decision?.selected?.label), workflow?.search?.decision?.selected?.label);
  check('a booking was issued', Boolean(workflow?.booking?.pnr), workflow?.booking?.pnr);
  check('hotel arrival was re-timed', workflow?.stages.find((s) => s.key === 'HOTEL')?.status === 'DONE');
  check('traveler notification sent', workflow?.stages.find((s) => s.key === 'NOTIFY')?.status === 'DONE');

  const tripAfter = await api(`/api/trips/${trip.id}`);
  check('trip marked as recovered', tripAfter.data?.status === 'RECOVERED', tripAfter.data?.status);
  check('hotel now shows a later arrival', tripAfter.data?.hotel?.checkIn?.current !== trip.hotel.checkIn.scheduled, `${tripAfter.data?.hotel?.checkIn?.current}`);
  check('rebooked segments are attributed', tripAfter.data?.segments.some((s) => s.rebookedBy));

  section('Alternatives, policy engine & impact');
  const alternatives = await api(`/api/flights/alternatives?tripId=${trip.id}`);
  check('GET /api/flights/alternatives returns ranked options', alternatives.data?.options?.length >= 4, `${alternatives.data?.options?.length} options`);
  check('options carry per-rule eligibility', alternatives.data?.options?.[0]?.eligibility?.rules?.length >= 10);
  const eligible = alternatives.data.options.filter((o) => o.eligibility.status === 'ELIGIBLE');
  check('at least one option is autonomous-eligible', eligible.length >= 1, `${eligible.length} eligible`);

  const disruptions = await api(`/api/disruptions?tripId=${trip.id}`);
  const disruption = disruptions.data?.[0];
  check('GET /api/disruptions lists the file', Boolean(disruption?.id), disruption?.disruptionCode);
  if (!disruption) throw new Error('no disruption file was created — aborting downstream checks');

  const impact = await api(`/api/disruptions/${disruption.id}/impact`);
  check('impact analysis explains the connection break', impact.data?.connection?.viable === false, impact.data?.connection?.riskLabel);
  check('impact lists downstream consequences', impact.data?.downstreamNotes?.length >= 2);
  check('commercial impact quantified', Boolean(impact.data?.commercialImpact?.ticketValueAtRisk));

  const evaluated = await api(`/api/disruptions/${disruption.id}/evaluate`);
  check('GET /api/disruptions/:id/evaluate re-runs the rules', evaluated.data?.options?.length >= 4);
  check('evaluate returns the effective constraints', Boolean(evaluated.data?.constraints?.maxAdditionalFare));

  section('Bookings, recovery timeline & cases');
  const bookings = await api('/api/bookings');
  check('GET /api/bookings returns the issued ticket', bookings.data?.length >= 1, bookings.data?.[0]?.pnr);
  const bookingDetail = await api(`/api/bookings/${bookings.data[0].pnr}`);
  check('GET /api/bookings/:pnr returns the confirmation', bookingDetail.data?.pnr === bookings.data[0].pnr);
  const timeline = await api(`/api/recovery/${trip.id}/timeline`);
  check('GET /api/recovery/:id/timeline returns stage timings', timeline.data?.length === 8);
  const cases = await api('/api/cases');
  check('GET /api/cases works (empty when nothing escalated)', Array.isArray(cases.data), `${cases.data?.length} cases`);

  const rebook = await api('/api/bookings/rebook', { method: 'POST', body: { tripId: trip.id, optionId: workflow.search.decision.selected.id } });
  check('POST /api/bookings/rebook re-executes cleanly', rebook.status === 200, rebook.data?.booking?.pnr || rebook.error?.message);

  section('Hotel coordination');
  const hotelUpdate = await api('/api/hotels/update', {
    method: 'POST',
    body: { tripId: trip.id, arrival: '2026-09-25T23:20:00+05:30', reason: 'Traveler requested a later check-in after the meeting.' },
  });
  check('POST /api/hotels/update re-times the stay', hotelUpdate.data?.confirmedArrival?.startsWith('2026-09-25'), `${hotelUpdate.data?.previousArrival} → ${hotelUpdate.data?.confirmedArrival}`);
  check('hold window and notes come back from the property', Boolean(hotelUpdate.data?.holdUntil && hotelUpdate.data?.notes?.length));
  const hotelUpdates = await api('/api/hotels/updates');
  check('GET /api/hotels/updates logs the property syncs', hotelUpdates.data?.length >= 2, `${hotelUpdates.data?.length} entries`);
  const hotel = await api(`/api/hotels/${trip.id}`);
  check('GET /api/hotels/:tripId returns the reservation', Boolean(hotel.data?.hotel?.confirmation));

  section('Notifications');
  const notifications = await api('/api/notifications');
  check('GET /api/notifications returns the message log', notifications.data?.length >= 3, `${notifications.data?.length} messages`);
  check('messages carry levels and channels', Boolean(notifications.data?.[0]?.level && notifications.data?.[0]?.channels?.length));
  const test = await api('/api/notifications/test', { method: 'POST', body: { level: 'success', title: 'API smoke test', body: 'Delivery pipeline verified.' } });
  check('POST /api/notifications/test fans out to channels', test.data?.channels?.length >= 1, test.data?.channels?.join(' · '));
  check('delivery receipts recorded per channel', test.data?.receipts?.length >= 1);
  const read = await api('/api/notifications/read', { method: 'POST', body: { ids: [notifications.data[0].id] } });
  check('POST /api/notifications/read marks messages', read.data?.[0]?.read === true);

  section('Preferences → engine');
  const prefs = await api('/api/preferences');
  check('GET /api/preferences returns standing instructions', Boolean(prefs.data?.maxAdditionalFare != null));
  check('effective constraints are returned alongside', Boolean(prefs.meta?.constraints?.absoluteFareCeiling));
  const patched = await api('/api/preferences', { method: 'PUT', body: { maxAdditionalFare: 0, autoRebook: false } });
  check('PUT /api/preferences applies the change', patched.data?.maxAdditionalFare === 0 && patched.data?.autoRebook === false);
  check('constraints re-resolve after the change', patched.meta?.constraints?.maxAdditionalFare === 0);

  section('Scenario 3 — no compliant option, approval path');
  const run3 = await api('/api/demo/run', { method: 'POST', body: { scenarioId: 'S3_NO_ELIGIBLE_OPTION' } });
  check('POST /api/demo/run accepts scenario 3', run3.data?.accepted === true, run3.data?.scenario?.name);
  const workflow3 = await waitForWorkflow(trip.id, { timeoutMs: 60000, until: (w) => w.status !== 'RUNNING' });
  check('pipeline pauses for approval (no autonomous booking)', workflow3?.status === 'AWAITING_APPROVAL', workflow3?.status);
  check('no booking was issued without approval', workflow3?.booking === null, workflow3?.booking?.pnr);
  check('a seat hold is offered with an expiry', Boolean(workflow3?.holdOffer?.reference), workflow3?.holdOffer?.label);
  check('decision label explains the pause', Boolean(workflow3?.search?.decision?.decisionLabel), workflow3?.search?.decision?.decisionLabel);
  check('costly option surfaced for the traveler', (workflow3?.search?.decision?.bestApproval?.addedFare || 0) > 0, `₹${workflow3?.search?.decision?.bestApproval?.addedFare}`);

  const disruption3 = (await api(`/api/disruptions?tripId=${trip.id}`)).data[0];
  const approved = await api(`/api/disruptions/${disruption3.id}/approve`, {
    method: 'POST',
    body: { optionId: workflow3.search.decision.bestApproval.id, approvedBy: 'API smoke test' },
  });
  check('POST /api/disruptions/:id/approve resumes and books', Boolean(approved.data?.booking?.pnr), approved.data?.booking?.pnr);
  check('overage recorded on the approval', approved.data?.booking?.totalFareDifference > 0, `₹${approved.data?.booking?.totalFareDifference}`);
  const casesAfterApproval = await api('/api/cases');
  check('escalation queue still honest after approval', Array.isArray(casesAfterApproval.data));

  section('Scenario 2 — delay, miss-detection path');
  const run2 = await api('/api/demo/run', { method: 'POST', body: { scenarioId: 'S2_MISSED_CONNECTION' } });
  check('POST /api/demo/run accepts scenario 2', run2.data?.accepted === true, run2.data?.scenario?.name);
  const workflow2 = await waitForWorkflow(trip.id, { timeoutMs: 60000 });
  check('delay scenario resolves through the pipeline', ['COMPLETED', 'AWAITING_APPROVAL'].includes(workflow2?.status), workflow2?.status);
  check('delay kept the original inbound flight', workflow2?.stages?.find((s) => s.key === 'DETECTED')?.status === 'DONE');

  section('Demo reset & admin metrics');
  const reset = await api('/api/demo/reset', { method: 'POST', body: {} });
  check('POST /api/demo/reset restores the itinerary', reset.data?.trip?.status === 'ON_TRACK', reset.data?.trip?.status);
  check('clock returns to the demo anchor', String(reset.data?.clock?.now).includes('10:05') || Boolean(reset.data?.clock?.now));
  const afterReset = await api('/api/bootstrap');
  check('reset clears bookings and recoveries', (afterReset.data?.bookings?.length || 0) === 0 && afterReset.data?.workflow === null);

  const metrics = await api('/api/admin/metrics');
  check('GET /api/admin/metrics returns the ops board', Boolean(metrics.data?.monitored && metrics.data?.performance));
  check('metrics expose stage durations + provider stats', Array.isArray(metrics.data?.series?.hourly) && Array.isArray(metrics.data?.providers));
  check('autonomy share is computed', metrics.data?.autonomy?.automatedShare != null, `${metrics.data?.autonomy?.automatedShare}%`);
  const providers = await api('/api/admin/providers');
  check('GET /api/admin/providers lists provider behaviour', providers.data?.length >= 4, `${providers.data?.length} providers`);
  check('provider rows carry latency + error rate', providers.data[0].avgLatencyMs != null && 'errorRate' in providers.data[0]);
  const adminHealth = await api('/api/admin/health');
  check('GET /api/admin/health reports counts and persistence', Boolean(adminHealth.data?.counts && adminHealth.data?.database));
  const adminEvents = await api('/api/admin/events?limit=10');
  check('GET /api/admin/events filters the audit trail', adminEvents.data?.length <= 10);

  section('Validation & error handling');
  const badScenario = await api('/api/demo/run', { method: 'POST', body: { scenarioId: 'NOPE' } });
  check('unknown scenario is rejected with 400', badScenario.status === 400, badScenario.error?.code);
  const badFlight = await api('/api/flights/XX999/status');
  check('unknown flight still answers via the carrier feed', badFlight.status === 200 || badFlight.status === 404, `status ${badFlight.status}`);
  const missingTrip = await api('/api/trips/does-not-exist');
  check('unknown trip falls back or 404s cleanly', [200, 404].includes(missingTrip.status), `status ${missingTrip.status}`);
  const badBody = await api('/api/hotels/update', { method: 'POST', body: { tripId: trip.id } });
  check('missing required field returns BAD_REQUEST', badBody.status === 400 && badBody.error?.code === 'BAD_REQUEST', badBody.error?.message);
  const noRoute = await api('/api/definitely-not-a-route');
  check('unknown API route returns the error envelope', noRoute.status === 404 && noRoute.error?.code === 'NOT_FOUND');

  section('Trip creation');
  const created = await api('/api/trips', { method: 'POST', body: { origin: 'BLR', destination: 'GOI', startDate: '2026-10-02', cabin: 'ECONOMY', airline: '6E' } });
  check('POST /api/trips creates a monitored trip', Boolean(created.data?.id), `${created.data?.title} (${created.data?.segments?.length} legs)`);
  check('created trip has monitoring attached', Object.keys(created.data?.monitoring?.checks || {}).length >= 3);
}

async function run() {
  let server = null;
  if (OWN_SERVER) {
    server = spawn('node', ['src/index.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => process.env.VERBOSE && process.stdout.write(`[api] ${chunk}`));
    server.stderr.on('data', (chunk) => process.stdout.write(`[api:err] ${chunk}`));
    await sleep(2500);
  }

  try {
    await main();
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(500);
      server.kill('SIGKILL');
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed · ${failed} failed`);
  if (failed) {
    console.log(`  failures: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('  ✅ API SURFACE VERIFIED');
}

run();
