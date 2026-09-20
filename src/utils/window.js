/**
 * Travelers can silence non-urgent messages overnight. Urgent disruption
 * messages always break through (see notification service).
 */
export function isWithinQuietHours(quietHours, now = new Date()) {
  if (!quietHours?.from || !quietHours?.to) return false;
  const [fromH, fromM] = quietHours.from.split(':').map(Number);
  const [toH, toM] = quietHours.to.split(':').map(Number);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = fromH * 60 + fromM;
  const end = toH * 60 + toM;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
