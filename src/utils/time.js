import { config } from '../config/index.js';

const IST_OFFSET_MINUTES = 330;

/**
 * TravelGuard runs every recovery decision against a simulation clock that
 * starts on the morning of the travel date and then advances in real time.
 * That keeps the demo alive ("checked 12s ago") while remaining aviation
 * coherent: alternatives are only ever offered for flights that can still be
 * physically boarded.
 */
class DemoClock {
  constructor(startIso, ceilingMinutes = 140) {
    // The simulation advances in real time but never past `ceilingMinutes`, so
    // same-day recovery options stay boardable no matter when a judge runs the
    // demo: 15:35 + 2h 20m = 17:55 at the latest.
    this.ceilingMinutes = ceilingMinutes;
    this.setStart(startIso);
  }

  setStart(startIso) {
    this.startedAt = Date.now();
    this.startMs = new Date(startIso).getTime();
    this.ceilingMs = this.startMs + this.ceilingMinutes * 60000;
  }

  reset() {
    this.setStart(config.demo.clockStart);
  }

  /** Current simulation time (clamped to the demo ceiling). */
  now() {
    return new Date(Math.min(this.startMs + (Date.now() - this.startedAt), this.ceilingMs));
  }

  atCeiling() {
    return Date.now() - this.startedAt >= this.ceilingMinutes * 60000;
  }

  describe() {
    return {
      start: new Date(this.startMs).toISOString(),
      now: this.now().toISOString(),
      ceiling: new Date(this.ceilingMs).toISOString(),
      elapsedSimulatedMs: Math.min(Date.now() - this.startedAt, this.ceilingMinutes * 60000),
      atCeiling: this.atCeiling(),
    };
  }

  /** Milliseconds of simulated time that have elapsed. */
  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  startIso() {
    return toIso(this.startMs);
  }
}

export const clock = new DemoClock(config.demo.clockStart);

const pad = (n) => String(n).padStart(2, '0');

/** Format a Date (or epoch ms) as `HH:mm` in IST. */
export function hhmm(value) {
  const date = toDate(value);
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
  return `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
}

/** Format as `HH:mm:ss` in IST — used for the operational event log. */
export function hhmmss(value) {
  const date = toDate(value);
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
  return `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

/** ISO string with the +05:30 offset baked in, e.g. 2026-09-24T18:40:00+05:30 */
export function toIso(value) {
  return toDate(value).toISOString().replace('Z', '+00:00');
}

/** ISO in IST local wall-clock. */
export function toIstIso(value) {
  const date = toDate(value);
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
}

export function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return new Date(value);
}

export function addMinutes(value, minutes) {
  return new Date(toDate(value).getTime() + minutes * 60000);
}

export function diffMinutes(a, b) {
  return Math.round((toDate(a).getTime() - toDate(b).getTime()) / 60000);
}

export function isBefore(a, b) {
  return toDate(a).getTime() < toDate(b).getTime();
}

/** Build an ISO timestamp on the travel date at a given wall-clock HH:mm (IST). */
export function atIst(dayIso, time) {
  const [hours, minutes] = String(time).split(':').map(Number);
  const base = toDate(dayIso);
  const istBase = new Date(base.getTime() + IST_OFFSET_MINUTES * 60000);
  const y = istBase.getUTCFullYear();
  const m = pad(istBase.getUTCMonth() + 1);
  const d = pad(istBase.getUTCDate());
  return new Date(`${y}-${m}-${d}T${pad(hours)}:${pad(minutes)}:00+05:30`);
}

/** Human friendly duration, e.g. "1h 35m" */
export function duration(minutes) {
  const mins = Math.max(0, Math.round(minutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "24 Sep 2026" */
export function formatDate(value) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(toDate(value));
}

/** "Thu, 24 Sep" */
export function formatDayDate(value) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(toDate(value));
}

export { IST_OFFSET_MINUTES };
