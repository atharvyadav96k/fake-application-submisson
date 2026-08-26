/**
 * Submission evidence model.
 *
 * The score is always accompanied by the evidence that produced it, including the
 * weight applied to each item, so the number is reproducible and auditable offline.
 */

export const SIGNAL_KINDS = [
  'submit_button_clicked',
  'form_submit_event',
  'submission_request',
  'submission_request_success',
  'confirmation_navigation',
  'confirmation_text',
  'success_toast',
  'confirmation_modal',
  'adapter_confirmation',
  'form_removed',
  'form_disabled',
  'application_status_changed',
  'validation_error_after_submit',
  'submission_request_failed',
  'form_still_present',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * Signal classes exist so that repeats of the same class cannot inflate the score:
 * fusion keeps only the strongest contribution per class.
 */
export type SignalClass = 'dom_intent' | 'dom_submit' | 'network' | 'navigation' | 'confirmation' | 'negative';

export interface SubmissionSignal {
  kind: SignalKind;
  signal_class: SignalClass;
  timestamp: string;
  monotonic_ms: number;
  /** Non-sensitive, human-readable justification. */
  detail: string;
  /** Additional structured, already-redacted context. */
  context?: Record<string, unknown>;
}

export interface EvidenceItem {
  kind: SignalKind;
  signal_class: SignalClass;
  timestamp: string;
  weight: number;
  detail: string;
  /** False when the signal was superseded by a stronger one in its class. */
  counted: boolean;
}

export type SubmissionState =
  | 'unknown'
  | 'clicked_only'
  | 'click_without_submission'
  | 'submission_without_click'
  | 'submitted'
  | 'confirmed';

export interface SubmissionAssessment {
  applied_clicked: boolean;
  submit_detected: boolean;
  confirmation_detected: boolean;
  state: SubmissionState;
  confidence_score: number;
  /** Names only — convenient for quick queries. Full detail in `evidence`. */
  evidence_kinds: string[];
  evidence: EvidenceItem[];
  /** Signals that reduced confidence. */
  negative_evidence: EvidenceItem[];
  evaluated_at: string;
  /** Explains a low/ambiguous score in plain language. Never a verdict. */
  notes: string[];
  /**
   * Sanitized text captured near the clicked control (and any status/alert regions on
   * the page) when a submit was detected but no confirmation ever was — so a reviewer
   * can see roughly what the page actually said, instead of just "unconfirmed". Same
   * redaction pipeline as everywhere else (`sanitizeText`): no raw field values, no
   * emails/phones/tokens. Captured once per session, never a full-page dump.
   */
  context_excerpt: string | null;
  /**
   * Which control was actually clicked to trigger the submit-adjacent evidence, and what
   * it said — a reviewer should be able to see "the Apply button, labelled 'Apply Now'"
   * rather than just "a click happened somewhere". Text is sanitized/capped the same as
   * everywhere else; `dom_path` is structural only (tag/class/position, no attribute
   * values), same as field descriptors already carry.
   */
  clicked_control: { text: string | null; tag: string | null; dom_path: string | null } | null;
}

export function emptyAssessment(now: string): SubmissionAssessment {
  return {
    applied_clicked: false,
    submit_detected: false,
    confirmation_detected: false,
    state: 'unknown',
    confidence_score: 0,
    evidence_kinds: [],
    evidence: [],
    negative_evidence: [],
    evaluated_at: now,
    notes: [],
    context_excerpt: null,
    clicked_control: null,
  };
}
