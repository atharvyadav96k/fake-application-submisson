export function nowIso(): string {
  return new Date().toISOString();
}

/** Parses an ISO timestamp, returning null instead of an Invalid Date. */
export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Milliseconds between two ISO timestamps; null when either is missing/invalid. */
export function durationMs(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = parseIso(from);
  const b = parseIso(to);
  if (!a || !b) return null;
  return b.getTime() - a.getTime();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to `places` decimals; keeps scores stable across serializations. */
export function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
