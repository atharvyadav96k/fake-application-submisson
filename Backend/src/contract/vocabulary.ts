/**
 * The shared vocabulary, mirrored from the extension's models.
 *
 * These lists are the contract. They are kept as `const` tuples so both the Zod schemas
 * and the scoring engine derive from exactly one definition — a new event type or signal
 * kind is added here and nowhere else.
 */

export const SCHEMA_VERSION = '1.0';

export const EVENT_TYPES = [
  // session lifecycle
  'session_started',
  'session_resumed',
  'session_paused',
  'session_finalized',
  'buffer_truncated',
  // page / navigation
  'page_view',
  'page_transition',
  'frame_attached',
  // candidate record
  'candidate_record_opened',
  // field lifecycle & interaction
  'field_discovered',
  'field_focus',
  'field_blur',
  'field_input',
  'field_change',
  'field_paste',
  'field_autofill',
  'field_fill',
  'field_edit',
  'field_cleared',
  'field_skip',
  'field_detached',
  // submission signals
  'submit_button_click',
  'form_submit',
  'network_request',
  'navigation_confirmation',
  'dom_confirmation',
  'validation_error',
  'form_removed',
  'form_disabled',
  'submission_evaluated',
  // diagnostics
  'extension_error',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const CANONICAL_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'preferred_name',
  'email',
  'phone',
  'address',
  'address_line_2',
  'city',
  'state',
  'postal_code',
  'country',
  'current_company',
  'current_job_title',
  'employer_name',
  'employer_title',
  'employer_start_date',
  'employer_end_date',
  'experience_years',
  'notice_period',
  'current_salary',
  'expected_salary',
  'education_institution',
  'education_degree',
  'education_field',
  'graduation_year',
  'linkedin_url',
  'github_url',
  'portfolio_url',
  'website',
  'resume',
  'cover_letter',
  'work_authorization',
  'visa_status',
  'availability_date',
  'relocation',
  'date_of_birth',
  'gender',
  'nationality',
  'national_id',
  'ssn',
  'password',
  'otp',
  'credit_card',
  'cvv',
  'unknown',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

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

export const SIGNAL_CLASSES = [
  'dom_intent',
  'dom_submit',
  'network',
  'navigation',
  'confirmation',
  'negative',
] as const;

export type SignalClass = (typeof SIGNAL_CLASSES)[number];

export const SUBMISSION_STATES = [
  'unknown',
  'clicked_only',
  'click_without_submission',
  'submission_without_click',
  'submitted',
  'confirmed',
] as const;

export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SESSION_OUTCOMES = ['confirmed', 'flagged', 'abandoned', 'timed_out', 'unknown'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export const SESSION_STATES = ['active', 'paused', 'ended'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SENSITIVITIES = ['storable', 'hashed_only', 'never_store'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const MATCH_RESULTS = ['match', 'mismatch', 'unverifiable', 'not_available'] as const;
export type MatchResult = (typeof MATCH_RESULTS)[number];

export const INPUT_METHODS = ['typed', 'pasted', 'autofilled', 'programmatic', 'mixed', 'unknown'] as const;
export type InputMethod = (typeof INPUT_METHODS)[number];

export const FIELD_STATES = ['empty', 'partial', 'filled'] as const;
export type FieldState = (typeof FIELD_STATES)[number];

export const CONTROL_KINDS = [
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'file',
  'contenteditable',
  'custom',
] as const;

export const IDENTIFICATION_SIGNALS = [
  'adapter',
  'autocomplete',
  'label',
  'aria_label',
  'name',
  'id',
  'placeholder',
  'surrounding_text',
  'input_type',
  'dom_structure',
] as const;

/** Canonical fields whose values must never reach this service in any form. */
export const NEVER_STORE_FIELDS: readonly CanonicalField[] = [
  'password',
  'otp',
  'credit_card',
  'cvv',
  'ssn',
  'national_id',
];

/** Canonical fields that may only ever arrive as a salted hash. */
export const HASHED_ONLY_FIELDS: readonly CanonicalField[] = [
  'email',
  'phone',
  'date_of_birth',
  'address',
  'address_line_2',
  'postal_code',
  'full_name',
  'first_name',
  'last_name',
  'preferred_name',
  'nationality',
  'gender',
  'current_salary',
  'expected_salary',
];
