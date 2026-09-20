import { providerCall } from '../utils/provider.js';
import { generatePnr, generateTicketNumber } from '../utils/random.js';

/**
 * MOCK — Airline Booking Provider. Mirrors how an NDC/PNR write behaves:
 * a hold, an issued ticket, a new PNR and per-segment seat assignments.
 */
export async function createBooking({ trip, option, passenger, paymentReference, silent = false }) {
  return providerCall(
    'AirlineBookingProvider',
    () => {
      const pnr = generatePnr();
      const segments = option.legs.map((leg, index) => ({
        segmentId: `seg_${leg.flightNumber.replace(/\s/g, '').toLowerCase()}`,
        flightNumber: leg.flightNumber,
        airline: leg.airline,
        from: leg.from.code,
        to: leg.to.code,
        departure: leg.departure.scheduled,
        arrival: leg.arrival.scheduled,
        cabin: leg.cabin,
        status: 'CONFIRMED',
        seat: seatFor(passenger, index),
        baggage: `${leg.baggageAllowanceKg || 25} kg check-in + 7 kg cabin`,
      }));

      return {
        provider: 'Airline Booking API (NDC) · mock',
        reference: pnr,
        pnr,
        status: 'CONFIRMED',
        issuedAt: new Date().toISOString(),
        ticketNumbers: segments.map(() => generateTicketNumber(option.legs[0].airline)),
        currency: 'INR',
        totalFareDifference: option.addedFare,
        paidBy: option.addedFare === 0 ? 'Airline re-accommodation (no charge)' : 'Corporate travel account ·••4471',
        paymentReference: paymentReference || (option.addedFare === 0 ? 'WVR-REACCOM' : 'PAY-NW-88213'),
        originalPnr: trip.segments[0]?.pnr,
        segments,
        expiresInMinutes: 0,
        remark:
          option.addedFare === 0
            ? 'Ticket reissued under the airline’s disruption re-accommodation agreement.'
            : 'Fare difference collected from the corporate travel account.',
      };
    },
    { silent, multiplier: 1.6, retries: 2 },
  );
}

const SEATS = ['12A', '7C', '18F', '3D', '22B', '9A'];
const seatFor = (passenger, index) => SEATS[(index + 1) % SEATS.length];

/** Pre-emptive seat hold used when an option needs traveler approval. */
export async function holdBooking({ option, holdMinutes = 24, silent = false }) {
  return providerCall(
    'AirlineBookingProvider',
    () => ({
      provider: 'Airline Booking API (NDC) · mock',
      holdReference: `HLD-${Math.floor(100000 + Math.random() * 899999)}`,
      status: 'HELD',
      holdMinutes,
      flights: option.legs.map((l) => l.flightNumber),
      expiresAt: new Date(Date.now() + holdMinutes * 60000).toISOString(),
      remark: 'Seats held in the airline inventory while the traveler reviews the offer.',
    }),
    { silent, multiplier: 0.9 },
  );
}
