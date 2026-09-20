import { providerCall } from '../utils/provider.js';
import { getInventory, toScheduledLeg } from './inventory.js';
import { getAirport } from '../domain/airports.js';
import { TRAVEL_DATE } from '../domain/seed.js';

/**
 * MOCK — Flight Search / Availability Provider (stands in for Amadeus or a
 * Navitaire shopping API). One call returns priced, seat-counted services for a
 * route, which is what the alternative-flight engine consumes.
 */
export async function searchFlights({ from, to, afterIso, cabin = 'economy', scenarioId, travelDate = TRAVEL_DATE, silent = false }) {
  return providerCall(
    'FlightSearchProvider',
    () => {
      const { feeders, connections } = getInventory(scenarioId);
      const pool = from === 'AMD' ? feeders : connections;
      const after = afterIso ? new Date(afterIso).getTime() : 0;

      const services = pool
        .map((item) => toScheduledLeg(item, travelDate))
        .filter((item) => item.from.code === from && item.to.code === to)
        .filter((item) => item.departure.scheduled.getTime() > after)
        .map((item) => ({
          id: item.id,
          flightNumber: item.flightNumber,
          airline: item.airline,
          aircraft: item.aircraft,
          from: getAirport(item.from.code),
          to: getAirport(item.to.code),
          departure: { scheduled: item.departure.scheduled.toISOString(), estimated: item.departure.estimated.toISOString() },
          arrival: { scheduled: item.arrival.scheduled.toISOString(), estimated: item.arrival.estimated.toISOString() },
          durationMinutes: item.durationMinutes,
          stops: item.stops,
          via: item.via,
          viaDetail: item.viaDetail,
          viaLayoverMinutes: item.viaLayoverMinutes ?? null,
          throughFlight: item.throughFlight || false,
          original: item.original || false,
          cabin: item.cabin,
          seatsAvailable: item.seats,
          fareDifference: item.fareDiff,
          currency: 'INR',
          onTimeScore: item.onTimeScore,
          inventorySource: item.inventorySource,
          inventoryNote: item.inventoryNote || null,
          cabinNote: item.cabinNote || null,
        }));

      return {
        provider: 'Amadeus Self-Service · mock',
        queriedAt: new Date().toISOString(),
        origin: from,
        destination: to,
        cabin,
        servicesConsidered: pool.length,
        results: services,
      };
    },
    { silent, multiplier: 1.25 },
  );
}

/** Seat-level availability re-check immediately before committing a booking. */
export async function checkAvailability({ flightNumber, cabin = 'economy', scenarioId, silent = false }) {
  return providerCall(
    'FlightAvailabilityProvider',
    () => {
      const { feeders, connections } = getInventory(scenarioId);
      const item = [...feeders, ...connections].find((s) => s.flightNumber === flightNumber);
      if (!item) throw new Error(`Unknown service ${flightNumber}`);
      const live = Math.max(0, item.seats - (Math.random() < 0.15 ? 1 : 0));
      return {
        provider: 'Airline Inventory API · mock',
        flightNumber,
        cabin,
        available: live > 0,
        seatsAvailable: live,
        fareBasis: `${cabin[0].toUpperCase()}${Math.random() < 0.5 ? 'SGVAL' : 'QLITE'}`,
        checkedAt: new Date().toISOString(),
      };
    },
    { silent, multiplier: 0.8, retries: 2 },
  );
}
