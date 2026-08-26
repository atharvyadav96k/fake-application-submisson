/** Small text helpers shared by the field heuristics. */

/** Splits camelCase / snake_case / kebab-case / dotted identifiers into lowercase tokens. */
export function tokenize(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeLabel(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/\*/g, ' ')
    .replace(/\(required\)|\(optional\)/gi, ' ')
    .replace(/[:•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when every token in `needle` appears in `haystackTokens`. */
export function containsAllTokens(haystackTokens: string[], needle: string): boolean {
  const needed = tokenize(needle);
  if (needed.length === 0) return false;
  return needed.every((t) => haystackTokens.includes(t));
}

/** Debounce that also exposes a `flush` for teardown paths. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const wrapped = (...args: A) => {
    pending = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pending;
      pending = null;
      if (a) fn(...a);
    }, waitMs);
  };

  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const a = pending;
    pending = null;
    if (a) fn(...a);
  };

  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return wrapped;
}

/** Leading-edge throttle. */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
): (...args: A) => void {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      fn(...args);
    }
  };
}

/** Runs work when the main thread is idle, with a hard timeout fallback. */
export function whenIdle(fn: () => void, timeoutMs = 500): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(fn, { timeout: timeoutMs });
  else setTimeout(fn, 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to `places` decimals; keeps scores stable across serializations. */
export function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
