import { getConfig } from '@/common/config';
import type { CanonicalField, Sensitivity } from '@/models/field';

export const REDACTED = '[REDACTED]';

const SENSITIVE_NAME_PATTERNS: RegExp[] = [
  /pass(word|wd|phrase)/i,
  /\bpin\b/i,
  /\botp\b/i,
  /one[-_ ]?time[-_ ]?(code|password)/i,
  /\b2fa\b|two[-_ ]?factor/i,
  /security[-_ ]?(code|answer|question)/i,
  /\bcvv\b|\bcvc\b|card[-_ ]?(number|code|verification)/i,
  /credit[-_ ]?card|\bcc[-_ ]?num/i,
  /\bssn\b|social[-_ ]?security/i,
  /national[-_ ]?(id|insurance)|\bnino\b/i,
  /\biban\b|\bswift\b|account[-_ ]?number|routing[-_ ]?number|sort[-_ ]?code/i,
  /aadhaar|\bpan[-_ ]?card\b|passport[-_ ]?(no|number)/i,
  // No \b here: `access_token` has no word boundary before `token` (underscore is a
  // word character), and missing that would defeat the whole guard.
  /token|secret|api[-_ ]?key|access[-_ ]?key|auth(oriz|entic)/i,
];

/** Patterns matching *values* that look like credentials/tokens, regardless of field. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /\b(?:\d[ -]*?){13,19}\b/, // card-like number sequence
  /^(?:[A-Za-z0-9+/]{40,}={0,2})$/, // long opaque base64 blob
  /\b[A-Za-z0-9]{32,}\b/, // long opaque token
  /^(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{10,}/i, // known key prefixes
];

export function isSensitiveName(...hints: (string | null | undefined)[]): boolean {
  const joined = hints.filter(Boolean).join(' ');
  if (!joined) return false;
  return SENSITIVE_NAME_PATTERNS.some((re) => re.test(joined));
}

/** Our own digests: `sha256:<hex>` / `fnv:<hex>`. They are the redacted form already. */
const OWN_DIGEST = /^(sha256|fnv):[0-9a-f]+$/;

export function looksLikeSecretValue(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 8) return false;
  // Without this, a 64-character SHA-256 digest trips the opaque-token pattern and the
  // scrubber destroys the very field hashing exists to produce.
  if (OWN_DIGEST.test(trimmed)) return false;
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Decide how an observed value may be persisted.
 *
 * Order matters: credential-grade classification wins over everything, then the
 * configured never-store/hashed lists, then value-shape heuristics.
 */
export function classifySensitivity(
  canonical: CanonicalField,
  opts: {
    inputType?: string | null;
    nameHints?: (string | null | undefined)[];
    sampleValue?: string | null;
  } = {},
): Sensitivity {
  const cfg = getConfig().privacy;

  if (opts.inputType && opts.inputType.toLowerCase() === 'password') return 'never_store';
  if (cfg.never_store_fields.includes(canonical)) return 'never_store';
  if (isSensitiveName(...(opts.nameHints ?? []))) return 'never_store';
  if (opts.sampleValue && looksLikeSecretValue(opts.sampleValue)) return 'never_store';

  if (cfg.hashed_fields.includes(canonical)) return 'hashed_only';
  if (canonical === 'unknown') return 'hashed_only'; // unclassified => treat as PII
  if (cfg.hash_all_values) return 'hashed_only';

  return 'storable';
}

/** Truncate and strip control characters from any text we keep. */
export function sanitizeText(text: string, maxLength = getConfig().dom.max_excerpt_length): string {
  const cleaned = text
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
  return redactInlineSecrets(capped);
}

/** Redacts token-shaped substrings and email/phone-shaped text out of free text. */
export function redactInlineSecrets(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED)
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, REDACTED)
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\b[A-Za-z0-9]{32,}\b/g, REDACTED);
}

/** Path segments that look like credentials/opaque secrets rather than ids. */
function redactPathSegment(segment: string): string {
  if (segment.length >= 32 && /^[A-Za-z0-9._~-]+$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment)) {
    return REDACTED;
  }
  if (/^ey[A-Za-z0-9_-]{10,}\./.test(segment)) return REDACTED;
  return segment;
}

/**
 * Remove tokens, keys, session identifiers, and PII-bearing parameters from a URL.
 * Fragments are dropped entirely — SPAs and OAuth flows both put secrets there.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let url: URL;
  try {
    url = new URL(rawUrl, typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    return REDACTED;
  }

  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'javascript:') {
    return `${url.protocol}${REDACTED}`;
  }

  // Credentials embedded in the authority section.
  url.username = '';
  url.password = '';

  const redactedParams = new Set(getConfig().privacy.redacted_query_params.map((p) => p.toLowerCase()));
  const params = url.searchParams;
  const keys = [...params.keys()];
  for (const key of keys) {
    const lower = key.toLowerCase();
    const values = params.getAll(key);
    const shouldRedact =
      redactedParams.has(lower) ||
      isSensitiveName(key) ||
      values.some((v) => looksLikeSecretValue(v));
    if (shouldRedact) {
      params.delete(key);
      params.set(key, REDACTED);
    }
  }

  url.pathname = url.pathname.split('/').map(redactPathSegment).join('/');

  // Fragments are never retained.
  url.hash = '';

  return url.toString();
}

/** Domain + path only — used for grouping and for low-cardinality reporting. */
export function urlParts(rawUrl: string): { domain: string; path: string; sanitized: string } {
  try {
    const url = new URL(rawUrl, typeof location !== 'undefined' ? location.href : undefined);
    return {
      domain: url.hostname,
      path: url.pathname.split('/').map(redactPathSegment).join('/'),
      sanitized: sanitizeUrl(rawUrl),
    };
  } catch {
    return { domain: 'unknown', path: '', sanitized: REDACTED };
  }
}

/** Cap and clean a value that policy allows us to store in plain text. */
export function sanitizeStorableValue(value: string): string {
  const max = getConfig().dom.max_stored_value_length;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * Final guard applied to any object before it is persisted or uploaded: strips keys
 * whose names indicate secrets, and redacts secret-shaped string values.
 */
export function scrubObject<T>(input: T, depth = 0): T {
  if (depth > 6 || input === null || input === undefined) return input;
  if (typeof input === 'string') {
    return (looksLikeSecretValue(input) ? REDACTED : input) as unknown as T;
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => scrubObject(v, depth + 1)) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveName(key) && key !== 'value_hash' && key !== 'candidate_email_hash' && key !== 'hash_salt') {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubObject(value, depth + 1);
  }
  return out as unknown as T;
}
