import { createHash, randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Stable fingerprint for a payload, used to detect a re-sent finalize that differs from
 * the one already stored (as opposed to an identical retry, which is a no-op).
 */
export function fingerprint(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** JSON.stringify with deterministic key order, so equal objects fingerprint equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
