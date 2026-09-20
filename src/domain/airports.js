/**
 * Airport reference data used across the itinerary, the recovery engine and
 * the map panel. Kept intentionally small — only airports this prototype can
 * route through.
 */
export const AIRPORTS = {
  AMD: { code: 'AMD', name: 'Sardar Vallabhbhai Patel Intl', city: 'Ahmedabad', country: 'India', terminal: '1', lat: 23.07, lng: 72.63 },
  DEL: { code: 'DEL', name: 'Indira Gandhi Intl', city: 'Delhi', country: 'India', terminal: '3', lat: 28.55, lng: 77.1 },
  BOM: { code: 'BOM', name: 'Chhatrapati Shivaji Maharaj Intl', city: 'Mumbai', country: 'India', terminal: '2', lat: 19.09, lng: 72.87 },
  BLR: { code: 'BLR', name: 'Kempegowda Intl', city: 'Bengaluru', country: 'India', terminal: '1', lat: 13.2, lng: 77.71 },
  MAA: { code: 'MAA', name: 'Chennai Intl', city: 'Chennai', country: 'India', terminal: '4', lat: 12.99, lng: 80.17 },
  HYD: { code: 'HYD', name: 'Rajiv Gandhi Intl', city: 'Hyderabad', country: 'India', terminal: '1', lat: 17.24, lng: 78.43 },
  GOI: { code: 'GOI', name: 'Manohar Intl', city: 'Goa', country: 'India', terminal: '1', lat: 15.38, lng: 73.83 },
  CCU: { code: 'CCU', name: 'Netaji Subhas Chandra Bose Intl', city: 'Kolkata', country: 'India', terminal: '1', lat: 22.65, lng: 88.45 },
  JAI: { code: 'JAI', name: 'Jaipur Intl', city: 'Jaipur', country: 'India', terminal: '2', lat: 26.82, lng: 75.8 },
  DXB: { code: 'DXB', name: 'Dubai Intl', city: 'Dubai', country: 'UAE', terminal: '3', lat: 25.25, lng: 55.36 },
  SIN: { code: 'SIN', name: 'Changi', city: 'Singapore', country: 'Singapore', terminal: '3', lat: 1.36, lng: 103.99 },
};

export const getAirport = (code) =>
  AIRPORTS[String(code || '').toUpperCase()] || {
    code: String(code || '---').toUpperCase(),
    name: 'Unknown airport',
    city: String(code || 'Unknown'),
    country: '—',
    terminal: '—',
  };

/** Route label like "AMD → DEL". */
export const routeLabel = (from, to) => `${getAirport(from).code} → ${getAirport(to).code}`;

export const airportLine = (code) => {
  const airport = getAirport(code);
  return `${airport.city} (${airport.code})`;
};
