import type { EvidenceItem, SubmissionAssessment } from '../contract/schemas.js';
import type { SessionOutcome, SignalClass, SignalKind, SubmissionState } from '../contract/vocabulary.js';
import { clamp, round } from '../utils/time.js';

/**
 * Independent re-scoring of submission evidence.
 *
 * This is a deliberate re-implementation of the extension's fusion rule, not a shared
 * library. The point of recomputing server-side is that the number the browser reported
 * can be checked against the evidence it shipped — sharing the implementation would make
 * the check vacuous, and a compromised or stale client would verify itself.
 *
 * Fusion (DESIGN §6): noisy-OR over the strongest positive weight *per signal class*, so
 * independent weak signals accumulate but repeats of one class cannot inflate the score.
 * Each distinct negative kind then subtracts once.
 */

export interface ScoringConfig {
  weights: Record<SignalKind, number>;
  classes: Record<SignalKind, SignalClass>;
  confirm_threshold: number;
  submit_threshold: number;
  confirmation_required_class: SignalClass;
}

export const DEFAULT_SCORING: ScoringConfig = {
  weights: {
    submit_button_clicked: 0.2,
    form_submit_event: 0.4,
    submission_request: 0.6,
    submission_request_success: 0.8,
    confirmation_navigation: 0.8,
    confirmation_text: 0.9,
    success_toast: 0.85,
    confirmation_modal: 0.85,
    adapter_confirmation: 1.0,
    form_removed: 0.5,
    form_disabled: 0.45,
    application_status_changed: 0.9,
    validation_error_after_submit: -0.35,
    submission_request_failed: -0.4,
    form_still_present: -0.1,
  },
  classes: {
    submit_button_clicked: 'dom_intent',
    form_submit_event: 'dom_submit',
    submission_request: 'network',
    submission_request_success: 'network',
    confirmation_navigation: 'navigation',
    confirmation_text: 'confirmation',
    success_toast: 'confirmation',
    confirmation_modal: 'confirmation',
    adapter_confirmation: 'confirmation',
    application_status_changed: 'confirmation',
    form_removed: 'dom_submit',
    form_disabled: 'dom_submit',
    validation_error_after_submit: 'negative',
    submission_request_failed: 'negative',
    form_still_present: 'negative',
  },
  confirm_threshold: 0.85,
  submit_threshold: 0.5,
  confirmation_required_class: 'confirmation',
};

export interface RecomputedAssessment {
  score: number;
  state: SubmissionState;
  applied_clicked: boolean;
  submit_detected: boolean;
  confirmation_detected: boolean;
  /** Weight actually counted per class, so the arithmetic is inspectable. */
  counted_positive: { signal_class: SignalClass; kind: SignalKind; weight: number }[];
  counted_negative: { kind: SignalKind; weight: number }[];
  /** Evidence items whose reported weight disagreed with the configured weight. */
  reweighted: { kind: SignalKind; reported: number; expected: number }[];
}

/**
 * Recomputes score and state from an evidence array alone.
 *
 * Weights come from this service's configuration, never from the payload — a client
 * cannot raise its own score by inflating the weight it claims for a signal.
 */
export function recomputeAssessment(
  evidence: EvidenceItem[],
  negativeEvidence: EvidenceItem[],
  scoring: ScoringConfig = DEFAULT_SCORING,
): RecomputedAssessment {
  const reweighted: RecomputedAssessment['reweighted'] = [];
  const bestByClass = new Map<SignalClass, { kind: SignalKind; weight: number }>();
  const countedNegative = new Map<SignalKind, number>();

  const note = (item: EvidenceItem, expected: number) => {
    if (Math.abs(item.weight - expected) > 1e-9) {
      reweighted.push({ kind: item.kind, reported: item.weight, expected });
    }
  };

  for (const item of [...evidence, ...negativeEvidence]) {
    const expected = scoring.weights[item.kind] ?? 0;
    note(item, expected);
    const signalClass = scoring.classes[item.kind] ?? item.signal_class;

    if (expected < 0 || signalClass === 'negative') {
      if (!countedNegative.has(item.kind)) countedNegative.set(item.kind, expected);
      continue;
    }

    const current = bestByClass.get(signalClass);
    if (!current || expected > current.weight) bestByClass.set(signalClass, { kind: item.kind, weight: expected });
  }

  let positive = 0;
  for (const { weight } of bestByClass.values()) {
    positive = 1 - (1 - positive) * (1 - clamp(weight, 0, 1));
  }
  const penalty = [...countedNegative.values()].reduce((sum, w) => sum + w, 0);
  const score = round(clamp(positive + penalty, 0, 1));

  const kinds = new Set<SignalKind>([...evidence, ...negativeEvidence].map((e) => e.kind));
  const appliedClicked = kinds.has('submit_button_clicked');
  const confirmationDetected = bestByClass.has(scoring.confirmation_required_class);
  const submitDetected =
    kinds.has('form_submit_event') ||
    kinds.has('submission_request') ||
    kinds.has('submission_request_success') ||
    kinds.has('confirmation_navigation') ||
    confirmationDetected;

  const negativeKinds = new Set(countedNegative.keys());
  const state = deriveState({
    score,
    appliedClicked,
    submitDetected,
    confirmationDetected,
    negativeKinds,
    scoring,
  });

  return {
    score,
    state,
    applied_clicked: appliedClicked,
    submit_detected: submitDetected,
    confirmation_detected: confirmationDetected,
    counted_positive: [...bestByClass.entries()].map(([signal_class, v]) => ({ signal_class, ...v })),
    counted_negative: [...countedNegative.entries()].map(([kind, weight]) => ({ kind, weight })),
    reweighted,
  };
}

interface StateInput {
  score: number;
  appliedClicked: boolean;
  submitDetected: boolean;
  confirmationDetected: boolean;
  negativeKinds: Set<SignalKind>;
  scoring: ScoringConfig;
}

function deriveState(input: StateInput): SubmissionState {
  const { score, appliedClicked, submitDetected, confirmationDetected, negativeKinds, scoring } = input;

  // Confirmation is necessary but not sufficient — the fused score must clear the bar too.
  if (confirmationDetected && score >= scoring.confirm_threshold) return 'confirmed';

  const contradicted =
    negativeKinds.has('validation_error_after_submit') ||
    negativeKinds.has('submission_request_failed') ||
    negativeKinds.has('form_still_present');

  if (appliedClicked && !submitDetected) return contradicted ? 'click_without_submission' : 'clicked_only';
  if (submitDetected && !appliedClicked) return 'submission_without_click';
  if (submitDetected && score >= scoring.submit_threshold) return 'submitted';
  if (submitDetected) return 'clicked_only';
  return 'unknown';
}

export interface OutcomeInput {
  assessment: RecomputedAssessment;
  /** Whether any field reached `filled`. */
  anyFieldFilled: boolean;
  sessionState: string;
  endedAt: string | null | undefined;
  lastActivityAt: string | null | undefined;
  /** Session inactivity limit; matches the extension's SESSION_TIMEOUT_MS default. */
  timeoutMs?: number;
}

export interface OutcomeResolution {
  outcome: SessionOutcome;
  reasons: string[];
}

/**
 * Outcome resolution table from DESIGN §4.
 *
 * `confirmed` is never reachable from a click alone, and never from a score alone: it
 * requires a confirmation-class signal *and* a score at or above the threshold.
 */
export function resolveOutcome(input: OutcomeInput, scoring: ScoringConfig = DEFAULT_SCORING): OutcomeResolution {
  const { assessment, anyFieldFilled, sessionState, endedAt, lastActivityAt } = input;
  const timeoutMs = input.timeoutMs ?? 45 * 60_000;
  const reasons: string[] = [];

  if (assessment.confirmation_detected && assessment.score >= scoring.confirm_threshold) {
    reasons.push(`confidence ${assessment.score} >= ${scoring.confirm_threshold} with confirmation-class evidence`);
    return { outcome: 'confirmed', reasons };
  }

  const contradicted = assessment.counted_negative.length > 0;
  const submitEvidence = assessment.submit_detected || assessment.applied_clicked;

  if (submitEvidence && !assessment.confirmation_detected) {
    reasons.push(
      contradicted
        ? `submission evidence contradicted by ${assessment.counted_negative.map((n) => n.kind).join(', ')}`
        : 'submission evidence present but no confirmation-class signal was observed',
    );
    return { outcome: 'flagged', reasons };
  }

  if (assessment.confirmation_detected && assessment.score < scoring.confirm_threshold) {
    reasons.push(`confirmation-class evidence present but fused score ${assessment.score} is below threshold`);
    return { outcome: 'flagged', reasons };
  }

  const idleMs =
    lastActivityAt && endedAt ? new Date(endedAt).getTime() - new Date(lastActivityAt).getTime() : null;
  if (idleMs !== null && idleMs >= timeoutMs) {
    reasons.push(`no activity for ${Math.round(idleMs / 1000)}s before the session ended`);
    return { outcome: 'timed_out', reasons };
  }

  if (anyFieldFilled && !submitEvidence && sessionState === 'ended') {
    reasons.push('fields were filled but no submission evidence was observed before the session closed');
    return { outcome: 'abandoned', reasons };
  }

  reasons.push('insufficient evidence to resolve an outcome');
  return { outcome: 'unknown', reasons };
}

/** Convenience wrapper for recomputing straight from a reported assessment. */
export function recomputeFromAssessment(
  assessment: SubmissionAssessment,
  scoring: ScoringConfig = DEFAULT_SCORING,
): RecomputedAssessment {
  return recomputeAssessment(assessment.evidence, assessment.negative_evidence, scoring);
}
