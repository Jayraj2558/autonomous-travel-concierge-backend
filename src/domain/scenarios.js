/**
 * Demo Mode scenarios. Each one drives the same recovery pipeline end to end but
 * ends in a different escalation path, which is what the judges need to see.
 */
export const SCENARIOS = [
  {
    id: 'S1_FLIGHT_CANCELLATION',
    index: 1,
    name: 'Flight cancellation',
    tagline: 'AI 482 cancelled · severe weather over Delhi',
    description:
      'The airline cancels the first leg three hours before departure. A compliant non-stop connection exists, so TravelGuard rebooks, updates the hotel and notifies the traveler without asking.',
    expectedOutcome: 'Autonomous rebooking + hotel adjustment',
    expectedDecision: 'AUTO_REBOOK',
    disruptionType: 'FLIGHT_CANCELLED',
    reason: 'Severe weather',
    severity: 'high',
    accent: 'coral',
    difficulty: 'Standard',
    spec: 'Spec §4 · Spec §6',
  },
  {
    id: 'S2_MISSED_CONNECTION',
    index: 2,
    name: 'Missed connection',
    tagline: 'AI 482 delayed 85 min · Delhi connection breaks',
    description:
      'The inbound flight slips and the Delhi connection no longer satisfies the minimum connection time. TravelGuard runs the connection maths, shows the shortfall and re-plans only the broken leg.',
    expectedOutcome: 'Connection re-protected on a later Delhi → Mumbai service',
    expectedDecision: 'AUTO_REBOOK',
    disruptionType: 'FLIGHT_DELAYED',
    reason: 'Late inbound aircraft',
    severity: 'medium',
    accent: 'amber',
    difficulty: 'Intermediate',
    spec: 'Spec §12 · Spec §4',
  },
  {
    id: 'S3_NO_ELIGIBLE_OPTION',
    index: 3,
    name: 'No policy-compliant alternative',
    tagline: 'Cancellation during a network-wide weather event',
    description:
      'Cancelled during a storm that removes most of the evening Delhi – Mumbai inventory. Nothing clears every rule, so TravelGuard escalates: it holds the best seat, asks for approval on the overage, and opens a case with the human travel desk.',
    expectedOutcome: 'Traveler approval required → manual intervention case',
    expectedDecision: 'MANUAL_INTERVENTION',
    disruptionType: 'FLIGHT_CANCELLED',
    reason: 'Severe weather · network disruption',
    severity: 'high',
    accent: 'rose',
    difficulty: 'Advanced',
    spec: 'Spec §5 · Spec §10',
  },
];

export const getScenario = (id) => SCENARIOS.find((s) => s.id === id);
export const DEFAULT_SCENARIO = SCENARIOS[0].id;
