import { providerCall } from '../utils/provider.js';
import { generateConfirmationCode } from '../utils/random.js';

/**
 * MOCK — Hotel Provider (stands in for a PMS / channel manager integration).
 */
export async function checkReservation({ hotel, silent = false }) {
  return providerCall(
    'HotelProvider',
    () => ({
      provider: 'Hotel PMS · mock',
      confirmation: hotel.confirmation,
      property: hotel.name,
      status: 'CONFIRMED',
      roomType: hotel.roomType,
      nights: hotel.nights,
      holdUntil: hotel.checkIn.holdUntil,
      lateCheckInPolicy: 'Room released at 02:00 unless the arrival is confirmed in advance.',
      frontDesk: '+91 22 6712 8800',
      checkedAt: new Date().toISOString(),
    }),
    { silent, multiplier: 0.8 },
  );
}

/**
 * Notify the property of a revised arrival time. If the new arrival falls
 * outside the current hold window the desk extends it (and TravelGuard reports
 * the new hold time to the traveler).
 */
export async function updateArrival({ hotel, newArrival, previousArrival, reason, silent = false }) {
  return providerCall(
    'HotelProvider',
    () => {
      const holdUntilMs = new Date(hotel.checkIn.holdUntil).getTime();
      const arrivalMs = new Date(newArrival).getTime();
      const exceedsHold = arrivalMs + 15 * 60000 > holdUntilMs;
      const extendedHoldUntil = exceedsHold
        ? new Date(arrivalMs + 90 * 60000).toISOString()
        : hotel.checkIn.holdUntil;

      return {
        provider: 'Hotel PMS · mock',
        confirmation: hotel.confirmation,
        property: hotel.name,
        status: 'CONFIRMED',
        previousArrival,
        confirmedArrival: newArrival,
        holdUntil: extendedHoldUntil,
        holdExtended: exceedsHold,
        extensionApprovedBy: exceedsHold ? 'Night manager (front desk)' : null,
        lateCheckInFlagged: true,
        notes: [
          `Arrival updated to ${new Date(newArrival).toISOString()} — reason: ${reason}.`,
          exceedsHold
            ? 'Room hold extended and front desk informed; no charge for the late arrival.'
            : 'Arrival falls inside the existing hold window; no policy change required.',
        ],
        transfer: hotel.transfer,
        transferUpdated: true,
        syncedAt: new Date().toISOString(),
      };
    },
    { silent, multiplier: 1.1, retries: 2 },
  );
}

export async function confirmReservation({ hotel, silent = false }) {
  return providerCall(
    'HotelProvider',
    () => ({
      provider: 'Hotel PMS · mock',
      confirmation: generateConfirmationCode('TG-HTL'),
      status: 'CONFIRMED',
      property: hotel.name,
    }),
    { silent },
  );
}
