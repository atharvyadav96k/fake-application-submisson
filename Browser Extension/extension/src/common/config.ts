import type { SignalClass, SignalKind } from '@/models/submission';

/**
 * All tunables live here. Anything a deployment may want to change — scoring weights,
 * thresholds, batching, endpoints — must be configurable rather than hard-coded at a
 * call site.
 */

export interface ScoringConfig {
  /** Weight per signal kind. Positive weights are fused with noisy-OR. */
  weights: Record<SignalKind, number>;
  /** Signal kind -> class. Only the strongest weight per class is counted. */
  classes: Record<SignalKind, SignalClass>;
  /** Score at/above which a session may be marked `confirmed`. */
  confirm_threshold: number;
  /** Score at/above which submission is considered `submitted`. */
  submit_threshold: number;
  /**
   * `confirmed` additionally requires at least one signal of this class. A click
   * or even a successful POST alone can never produce `confirmed`.
   */
  confirmation_required_class: SignalClass;
}

export interface ExtensionConfig {
  schema_version: string;
  api: {
    base_url: string;
    events_path: string;
    finalize_path: string;
    candidate_path: string;
    /** Directory the popup's candidate picker lists. */
    candidates_path: string;
    /** Picks a candidate by email, gets back a fresh session id bound to them. */
    start_session_path: string;
    /** Operator email/password sign-in; returns a JWT used on every subsequent call. */
    login_path: string;
    /** Directory of clients an application can be attributed to. */
    clients_path: string;
    timeout_ms: number;
    max_batch_size: number;
    max_retries: number;
    base_backoff_ms: number;
    max_backoff_ms: number;
  };
  buffering: {
    /** Content -> background flush cadence. */
    flush_interval_ms: number;
    flush_max_events: number;
    /** Background -> backend cadence (also the chrome.alarms period). */
    upload_interval_minutes: number;
    max_stored_events: number;
    dedupe_window_ms: number;
  };
  session: {
    timeout_ms: number;
    /** Grace window after a submit click in which a network request still counts. */
    submit_correlation_window_ms: number;
    /** Window after submit in which validation errors count as negative evidence. */
    validation_window_ms: number;
  };
  dom: {
    /** Debounce for reacting to MutationObserver batches. */
    mutation_debounce_ms: number;
    /** Max elements inspected in a single incremental scan. */
    max_scan_nodes: number;
    /** Minimum confidence for accepting a canonical field mapping. */
    field_match_min_confidence: number;
    /** Cap on stored field values (chars) for `storable` fields. */
    max_stored_value_length: number;
    /** Max text captured for confirmation excerpts. */
    max_excerpt_length: number;
    /** Idle time after input before the field is considered "filled". */
    fill_settle_ms: number;
  };
  /**
   * Capture of text the *page* publishes (headings, meta description, structured job
   * data, status announcements). Never captures markup, and never captures text from a
   * form control or a `contenteditable` region — that is candidate input, and it belongs
   * to the field pipeline where the sensitivity policy applies.
   */
  content_capture: {
    enabled: boolean;
    /** schema.org JobPosting from JSON-LD, falling back to Open Graph tags. */
    capture_job_posting: boolean;
    /** Section and step headings. */
    capture_headings: boolean;
    /** Meta description / og:description. */
    capture_summary: boolean;
    /** Text from `role="status"` / `role="alert"` / `aria-live` regions. */
    capture_status: boolean;
    max_headings: number;
    max_status_items: number;
    /** Cap per individual string. */
    max_item_chars: number;
    /** Cap across the whole per-page capture. */
    max_total_chars: number;
  };
  privacy: {
    /** Canonical fields whose values must never be stored, in any form. */
    never_store_fields: string[];
    /** Canonical fields stored as salted hashes only. */
    hashed_fields: string[];
    /** Query parameters redacted from every URL. */
    redacted_query_params: string[];
    /** If true, `storable` values are also hashed rather than kept in plain text. */
    hash_all_values: boolean;
  };
  network: {
    /** Path fragments that make a request look submission-related. */
    submission_path_hints: string[];
    /** Methods that can carry a submission. */
    submission_methods: string[];
    /** Requests to these path fragments are ignored entirely (analytics, telemetry). */
    ignored_path_hints: string[];
  };
  confirmation: {
    /** Case-insensitive phrases indicating success. Keyed for reporting. */
    phrases: { key: string; pattern: string }[];
    /** Selectors commonly used for toasts/alerts. */
    success_selectors: string[];
    /** Selectors commonly used for validation errors. */
    error_selectors: string[];
  };
  /** Portal origins the extension is allowed to observe. */
  allowed_origins: string[];
  debug: boolean;
}

const WEIGHTS: Record<SignalKind, number> = {
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
};

const CLASSES: Record<SignalKind, SignalClass> = {
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
};

export const DEFAULT_SCORING: ScoringConfig = {
  weights: WEIGHTS,
  classes: CLASSES,
  confirm_threshold: 0.85,
  submit_threshold: 0.5,
  confirmation_required_class: 'confirmation',
};

export const DEFAULT_CONFIG: ExtensionConfig = {
  schema_version: '1.0',
  api: {
    // Points at this repo's own Backend (`npm run dev` → http://127.0.0.1:8080).
    // Override via a managed-storage config for any other deployment.
    base_url: 'http://127.0.0.1:8080',
    events_path: '/v1/activity/events',
    finalize_path: '/v1/activity/sessions/{session_id}/finalize',
    candidate_path: '/v1/activity/sessions/{session_id}/candidate',
    candidates_path: '/v1/candidates',
    start_session_path: '/v1/candidates/start',
    login_path: '/v1/auth/login',
    clients_path: '/v1/clients',
    timeout_ms: 15_000,
    max_batch_size: 100,
    max_retries: 8,
    base_backoff_ms: 2_000,
    max_backoff_ms: 5 * 60_000,
  },
  buffering: {
    flush_interval_ms: 750,
    flush_max_events: 25,
    upload_interval_minutes: 1,
    max_stored_events: 5_000,
    dedupe_window_ms: 1_000,
  },
  session: {
    timeout_ms: 45 * 60_000,
    submit_correlation_window_ms: 15_000,
    validation_window_ms: 8_000,
  },
  dom: {
    mutation_debounce_ms: 300,
    max_scan_nodes: 400,
    field_match_min_confidence: 0.45,
    max_stored_value_length: 120,
    max_excerpt_length: 160,
    fill_settle_ms: 1_200,
  },
  privacy: {
    never_store_fields: ['password', 'otp', 'credit_card', 'cvv', 'ssn', 'national_id'],
    hashed_fields: [
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
    ],
    redacted_query_params: [
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'auth',
      'authorization',
      'apikey',
      'api_key',
      'key',
      'secret',
      'client_secret',
      'password',
      'pwd',
      'passwd',
      'sessionid',
      'session_id',
      'sid',
      'jsessionid',
      'phpsessid',
      'sig',
      'signature',
      'code',
      'state',
      'otp',
      'ssn',
      'email',
      'e-mail',
      'phone',
      'mobile',
    ],
    hash_all_values: false,
  },
  content_capture: {
    enabled: true,
    capture_job_posting: true,
    capture_headings: true,
    capture_summary: true,
    capture_status: true,
    max_headings: 12,
    max_status_items: 5,
    max_item_chars: 160,
    max_total_chars: 1500,
  },
  network: {
    submission_path_hints: [
      'apply',
      'application',
      'applications',
      'submit',
      'submission',
      'candidate',
      'job-application',
      'jobapplication',
      'careers/apply',
      // Deliberately NOT 'graphql': a single GraphQL endpoint serves every mutation a
      // site has (autosave, follow, notifications, the real apply — all the same path).
      // Path alone can never tell those apart; GraphQL calls fall through to the
      // click-correlation check instead of being counted outright.
    ],
    submission_methods: ['POST', 'PUT', 'PATCH'],
    ignored_path_hints: [
      'analytics',
      'telemetry',
      'metrics',
      'beacon',
      'collect',
      'sentry',
      'datadog',
      'segment',
      'gtm',
      'google-analytics',
      'hotjar',
      'heartbeat',
      'ping',
      // Routine background actions a portal fires constantly that are not the
      // submission itself, even though their paths often contain 'apply'/'application'.
      'draft',
      'autosave',
      'auto-save',
      'follow',
      'unfollow',
      'notification',
      'unread',
      'bookmark',
      'save-job',
      'savejob',
    ],
  },
  confirmation: {
    phrases: [
      { key: 'application_submitted', pattern: 'application (has been )?submitted' },
      { key: 'application_received', pattern: 'application (has been )?received' },
      { key: 'successfully_applied', pattern: 'successfully applied' },
      { key: 'application_complete', pattern: 'application (is )?complete' },
      { key: 'thank_you_for_applying', pattern: 'thank you for (applying|your application)' },
      { key: 'we_have_received', pattern: "we('ve| have) received your application" },
      { key: 'submitted_successfully', pattern: 'submitted successfully' },
      { key: 'applied', pattern: '\\bapplied\\b.*\\bsuccess' },
      // A real Naukri direct-apply session titled its confirmation page exactly this,
      // with no other confirmation wording on it — the generic phrase list otherwise
      // never matched, and the session scored 0.84 but stayed unconfirmed and flagged.
      { key: 'apply_confirmation', pattern: '\\bapply confirmation\\b' },
    ],
    success_selectors: [
      '[role="status"]',
      '[role="alert"][data-status="success"]',
      '.toast-success',
      '.alert-success',
      '.notification--success',
      '[data-testid*="success" i]',
      '[class*="confirmation" i]',
    ],
    error_selectors: [
      '[aria-invalid="true"]',
      '[role="alert"]',
      '.error',
      '.field-error',
      '.invalid-feedback',
      '[data-testid*="error" i]',
      '[class*="error" i]',
    ],
  },
  // Empty = observe every origin the manifest grants us. Populate it to restrict again.
  allowed_origins: [],
  debug: false,
};

/** Deep-merges a partial override onto the defaults. Arrays are replaced, not merged. */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override as T;
  if (typeof override !== 'object' || Array.isArray(override)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? mergeConfig(out[k], v) : v;
  }
  return out as T;
}

let activeConfig: ExtensionConfig = DEFAULT_CONFIG;

export function getConfig(): ExtensionConfig {
  return activeConfig;
}

export function setConfig(override: Partial<ExtensionConfig> | ExtensionConfig): void {
  activeConfig = mergeConfig(DEFAULT_CONFIG, override);
}

export function resetConfig(): void {
  activeConfig = DEFAULT_CONFIG;
}
