/**
 * Time helpers.
 *
 * Every persisted timestamp is ISO-8601 UTC. Durations are computed from
 * `performance.now()` so that wall-clock adjustments (NTP, sleep/resume) cannot
 * produce negative or absurd field dwell times.
 */

const contextStart = Date.now();
const perfStart = typeof performance !== 'undefined' ? performance.now() : 0;

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

/** ms since this JS context started. Monotonic. */
export function monotonicMs(): number {
  if (typeof performance === 'undefined') return Date.now() - contextStart;
  return Math.round(performance.now() - perfStart);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Positive elapsed ms between two ISO timestamps, or null when indeterminate. */
export function elapsedMs(fromIso: string | null, toIsoStr: string | null): number | null {
  const a = parseIso(fromIso);
  const b = parseIso(toIsoStr);
  if (a === null || b === null) return null;
  const d = b - a;
  return d >= 0 ? d : null;
}

export function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timezoneOffsetMinutes(): number {
  // Negated so that UTC+05:30 reports +330 rather than JS's -330.
  return -new Date().getTimezoneOffset();
}

/** True when `iso` is within `windowMs` before/after `referenceIso`. */
export function withinWindow(iso: string, referenceIso: string, windowMs: number): boolean {
  const a = parseIso(iso);
  const b = parseIso(referenceIso);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= windowMs;
}
