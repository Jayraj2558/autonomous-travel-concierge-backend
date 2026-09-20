import { providerCall } from '../utils/provider.js';
import { getAirline } from '../domain/airlines.js';
import { atIst } from '../utils/time.js';

/**
 * MOCK — Flight Status Provider (stands in for a carrier ops feed / OAG).
 * Returns the airline's operational view of a single service.
 */
const STATUS_BY_SCENARIO = {
  S1_FLIGHT_CANCELLATION: {
    'AI 482': {
      status: 'CANCELLED',
      reason: 'Severe weather',
      remark:
        'Cancelled due to forecast thunderstorms over Delhi NCR. Aircraft held overnight at Ahmedabad; crew out of hours.',
      notifiedAt: '15:36',
      disruptionCode: 'WX-CANCEL',
      rebookAllowed: true,
      refundable: true,
      seatsReleased: false,
    },
  },
  S2_MISSED_CONNECTION: {
    'AI 482': {
      status: 'DELAYED',
      reason: 'Late inbound aircraft',
      remark:
        'Delayed 85 min: inbound aircraft AI 638 arrived late from Dubai. Revised departure 20:05, revised arrival Delhi 21:40.',
      revisedDeparture: '20:05',
      revisedArrival: '21:40',
      delayMinutes: 85,
      disruptionCode: 'ACFT-LATE',
      rebookAllowed: true,
      seatsReleased: true,
    },
  },
  S3_NO_ELIGIBLE_OPTION: {
    'AI 482': {
      status: 'CANCELLED',
      reason: 'Severe weather',
      remark:
        'Cancelled due to forecast thunderstorms over Delhi NCR. 9 of 22 later Delhi–Mumbai services are also affected; remaining inventory is full-fare.',
      notifiedAt: '15:36',
      disruptionCode: 'WX-CANCEL',
      rebookAllowed: true,
      refundable: true,
      seatsReleased: false,
    },
  },
};

const defaultStatus = (flightNumber) => ({
  status: 'ON_TIME',
  reason: null,
  remark: `${getAirline(flightNumber.slice(0, 2)).name} reports ${flightNumber} on schedule.`,
  delayMinutes: 0,
  disruptionCode: null,
  rebookAllowed: false,
});

export async function fetchFlightStatus({ flightNumber, travelDate, scenarioId, silent = false }) {
  return providerCall(
    'FlightStatusProvider',
    () => {
      const scenario = STATUS_BY_SCENARIO[scenarioId] || {};
      const override = scenario[flightNumber];
      const base = defaultStatus(flightNumber);
      return {
        provider: 'Airline Ops Feed · mock',
        queriedAt: new Date().toISOString(),
        flightNumber,
        travelDate,
        airline: getAirline(flightNumber.slice(0, 2)).name,
        ...base,
        ...(override || {}),
        scheduledDeparture: atIst(travelDate, '18:40').toISOString(),
      };
    },
    { silent, multiplier: 0.7 },
  );
}

export async function fetchMultipleStatuses(flightNumbers, options = {}) {
  const results = await Promise.all(
    flightNumbers.map((flightNumber) =>
      fetchFlightStatus({ flightNumber, travelDate: options.travelDate, scenarioId: options.scenarioId, silent: true })
        .then((r) => ({ flightNumber, ...r.data, meta: r.meta }))
        .catch((error) => ({ flightNumber, status: 'UNKNOWN', error: error.message })),
    ),
  );
  return results;
}

export const scenarioStatusPreview = (scenarioId) => STATUS_BY_SCENARIO[scenarioId] || {};
