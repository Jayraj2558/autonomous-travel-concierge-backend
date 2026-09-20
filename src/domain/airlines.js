/**
 * Carrier reference data. `mark` is the two-character code the UI renders as
 * an airline chip; `accent` keeps each card visually distinguishable without
 * importing third-party logos.
 */
export const AIRLINES = {
  AI: { code: 'AI', name: 'Air India', mark: 'AI', accent: '#B8232F', tier: 'full-service', baggageAllowanceKg: 25 },
  '6E': { code: '6E', name: 'IndiGo', mark: '6E', accent: '#1B3A6B', tier: 'low-cost', baggageAllowanceKg: 15 },
  UK: { code: 'UK', name: 'Vistara', mark: 'UK', accent: '#5B2A86', tier: 'full-service', baggageAllowanceKg: 20 },
  SG: { code: 'SG', name: 'SpiceJet', mark: 'SG', accent: '#C8102E', tier: 'low-cost', baggageAllowanceKg: 15 },
  IX: { code: 'IX', name: 'Air India Express', mark: 'IX', accent: '#D4622A', tier: 'low-cost', baggageAllowanceKg: 20 },
  QP: { code: 'QP', name: 'Akasa Air', mark: 'QP', accent: '#E4572E', tier: 'low-cost', baggageAllowanceKg: 15 },
  EK: { code: 'EK', name: 'Emirates', mark: 'EK', accent: '#D71921', tier: 'full-service', baggageAllowanceKg: 30 },
  QR: { code: 'QR', name: 'Qatar Airways', mark: 'QR', accent: '#5C0632', tier: 'full-service', baggageAllowanceKg: 30 },
};

export const getAirline = (code) =>
  AIRLINES[String(code || '').toUpperCase()] || {
    code: String(code || '--').toUpperCase(),
    name: 'Partner carrier',
    mark: String(code || '--').toUpperCase(),
    accent: '#4A443C',
    tier: 'unknown',
    baggageAllowanceKg: 15,
  };

export const airlineName = (code) => getAirline(code).name;
