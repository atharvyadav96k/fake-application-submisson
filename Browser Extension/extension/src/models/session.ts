import type { CanonicalField, MatchResult } from './field';

export type SessionOutcome = 'confirmed' | 'flagged' | 'abandoned' | 'timed_out' | 'unknown';

export type SessionState = 'active' | 'paused' | 'ended';

export type AdapterMatch = 'known' | 'unknown';

export interface SessionTimestamps {
  selected: string | null;
  candidate_record_opened: string | null;
  first_field_fill_at: string | null;
  first_fill: string | null;
  applied_clicked: string | null;
  submit_detected: string | null;
  confirmed: string | null;
  last_activity: string | null;
  ended: string | null;
}

export interface Session {
  schema_version: string;
  session_id: string;
  operator_id: string | null;
  candidate_id: string | null;
  /** Always redacted in payloads; the hash below is what leaves the browser. */
  candidate_email: string;
  candidate_email_hash: string | null;
  portal_domain: string;
  matched_adapter: AdapterMatch;
  adapter_name: string;
  timestamps: SessionTimestamps;
  candidate_record_opened_before_fill: boolean | null;
  state: SessionState;
  outcome: SessionOutcome;
  /** Explains how the outcome was reached. Never a hiring judgement. */
  outcome_reasons: string[];
  /** Per-session salt for value hashing; never sent to the backend. */
  hash_salt: string;
  created_at: string;
  updated_at: string;
}

/** Candidate record supplied by the backend for local-only comparison. */
export interface CandidateRecord {
  candidate_id: string;
  /** The identifier the operator actually selected the candidate by. Display only. */
  email?: string;
  /** Values keyed by canonical field. Kept in memory/session storage only. */
  fields: Partial<Record<CanonicalField, string>>;
  /** Fields the backend can only supply as a hash. */
  hashed_fields?: Partial<Record<CanonicalField, string>>;
  fetched_at: string;
}

export interface FieldMatchSummary {
  canonical_field: CanonicalField;
  instance_index: number;
  match_result: MatchResult;
}
