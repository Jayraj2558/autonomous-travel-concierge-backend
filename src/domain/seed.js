import { atIst, addMinutes, toIstIso } from '../utils/time.js';
import { getAirport } from './airports.js';

/**
 * Demo seed data. Everything the product runs on for the judge walkthrough
 * lives here so production logic never mixes with fixture data.
 */

export const TRAVEL_DATE = '2026-09-24';

export const DEMO_TRAVELER = {
  id: 'trav_aarav',
  name: 'Aarav Mehta',
  initials: 'AM',
  email: 'aarav.mehta@northwindanalytics.in',
  phone: '+91 98250 41788',
  homeCity: 'Bhuj',
  company: 'Northwind Analytics',
  role: 'Head of Data Platform',
  memberSince: '2024-02-11',
};

export const DEMO_PREFERENCES = {
  travelerId: 'trav_aarav',
  preferredAirlines: ['AI', '6E', 'UK'],
  avoidAirlines: ['SG'],
  maxAdditionalFare: 1500,
  maxAcceptableDelayMinutes: 180,
  nonStopPreferred: true,
  maxStops: 1,
  cabin: 'economy',
  requireSameCabin: true,
  autoRebook: true,
  hotelAdjustment: true,
  seatPreference: 'window',
  mealPreference: 'Vegetarian (Jain)',
  accessibility: { wheelchairAssistance: false, priorityBoarding: true },
  notifications: {
    push: true,
    sms: true,
    email: true,
    whatsapp: false,
    quietHours: { from: '23:30', to: '06:00', urgentOverride: true },
  },
  loyalty: [
    { program: 'Air India Maharaja Club', number: 'AI-8842-119', tier: 'Gold' },
    { program: 'IndiGo BluChip', number: '6E-5591-204', tier: 'Silver' },
  ],
  updatedAt: toIstIso(atIst(TRAVEL_DATE, '08:30')),
};

export const DEMO_POLICY = {
  id: 'pol_northwind_std',
  name: 'Northwind Analytics · Standard Domestic Policy',
  version: '3.2',
  effectiveFrom: '2026-04-01',
  currency: 'INR',
  owner: 'Corporate Travel Desk',
  allowedAirlines: ['AI', '6E', 'UK', 'SG', 'IX', 'QP'],
  thresholds: {
    maxAdditionalFare: 1500,
    absoluteFareCeiling: 3500,
    maxArrivalDelayMinutes: 180,
    approvalDelayToleranceMinutes: 60,
    minimumConnectionMinutes: 45,
    minimumDepartureBufferMinutes: 60,
    maxStopsForAutoRebook: 1,
    hotelHoldUntil: '02:00',
    allowCabinDowngrade: false,
    allowCabinUpgrade: false,
  },
  notes:
    'Economy cabin for all domestic legs. Non-stop preferred when the fare difference is inside the allowance.',
};

const flight = (input) => ({
  type: 'FLIGHT',
  status: 'ON_TIME',
  cabin: 'economy',
  stops: 0,
  baggage: { cabinKg: 7, checkInKg: 25 },
  ...input,
});

/** Two-segment itinerary the whole demo walks through. */
export function buildDemoTrip() {
  const segments = [
    flight({
      id: 'seg_ai482',
      sequence: 1,
      airline: 'AI',
      flightNumber: 'AI 482',
      aircraft: 'Airbus A320neo',
      pnr: 'X7K2QP',
      from: { ...getAirport('AMD'), gate: 'A12' },
      to: { ...getAirport('DEL') },
      departure: {
        scheduled: atIst(TRAVEL_DATE, '18:40'),
        estimated: atIst(TRAVEL_DATE, '18:40'),
        terminal: '1',
        gate: 'A12',
      },
      arrival: {
        scheduled: atIst(TRAVEL_DATE, '20:15'),
        estimated: atIst(TRAVEL_DATE, '20:15'),
        terminal: '3',
      },
      durationMinutes: 95,
      seat: '12A',
      fare: { currency: 'INR', amount: 6480, tax: 1120, baggage: '25 kg check-in + 7 kg cabin' },
      status: 'ON_TIME',
      minimumConnectionMinutes: 45,
      inventorySource: 'Air India · Amadeus GDS',
      lastStatusCheck: atIst(TRAVEL_DATE, '15:33'),
    }),
    flight({
      id: 'seg_ai721',
      sequence: 2,
      airline: 'AI',
      flightNumber: 'AI 721',
      aircraft: 'Airbus A321neo',
      pnr: 'X7K2QP',
      from: { ...getAirport('DEL') },
      to: { ...getAirport('BOM') },
      departure: { scheduled: atIst(TRAVEL_DATE, '21:40'), estimated: atIst(TRAVEL_DATE, '21:40'), terminal: '3', gate: 'C7' },
      arrival: { scheduled: atIst(TRAVEL_DATE, '23:50'), estimated: atIst(TRAVEL_DATE, '23:50'), terminal: '2' },
      durationMinutes: 130,
      seat: '14C',
      fare: { currency: 'INR', amount: 5720, tax: 980, baggage: '25 kg check-in + 7 kg cabin' },
      status: 'CONFIRMED',
      isConnection: true,
      minimumConnectionMinutes: 45,
      inventorySource: 'Air India · Amadeus GDS',
      lastStatusCheck: atIst(TRAVEL_DATE, '15:33'),
    }),
  ];

  return {
    id: 'trip_amd_del_bom',
    code: 'TG-2426-AMD',
    travelerId: DEMO_TRAVELER.id,
    title: 'Ahmedabad → Delhi → Mumbai',
    subtitle: 'Client workshop · Northwind Analytics Mumbai office',
    origin: 'AMD',
    destination: 'BOM',
    via: ['DEL'],
    startDate: TRAVEL_DATE,
    endDate: '2026-09-26',
    status: 'ON_TRACK',
    cabin: 'economy',
    passengers: [{ id: 'pax_aarav', name: DEMO_TRAVELER.name, type: 'ADULT', seat: '12A' }],
    segments,
    hotel: {
      id: 'hotel_grand_mumbai',
      name: 'The Grand Mumbai',
      brand: 'Grand Collection · 5 star',
      city: 'Mumbai',
      area: 'Bandra Kurla Complex',
      confirmation: 'TG-HTL-4471',
      roomType: 'Executive King · City view',
      nights: 2,
      ratePerNight: 9850,
      currency: 'INR',
      checkIn: { scheduled: atIst(TRAVEL_DATE, '22:30'), current: atIst(TRAVEL_DATE, '22:30'), holdUntil: atIst('2026-09-25', '02:00') },
      checkOut: atIst('2026-09-26', '11:00'),
      airportTransferMinutes: 20,
      transfer: 'Airport pickup · Sedan (included)',
      status: 'CONFIRMED',
      policy: 'Free cancellation until 18:00 on arrival day',
      lastSyncAt: atIst(TRAVEL_DATE, '15:29'),
    },
    policyId: DEMO_POLICY.id,
    monitoring: {
      startedAt: atIst(TRAVEL_DATE, '09:05'),
      cadence: { flight: 60, connection: 120, hotel: 300, policy: 600 },
      checks: {
        flight: { status: 'ACTIVE', label: 'Flight monitoring', lastChecked: atIst(TRAVEL_DATE, '15:33'), checks: 142, intervalSeconds: 60 },
        connection: { status: 'ACTIVE', label: 'Connection monitoring', lastChecked: atIst(TRAVEL_DATE, '15:31'), checks: 86, intervalSeconds: 120 },
        hotel: { status: 'ACTIVE', label: 'Hotel monitoring', lastChecked: atIst(TRAVEL_DATE, '15:29'), checks: 41, intervalSeconds: 300 },
        policy: { status: 'ACTIVE', label: 'Policy monitoring', lastChecked: atIst(TRAVEL_DATE, '15:24'), checks: 23, intervalSeconds: 600 },
      },
    },
    createdAt: '2026-08-14T11:20:00+05:30',
    updatedAt: toIstIso(atIst(TRAVEL_DATE, '15:33')),
    state: { activeDisruptionId: null, phase: 'MONITORING', recoveryOptionId: null },
  };
}

/** Pre-trip + same-day monitoring trail so the timeline is never empty. */
export function buildSeedEvents() {
  const at = (time) => atIst(TRAVEL_DATE, time);
  return [
    {
      id: 'evt_seed_1',
      tripId: 'trip_amd_del_bom',
      at: at('09:05'),
      type: 'MONITORING',
      level: 'info',
      title: 'Journey protection started',
      detail: 'TravelGuard began monitoring 2 flights, 1 connection and 1 hotel reservation for TG-2426-AMD.',
      actor: 'Monitoring Service',
    },
    {
      id: 'evt_seed_2',
      tripId: 'trip_amd_del_bom',
      at: at('11:12'),
      type: 'FLIGHT_STATUS',
      level: 'info',
      title: 'Flight status checked · AI 482',
      detail: 'Air India reports AI 482 on schedule. On-time performance for this slot: 88%.',
      actor: 'Flight Status Provider',
    },
    {
      id: 'evt_seed_3',
      tripId: 'trip_amd_del_bom',
      at: at('14:48'),
      type: 'WEATHER',
      level: 'warning',
      title: 'IMD advisory for Delhi NCR',
      detail: 'Thunderstorm cell forecast over Delhi NCR between 17:00 and 23:00. 14 departures already showing delays.',
      actor: 'Weather Intelligence',
    },
    {
      id: 'evt_seed_4',
      tripId: 'trip_amd_del_bom',
      at: at('15:22'),
      type: 'FLIGHT_STATUS',
      level: 'info',
      title: 'Flight status checked · AI 482',
      detail: 'Status ON TIME · estimate 18:40 → 20:15. Gate A12, terminal 1.',
      actor: 'Flight Status Provider',
    },
    {
      id: 'evt_seed_5',
      tripId: 'trip_amd_del_bom',
      at: at('15:26'),
      type: 'CONNECTION',
      level: 'info',
      title: 'Connection verified · DEL',
      detail: 'Arrival 20:15 + 45 min minimum connection = 21:00, AI 721 departs 21:40. Buffer: 1h 25m.',
      actor: 'Connection Engine',
    },
    {
      id: 'evt_seed_6',
      tripId: 'trip_amd_del_bom',
      at: at('15:29'),
      type: 'HOTEL',
      level: 'info',
      title: 'Hotel availability checked',
      detail: 'The Grand Mumbai confirms reservation TG-HTL-4471 and holds the room until 02:00.',
      actor: 'Hotel Provider',
    },
    {
      id: 'evt_seed_7',
      tripId: 'trip_amd_del_bom',
      at: at('15:32'),
      type: 'MONITORING',
      level: 'success',
      title: 'No disruption detected',
      detail: 'All monitored items nominal. Next sweep in 60 seconds.',
      actor: 'Monitoring Service',
    },
  ];
}

export function buildSeedNotifications() {
  const at = (time) => atIst(TRAVEL_DATE, time);
  return [
    {
      id: 'ntf_seed_1',
      tripId: 'trip_amd_del_bom',
      at: at('09:05'),
      level: 'info',
      category: 'MONITORING',
      title: 'Journey protection active',
      body: 'TravelGuard is now watching AI 482, AI 721, your Delhi connection and The Grand Mumbai.',
      channels: ['push'],
      read: true,
      action: { label: 'Open live monitoring', href: '/monitoring' },
    },
    {
      id: 'ntf_seed_2',
      tripId: 'trip_amd_del_bom',
      at: at('14:48'),
      level: 'warning',
      category: 'DISRUPTION',
      title: 'Weather watch · Delhi NCR',
      body: 'Thunderstorms forecast over Delhi between 17:00 and 23:00. We are watching AI 482 closely and will re-plan automatically if anything changes.',
      channels: ['push', 'email'],
      read: false,
      action: { label: 'View advisory', href: '/monitoring' },
    },
  ];
}

export { addMinutes };
