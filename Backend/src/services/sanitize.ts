import type { FieldRecord, SessionPayload } from '../contract/schemas.js';
import { HASHED_ONLY_FIELDS, NEVER_STORE_FIELDS } from '../contract/vocabulary.js';

/**
 * Ingest-boundary privacy enforcement.
 *
 * The extension is supposed to apply the sensitivity policy before anything leaves the
 * page. This service does not trust that: whatever arrives is normalised here, before it
 * reaches storage, so a client bug cannot persist a credential in this database.
 *
 * `verifyPayload` reports *that* a violation happened; this function makes sure the
 * offending value is not what gets written. Both run — the record notes the violation
 * and the value is gone.
 */

export interface SanitizeResult {
  payload: SessionPayload;
  /** Codes for what had to be stripped, for the ingest log and the session record. */
  stripped: string[];
}

export function sanitizeSessionPayload(input: SessionPayload): SanitizeResult {
  const stripped: string[] = [];
  const neverStore = new Set<string>(NEVER_STORE_FIELDS);
  const hashedOnly = new Set<string>(HASHED_ONLY_FIELDS);

  const session = { ...input.session };

  // The per-session salt is what makes the value hashes non-reversible by us. Storing it
  // next to the hashes would defeat the whole point of hashing them.
  if (session.hash_salt) {
    delete (session as { hash_salt?: string }).hash_salt;
    stripped.push('session.hash_salt');
  }

  if (session.candidate_email && session.candidate_email.includes('@')) {
    session.candidate_email = '[REDACTED]';
    stripped.push('session.candidate_email');
  }

  const fields = input.fields.map((field): FieldRecord => {
    const isNeverStore = neverStore.has(field.canonical_field) || field.sensitivity === 'never_store';
    const isPasswordControl = field.descriptor.input_type === 'password';

    if (isNeverStore || isPasswordControl) {
      if (field.value !== null || field.value_hash !== null) {
        stripped.push(`field.${field.canonical_field}.value`);
      }
      return { ...field, value: null, value_hash: null, value_redacted: true };
    }

    if (hashedOnly.has(field.canonical_field) && field.value !== null) {
      stripped.push(`field.${field.canonical_field}.plaintext`);
      return { ...field, value: null, value_redacted: true };
    }

    return field;
  });

  return { payload: { ...input, session, fields }, stripped };
}
