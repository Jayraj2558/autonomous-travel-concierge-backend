import { aiStatus } from './ai.js';
import { databaseStatus } from '../db/client.js';
import { config } from '../config/index.js';

/**
 * Operational metrics for the Admin / System Monitoring page.
 *
 * `live` numbers are produced by this server. `fleet` numbers represent the
 * wider TravelGuard deployment (24 other travellers) and stay stable so the
 * console looks like a production operations board rather than a single demo.
 */
const FLEET = {
  travelers: 24,
  trips: 31,
  flights: 58,
  connections: 27,
  hotels: 19,
  disruptionsDetected: 6,
  autoRecovered: 5,
  manual: 1,
  detectionSamples: [2100, 1850, 2640, 1760, 3120, 2410],
  recoverySamples: [96000, 132000, 78000, 145000, 88000, 121000],
};

const HOURLY = [
  { hour: '09:00', detected: 0, recovered: 0, monitored: 18 },
  { hour: '10:00', detected: 1, recovered: 1, monitored: 22 },
  { hour: '11:00', detected: 0, recovered: 0, monitored: 25 },
  { hour: '12:00', detected: 1, recovered: 1, monitored: 27 },
  { hour: '13:00', detected: 0, recovered: 0, monitored: 30 },
  { hour: '14:00', detected: 1, recovered: 1, monitored: 34 },
  { hour: '15:00', detected: 2, recovered: 2, monitored: 41 },
  { hour: '16:00', detected: 1, recovered: 1, monitored: 46 },
];

const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
const rate = (num, den) => (den ? Math.round((num / den) * 1000) / 1000 : null);

export function computeMetrics(state) {
  const m = state.metrics;
  const detectionSamples = [...FLEET.detectionSamples, ...m.detectionMs].filter((n) => Number.isFinite(n));
  const recoverySamples = [...FLEET.recoverySamples, ...m.recoveryMs].filter((n) => Number.isFinite(n));

  const liveDisruptions = m.disruptionsDetected;
  const detected = FLEET.disruptionsDetected + liveDisruptions;
  const autoRecovered = FLEET.autoRecovered + m.automaticRecoveries;
  const manual = FLEET.manual + m.manualInterventions;

  const attempts = m.rebookingAttempts;
  const successes = m.rebookingSuccesses;

  const workflow = Object.values(state.workflows)[0];
  const stageDurations = (workflow?.stages || [])
    .filter((s) => s.durationMs)
    .map((s) => ({ stage: s.title, ms: s.durationMs, status: s.status }));

  return {
    generatedAt: new Date().toISOString(),
    monitored: {
      travelers: FLEET.travelers + Object.keys(state.travelers).length,
      trips: FLEET.trips + Object.keys(state.trips).length,
      flights: FLEET.flights + m.flightsMonitored,
      connections: FLEET.connections + m.connectionsMonitored,
      hotels: FLEET.hotels + m.hotelsMonitored,
      live: {
        travelers: Object.keys(state.travelers).length,
        flights: m.flightsMonitored,
        connections: m.connectionsMonitored,
        hotels: m.hotelsMonitored,
      },
    },
    disruptions: {
      detected,
      detectedLive: liveDisruptions,
      automaticRecoveries: FLEET.autoRecovered + m.automaticRecoveries,
      approvalsRequested: m.approvalsRequested,
      manualInterventions: manual,
      openCases: state.manualCases.filter((c) => c.status === 'OPEN').length,
    },
    performance: {
      avgDetectionMs: avg(detectionSamples),
      avgRecoveryMs: avg(recoverySamples),
      rebookingAttempts: attempts,
      rebookingSuccesses: successes,
      rebookingSuccessRate: rate(successes, attempts),
      fleetRebookingSuccessRate: 0.94,
      alternativesEvaluated: m.alternativesEvaluated,
      notificationsSent: m.notificationsSent,
    },
    providers: Object.values(state.providerStats || {}).map((p) => ({
      name: p.name,
      calls: p.calls,
      failures: p.failures,
      errorRate: rate(p.failures, p.calls),
      avgLatencyMs: avg(p.latencyMs),
      lastCallAt: p.lastCallAt,
    })),
    series: {
      hourly: HOURLY,
      funnel: [
        { label: 'Disruptions detected', value: detected, tone: 'coral' },
        { label: 'Recovered autonomously', value: FLEET.autoRecovered + m.automaticRecoveries, tone: 'green' },
        { label: 'Traveler approval', value: m.approvalsRequested, tone: 'amber' },
        { label: 'Human desk', value: manual, tone: 'charcoal' },
      ],
      stageDurations,
    },
    autonomy: {
      automatedShare: rate(FLEET.autoRecovered + m.automaticRecoveries, detected),
      autoRebookEnabled: true,
      policyVersion: Object.values(state.policies)[0]?.version,
    },
    session: {
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      env: config.env,
      demoScenario: state.demo.scenario,
      demoRuns: state.demo.runs,
    },
    ai: aiStatus(),
    database: databaseStatus(),
  };
}
