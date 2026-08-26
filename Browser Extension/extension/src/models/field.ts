/**
 * Canonical field vocabulary and observed-field records.
 *
 * The canonical layer exists so that adapters and heuristics can disagree about DOM
 * structure while the backend sees one stable vocabulary.
 */

export const CANONICAL_FIELDS = [
  // identity
  'first_name',
  'last_name',
  'full_name',
  'preferred_name',
  // contact
  'email',
  'phone',
  'address',
  'address_line_2',
  'city',
  'state',
  'postal_code',
  'country',
  // employment
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
  // education
  'education_institution',
  'education_degree',
  'education_field',
  'graduation_year',
  // links & documents
  'linkedin_url',
  'github_url',
  'portfolio_url',
  'website',
  'resume',
  'cover_letter',
  // eligibility
  'work_authorization',
  'visa_status',
  'availability_date',
  'relocation',
  // demographic / sensitive
  'date_of_birth',
  'gender',
  'nationality',
  'national_id',
  'ssn',
  // credentials (never stored — recognised so they can be excluded)
  'password',
  'otp',
  'credit_card',
  'cvv',
  // fallback
  'unknown',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/**
 * Storage policy for an observed value.
 * - `storable`    : low-sensitivity, value may be persisted (length-capped, normalized)
 * - `hashed_only` : PII — only a salted hash and the match result leave the page
 * - `never_store` : credentials/financial — no value, no hash, metadata only
 */
export type Sensitivity = 'storable' | 'hashed_only' | 'never_store';

export type FieldState = 'empty' | 'partial' | 'filled';

export type MatchResult = 'match' | 'mismatch' | 'unverifiable' | 'not_available';

export type InputMethod =
  | 'typed'
  | 'pasted'
  | 'autofilled'
  | 'programmatic'
  | 'mixed'
  | 'unknown';

export type ControlKind =
  | 'input'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'contenteditable'
  | 'custom';

/** Which signals contributed to the canonical mapping — kept for auditability. */
export type IdentificationSignal =
  | 'adapter'
  | 'autocomplete'
  | 'label'
  | 'aria_label'
  | 'name'
  | 'id'
  | 'placeholder'
  | 'surrounding_text'
  | 'input_type'
  | 'dom_structure';

export interface FieldDescriptor {
  kind: ControlKind;
  tag: string;
  input_type: string | null;
  /** Redacted/normalized hints only — never raw user values. */
  name_hint: string | null;
  id_hint: string | null;
  label_hint: string | null;
  placeholder_hint: string | null;
  aria_label_hint: string | null;
  autocomplete: string | null;
  /** Stable-ish CSS-ish locator for debugging; contains no values. */
  dom_path: string;
  signals: IdentificationSignal[];
  /** 0..1 confidence in the canonical mapping. */
  confidence: number;
}

export interface FieldInteraction {
  focus_count: number;
  first_focus_at: string | null;
  last_focus_at: string | null;
  last_blur_at: string | null;
  time_in_field_ms: number;
  /** Count only. Raw keys are never recorded. */
  keystroke_count: number;
  paste_count: number;
  /** Number of times a non-empty value was changed after first being filled. */
  edit_count: number;
  clear_count: number;
  fill_sequence_number: number | null;
  first_fill_at: string | null;
  last_change_at: string | null;
  skipped: boolean;
}

export interface FieldRecord {
  field_id: string;
  canonical_field: CanonicalField;
  instance_index: number;
  /** Grouping key for repeated blocks, e.g. `employer`. */
  group_key: string | null;
  descriptor: FieldDescriptor;
  sensitivity: Sensitivity;
  required: boolean;
  state: FieldState;
  input_method: InputMethod;
  interaction: FieldInteraction;
  /** Present only when sensitivity === 'storable'. */
  value: string | null;
  /** Present only when sensitivity === 'hashed_only'. */
  value_hash: string | null;
  /** Redacted placeholder shown in payloads for non-storable values. */
  value_redacted: boolean;
  value_length: number;
  match_result: MatchResult;
  /** Free-form, non-sensitive note explaining an `unverifiable` result. */
  match_note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  visible: boolean;
  /** Set when the control disappeared from the DOM (step navigation, submit). */
  detached_at: string | null;
}

export function emptyInteraction(): FieldInteraction {
  return {
    focus_count: 0,
    first_focus_at: null,
    last_focus_at: null,
    last_blur_at: null,
    time_in_field_ms: 0,
    keystroke_count: 0,
    paste_count: 0,
    edit_count: 0,
    clear_count: 0,
    fill_sequence_number: null,
    first_fill_at: null,
    last_change_at: null,
    skipped: false,
  };
}
