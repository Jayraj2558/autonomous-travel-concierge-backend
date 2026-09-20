const formatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** ₹1,15,000 — Indian digit grouping, no decimals. */
export function formatInr(amount, currency = 'INR') {
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${formatter.format(Math.round(Number(amount) || 0))}`;
}

export function formatDelta(amount, currency = 'INR') {
  const value = Math.round(Number(amount) || 0);
  if (value === 0) return `${formatInr(0, currency)} extra`;
  return `${value > 0 ? '+' : '−'}${formatInr(Math.abs(value), currency)}`;
}

export { formatter as numberFormatter };
