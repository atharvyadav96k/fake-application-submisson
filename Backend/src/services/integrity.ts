import type { FieldRecord, SessionPayload } from '../contract/schemas.js';
import { HASHED_ONLY_FIELDS, NEVER_STORE_FIELDS } from '../contract/vocabulary.js';
import { durationMs } from '../utils/time.js';
import { recomputeFromAssessment, resolveOutcome, type RecomputedAssessment } from './scoring.js';

/**
 * Machine-checkable integrity and privacy verification of a finalized payload.
 *
 * Everything here is deterministic and reproducible from the stored record — no model,
 * no heuristics about people. Findings describe the *evidence*, never the candidate.
 * Where a determination cannot be made the check stays silent rather than guessing.
 */

export type IssueSeverity = 'info' | 'warning' | 'critical';

export interface IntegrityIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  context?: Record<string, unknown>;
}

export interface VerificationResult {
  recomputed: RecomputedAssessment;
  reported_score: number;
  score_matches: boolean;
  score_delta: number;
  state_matches: boolean;
  derived_outcome: string;
  outcome_matches: boolean;
  issues: IntegrityIssue[];
}

/** Scores may differ in the last decimal through float/serialization noise. */
const SCORE_TOLERANCE = 0.005;

export function verifyPayload(payload: SessionPayload): VerificationResult {
  const issues: IntegrityIssue[] = [];
  const recomputed = recomputeFromAssessment(payload.submission);
  const reportedScore = payload.submission.confidence_score;
  const scoreDelta = Number((recomputed.score - reportedScore).toFixed(6));
  const scoreMatches = Math.abs(scoreDelta) <= SCORE_TOLERANCE;
  const stateMatches = recomputed.state === payload.submission.state;

  const anyFieldFilled = payload.fields.some((f) => f.state === 'filled');
  const derived = resolveOutcome({
    assessment: recomputed,
    anyFieldFilled,
    sessionState: payload.session.state,
    endedAt: payload.session.timestamps.ended,
    lastActivityAt: payload.session.timestamps.last_activity,
  });
  const outcomeMatches = derived.outcome === payload.session.outcome;

  issues.push(...checkPrivacy(payload));
  issues.push(...checkScoring(payload, recomputed, scoreMatches, scoreDelta, stateMatches));
  issues.push(...checkOutcome(payload, derived.outcome, outcomeMatches, derived.reasons));
  issues.push(...checkTimeline(payload));
  issues.push(...checkCoverage(payload));

  return {
    recomputed,
    reported_score: reportedScore,
    score_matches: scoreMatches,
    score_delta: scoreDelta,
    state_matches: stateMatches,
    derived_outcome: derived.outcome,
    outcome_matches: outcomeMatches,
    issues,
  };
}

/**
 * Privacy invariants (DESIGN §8).
 *
 * These are hard guarantees the extension claims to enforce before data leaves the page.
 * Verifying them again here means a bug or a tampered client is visible in the record
 * rather than silently accepted — the value is quarantined at ingest either way.
 */
function checkPrivacy(payload: SessionPayload): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const neverStore = new Set<string>(NEVER_STORE_FIELDS);
  const hashedOnly = new Set<string>(HASHED_ONLY_FIELDS);

  for (const field of payload.fields) {
    const where = { field_id: field.field_id, canonical_field: field.canonical_field };

    if (neverStore.has(field.canonical_field) && (field.value !== null || field.value_hash !== null)) {
      issues.push({
        code: 'privacy.never_store_value_present',
        severity: 'critical',
        message: `Field '${field.canonical_field}' is never_store but arrived carrying a value or hash.`,
        context: where,
      });
    }

    if (hashedOnly.has(field.canonical_field) && field.value !== null) {
      issues.push({
        code: 'privacy.plaintext_for_hashed_field',
        severity: 'critical',
        message: `Field '${field.canonical_field}' must be hashed_only but arrived with a plaintext value.`,
        context: where,
      });
    }

    if (field.sensitivity === 'never_store' && field.value_hash !== null) {
      issues.push({
        code: 'privacy.hash_for_never_store_field',
        severity: 'critical',
        message: `Field '${field.canonical_field}' is marked never_store but carries a hash.`,
        context: where,
      });
    }

    if (field.descriptor.input_type === 'password' && (field.value !== null || field.value_hash !== null)) {
      issues.push({
        code: 'privacy.password_input_captured',
        severity: 'critical',
        message: 'A password-type input arrived with captured content.',
        context: where,
      });
    }
  }

  const email = payload.session.candidate_email;
  if (email && email !== '[REDACTED]' && email.includes('@')) {
    issues.push({
      code: 'privacy.plaintext_candidate_email',
      severity: 'critical',
      message: 'Session carried a plaintext candidate email; only the hash should leave the browser.',
    });
  }

  if (payload.session.hash_salt) {
    issues.push({
      code: 'privacy.hash_salt_transmitted',
      severity: 'warning',
      message: 'Per-session hash salt was transmitted; it is stripped here and must not leave the browser.',
    });
  }

  return issues;
}

function checkScoring(
  payload: SessionPayload,
  recomputed: RecomputedAssessment,
  scoreMatches: boolean,
  scoreDelta: number,
  stateMatches: boolean,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];

  if (!scoreMatches) {
    issues.push({
      code: 'scoring.score_mismatch',
      severity: 'warning',
      message: `Reported confidence ${payload.submission.confidence_score} does not reproduce from the evidence (recomputed ${recomputed.score}).`,
      context: { delta: scoreDelta },
    });
  }

  if (!stateMatches) {
    issues.push({
      code: 'scoring.state_mismatch',
      severity: 'warning',
      message: `Reported submission state '${payload.submission.state}' differs from the state derived here ('${recomputed.state}').`,
    });
  }

  if (recomputed.reweighted.length > 0) {
    issues.push({
      code: 'scoring.weight_mismatch',
      severity: 'warning',
      message: 'One or more evidence items carried a weight different from this deployment’s configuration.',
      context: { items: recomputed.reweighted.slice(0, 10) },
    });
  }

  // Contract violation rather than a disagreement: `confirmed` requires confirmation evidence.
  if (payload.submission.state === 'confirmed' && !recomputed.confirmation_detected) {
    issues.push({
      code: 'scoring.confirmed_without_confirmation_evidence',
      severity: 'critical',
      message: "Submission is reported 'confirmed' but no confirmation-class evidence is present.",
    });
  }

  if (payload.submission.confirmation_detected && !recomputed.confirmation_detected) {
    issues.push({
      code: 'scoring.confirmation_flag_unsupported',
      severity: 'warning',
      message: 'confirmation_detected is set but no confirmation-class evidence item was supplied.',
    });
  }

  return issues;
}

function checkOutcome(
  payload: SessionPayload,
  derivedOutcome: string,
  outcomeMatches: boolean,
  reasons: string[],
): IntegrityIssue[] {
  if (outcomeMatches) return [];
  return [
    {
      code: 'outcome.mismatch',
      severity: payload.session.outcome === 'confirmed' && derivedOutcome !== 'confirmed' ? 'critical' : 'warning',
      message: `Reported outcome '${payload.session.outcome}' differs from the outcome derived here ('${derivedOutcome}').`,
      context: { derived_reasons: reasons },
    },
  ];
}

function checkTimeline(payload: SessionPayload): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const t = payload.session.timestamps;

  const ordered: [string, string | null | undefined, string, string | null | undefined][] = [
    ['selected', t.selected, 'first_fill', t.first_fill],
    ['first_fill', t.first_fill, 'applied_clicked', t.applied_clicked],
    ['applied_clicked', t.applied_clicked, 'submit_detected', t.submit_detected],
    ['submit_detected', t.submit_detected, 'confirmed', t.confirmed],
  ];

  for (const [fromName, from, toName, to] of ordered) {
    const delta = durationMs(from, to);
    if (delta !== null && delta < 0) {
      issues.push({
        code: 'timeline.out_of_order',
        severity: 'warning',
        message: `'${toName}' precedes '${fromName}' by ${Math.abs(delta)}ms.`,
      });
    }
  }

  if (t.confirmed && !t.submit_detected) {
    issues.push({
      code: 'timeline.confirmed_without_submit',
      severity: 'warning',
      message: 'A confirmation timestamp exists without a submit_detected timestamp.',
    });
  }

  const duration = durationMs(payload.session.created_at, t.ended ?? payload.session.updated_at);
  if (duration !== null && duration < 0) {
    issues.push({
      code: 'timeline.negative_duration',
      severity: 'warning',
      message: 'Session ended before it was created.',
    });
  }

  return issues;
}

/**
 * Coverage and consistency of the evidence itself.
 *
 * These are observations about the *record*, not conclusions about a person: a filled
 * field with no interaction evidence may be an autofill, a paste the observer missed, or
 * a portal that repopulates its own form. The record says what was seen; a human decides.
 */
function checkCoverage(payload: SessionPayload): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const filled = payload.fields.filter((f) => f.state === 'filled');

  if (payload.fields.length === 0) {
    issues.push({
      code: 'coverage.no_fields_observed',
      severity: 'info',
      message: 'No form fields were observed in this session.',
    });
  }

  const unexplained = filled.filter(
    (f) => f.interaction.keystroke_count === 0 && f.interaction.paste_count === 0 && f.interaction.focus_count === 0,
  );
  if (unexplained.length > 0) {
    issues.push({
      code: 'coverage.filled_without_interaction',
      severity: 'info',
      message: `${unexplained.length} field(s) reached 'filled' with no observed focus, keystroke or paste.`,
      context: { fields: unexplained.slice(0, 20).map(describeField) },
    });
  }

  const requiredEmpty = payload.fields.filter((f) => f.required && f.state === 'empty');
  if (requiredEmpty.length > 0 && payload.submission.state === 'confirmed') {
    issues.push({
      code: 'coverage.required_field_empty_on_confirmed',
      severity: 'warning',
      message: `${requiredEmpty.length} required field(s) were still empty on a confirmed submission.`,
      context: { fields: requiredEmpty.slice(0, 20).map(describeField) },
    });
  }

  const mismatches = payload.fields.filter((f) => f.match_result === 'mismatch');
  if (mismatches.length > 0) {
    issues.push({
      code: 'coverage.candidate_mismatch',
      severity: 'warning',
      message: `${mismatches.length} field(s) did not match the candidate record.`,
      context: { fields: mismatches.slice(0, 20).map(describeField) },
    });
  }

  const lowConfidence = payload.fields.filter((f) => f.canonical_field === 'unknown');
  if (lowConfidence.length > 0) {
    issues.push({
      code: 'coverage.unidentified_fields',
      severity: 'info',
      message: `${lowConfidence.length} field(s) could not be mapped to the canonical vocabulary.`,
    });
  }

  if (payload.events.some((e) => e.event_type === 'buffer_truncated')) {
    issues.push({
      code: 'coverage.buffer_truncated',
      severity: 'warning',
      message: 'The event buffer hit its cap during this session; the record is incomplete.',
    });
  }

  if (payload.session.candidate_record_opened_before_fill === false) {
    issues.push({
      code: 'coverage.fill_before_candidate_record',
      severity: 'info',
      message: 'Form filling began before the candidate record was opened.',
    });
  }

  return issues;
}

function describeField(field: FieldRecord): Record<string, unknown> {
  return {
    field_id: field.field_id,
    canonical_field: field.canonical_field,
    instance_index: field.instance_index,
    input_method: field.input_method,
  };
}
