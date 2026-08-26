import type { CanonicalField, MatchResult, Sensitivity } from '@/models/field';
import type { CandidateRecord } from '@/models/session';
import {
  hashValue,
  normalizeForCompare,
  normalizePhone,
  normalizeUrlValue,
  safeEqual,
} from '@/utils/hashing';

/**
 * Local comparison of observed values against the candidate record.
 *
 * Comparison always happens in the page — the backend receives a verdict and, at most,
 * a salted hash. When we cannot compare (no record, no value, unsupported field) the
 * answer is `unverifiable`/`not_available`, never `mismatch`.
 */

export interface MatchOutcome {
  match_result: MatchResult;
  note: string | null;
}

/** Field-specific normalization so formatting differences are not reported as mismatches. */
export function normalizeByField(canonical: CanonicalField, value: string): string {
  switch (canonical) {
    case 'phone':
      return normalizePhone(value);
    case 'linkedin_url':
    case 'github_url':
    case 'portfolio_url':
    case 'website':
      return normalizeUrlValue(value);
    case 'experience_years': {
      const num = /(\d+(?:\.\d+)?)/.exec(value);
      return num ? String(Number(num[1])) : normalizeForCompare(value);
    }
    case 'postal_code':
      return normalizeForCompare(value).replace(/\s+/g, '');
    case 'date_of_birth':
    case 'employer_start_date':
    case 'employer_end_date':
    case 'availability_date':
      return normalizeDate(value);
    default:
      return normalizeForCompare(value);
  }
}

/** Best-effort date normalization to `YYYY-MM-DD`; falls back to plain normalization. */
function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  // Ambiguous between D/M/Y and M/D/Y: only normalize when one reading is impossible.
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    if (a > 12 && b <= 12) return `${dmy[3]}-${pad(String(b))}-${pad(String(a))}`;
    if (b > 12 && a <= 12) return `${dmy[3]}-${pad(String(a))}-${pad(String(b))}`;
    return normalizeForCompare(trimmed);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return normalizeForCompare(trimmed);
}

function pad(v: string): string {
  return v.padStart(2, '0');
}

/**
 * Fields where a substring relationship is a legitimate match: portals split or join
 * names and titles inconsistently.
 */
const LENIENT_FIELDS = new Set<CanonicalField>([
  'full_name',
  'address',
  'current_job_title',
  'employer_title',
  'education_institution',
  'education_field',
  'cover_letter',
]);

export async function matchField(params: {
  canonical: CanonicalField;
  sensitivity: Sensitivity;
  observedValue: string | null;
  candidate: CandidateRecord | null;
  salt: string;
}): Promise<MatchOutcome> {
  const { canonical, sensitivity, observedValue, candidate, salt } = params;

  if (!candidate) return { match_result: 'not_available', note: 'no candidate record supplied' };
  if (canonical === 'unknown') {
    return { match_result: 'unverifiable', note: 'field could not be mapped to a canonical name' };
  }
  if (sensitivity === 'never_store' || observedValue === null) {
    // Credential-grade fields are never compared: we do not read their values at all.
    return { match_result: 'unverifiable', note: 'value is not readable under the privacy policy' };
  }
  if (observedValue.trim() === '') {
    return { match_result: 'unverifiable', note: 'field is empty' };
  }

  const expectedRaw = candidate.fields?.[canonical];
  const expectedHash = candidate.hashed_fields?.[canonical];

  if (expectedRaw === undefined && expectedHash === undefined) {
    return { match_result: 'not_available', note: `candidate record has no ${canonical}` };
  }

  // Hash-only comparison path: the backend never gave us the plaintext.
  if (expectedRaw === undefined && expectedHash !== undefined) {
    const observedHash = await hashValue(normalizeByField(canonical, observedValue), salt);
    if (!expectedHash.startsWith('sha256:') && !expectedHash.startsWith('fnv:')) {
      return { match_result: 'unverifiable', note: 'candidate hash is in an unrecognised format' };
    }
    return {
      match_result: safeEqual(observedHash, expectedHash) ? 'match' : 'mismatch',
      note: safeEqual(observedHash, expectedHash) ? null : 'hashed comparison differed',
    };
  }

  const expected = normalizeByField(canonical, String(expectedRaw));
  const observed = normalizeByField(canonical, observedValue);

  if (expected === '') return { match_result: 'not_available', note: 'candidate value is empty' };
  if (safeEqual(observed, expected)) return { match_result: 'match', note: null };

  if (LENIENT_FIELDS.has(canonical)) {
    if (observed.includes(expected) || expected.includes(observed)) {
      return { match_result: 'match', note: 'matched as a substring (portal splits this field)' };
    }
    // Name components in any order, e.g. "Doe, Jane" vs "Jane Doe".
    const a = new Set(observed.split(' ').filter(Boolean));
    const b = expected.split(' ').filter(Boolean);
    if (b.length > 1 && b.every((t) => a.has(t))) {
      return { match_result: 'match', note: 'all expected tokens present in a different order' };
    }
  }

  if (canonical === 'resume') {
    // The value is a file-count sentinel; the file's contents are never inspected.
    return { match_result: 'unverifiable', note: 'file contents are never read' };
  }

  return { match_result: 'mismatch', note: 'normalized values differ' };
}
