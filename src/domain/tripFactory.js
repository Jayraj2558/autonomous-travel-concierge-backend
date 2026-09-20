import { DEMO_TRAVELER, DEMO_POLICY } from './seed.js';
import { AIRPORTS, getAirport } from './airports.js';
import { atIst, toIstIso } from '../utils/time.js';
import { id } from '../utils/random.js';
import { store } from './store.js';

/**
 * POST /api/trips — creates a monitored trip. Times are derived from a small
 * block-time table so new trips still produce coherent itineraries.
 */
const BLOCK_MINUTES = {
  'AMD-DEL': 95,
  'DEL-BOM': 140,
  'BOM-GOI': 75,
  'BLR-MAA': 60,
  'DEL-BLR': 165,
  'BOM-BLR': 105,
  'AMD-BOM': 90,
  'DEL-HYD': 125,
  'BOM-DEL': 135,
};

const fallbackBlock = 120;

export function createTrip(input) {
  const travelerId = input.travelerId || DEMO_TRAVELER.id;
  const origin = String(input.origin || 'AMD').toUpperCase();
  const destination = String(input.destination || 'BOM').toUpperCase();
  const via = (input.via || []).map((code) => String(code).toUpperCase());
  const date = input.date || '2026-09-24';
  const cabin = input.cabin || 'economy';
  const airline = (input.airline || 'AI').toUpperCase();

  const hops = [[origin, ...via, destination]].flatMap((chain) => {
    const pairs = [];
    for (let i = 0; i < chain.length - 1; i += 1) pairs.push([chain[i], chain[i + 1]]);
    return pairs;
  });

  let cursor = atIst(date, input.departureTime || '18:40');
  const segments = hops.map(([from, to], index) => {
    const block = BLOCK_MINUTES[`${from}-${to}`] || fallbackBlock;
    const departure = cursor;
    const arrival = new Date(departure.getTime() + block * 60000);
    cursor = new Date(arrival.getTime() + 85 * 60000); // connection buffer for the next leg
    const flightNumber = `${airline} ${400 + index * 37}`;

    return {
      id: id('seg'),
      sequence: index + 1,
      type: 'FLIGHT',
      airline,
      flightNumber,
      aircraft: 'Airbus A320neo',
      pnr: input.pnr || 'NEW1PN',
      from: { ...getAirport(from), gate: 'A4' },
      to: { ...getAirport(to) },
      departure: { scheduled: toIstIso(departure), estimated: toIstIso(departure), terminal: getAirport(from).terminal, gate: 'A4' },
      arrival: { scheduled: toIstIso(arrival), estimated: toIstIso(arrival), terminal: getAirport(to).terminal },
      durationMinutes: block,
      seat: `${8 + index * 3}${['A', 'C', 'F'][index % 3]}`,
      fare: { currency: 'INR', amount: 5400 + index * 900, tax: 940, baggage: '25 kg check-in + 7 kg cabin' },
      status: 'CONFIRMED',
      isConnection: index > 0,
      minimumConnectionMinutes: 45,
      inventorySource: 'Airline inventory · mock GDS',
      lastStatusCheck: toIstIso(new Date()),
    };
  });

  const lastArrival = new Date(segments[segments.length - 1].arrival.scheduled);
  const hotel = input.hotelName
    ? {
        id: id('hotel'),
        name: input.hotelName,
        brand: input.hotelBrand || 'Partner property',
        city: getAirport(destination).city,
        area: input.hotelArea || 'City centre',
        confirmation: input.hotelConfirmation || `TG-HTL-${Math.floor(1000 + Math.random() * 8999)}`,
        roomType: input.roomType || 'Deluxe King',
        nights: Number(input.nights || 2),
        ratePerNight: Number(input.ratePerNight || 7400),
        currency: 'INR',
        checkIn: {
          scheduled: toIstIso(new Date(lastArrival.getTime() + 20 * 60000)),
          current: toIstIso(new Date(lastArrival.getTime() + 20 * 60000)),
          holdUntil: atIst(new Date(lastArrival.getTime() + 86400000).toISOString().slice(0, 10), '02:00'),
        },
        checkOut: atIst(new Date(lastArrival.getTime() + 2 * 86400000).toISOString().slice(0, 10), '11:00'),
        airportTransferMinutes: 20,
        transfer: 'Airport pickup · Sedan (included)',
        status: 'CONFIRMED',
        policy: 'Free cancellation until 18:00 on arrival day',
        lastSyncAt: toIstIso(new Date()),
      }
    : null;

  const trip = {
    id: id('trip'),
    code: `TG-${Math.floor(1000 + Math.random() * 8999)}-${origin}`,
    travelerId,
    title: `${getAirport(origin).city} → ${via.length ? `${via.map((v) => getAirport(v).city).join(' → ')} → ` : ''}${getAirport(destination).city}`,
    subtitle: input.purpose || 'Newly monitored journey',
    origin,
    destination,
    via,
    startDate: date,
    endDate: input.endDate || date,
    status: 'ON_TRACK',
    cabin,
    passengers: [{ id: id('pax'), name: input.passengerName || DEMO_TRAVELER.name, type: 'ADULT', seat: segments[0].seat }],
    segments,
    hotel,
    policyId: input.policyId || DEMO_POLICY.id,
    monitoring: {
      startedAt: toIstIso(new Date()),
      cadence: { flight: 60, connection: 120, hotel: 300, policy: 600 },
      checks: {
        flight: { status: 'ACTIVE', label: 'Flight monitoring', lastChecked: toIstIso(new Date()), checks: 1, intervalSeconds: 60 },
        connection: { status: 'ACTIVE', label: 'Connection monitoring', lastChecked: toIstIso(new Date()), checks: 1, intervalSeconds: 120 },
        hotel: { status: 'ACTIVE', label: 'Hotel monitoring', lastChecked: toIstIso(new Date()), checks: 1, intervalSeconds: 300 },
        policy: { status: 'ACTIVE', label: 'Policy monitoring', lastChecked: toIstIso(new Date()), checks: 1, intervalSeconds: 600 },
      },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: { activeDisruptionId: null, phase: 'MONITORING', recoveryOptionId: null },
    baseline: null,
  };

  trip.baseline = {
    segments: JSON.parse(JSON.stringify(segments)),
    hotel: hotel ? JSON.parse(JSON.stringify(hotel)) : null,
  };

  store.saveTrip(trip);
  store.state.metrics.connectionsMonitored += Math.max(0, segments.length - 1);
  store.state.metrics.hotelsMonitored += hotel ? 1 : 0;
  return trip;
}

export const knownAirports = () => Object.values(AIRPORTS).map(({ code, city, name }) => ({ code, city, name }));
