import type { CanonicalField } from './field';

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

export type FrameContext = 'top' | 'iframe';

export interface EventPageContext {
  domain: string;
  path: string;
  /** Query-sanitized URL. Never contains tokens/keys. */
  sanitized_url: string;
  title: string;
  frame: FrameContext;
  /** Present for iframes; sanitized. */
  frame_url?: string;
}

export interface EventFieldContext {
  field_id: string;
  canonical_name: CanonicalField;
  instance_index: number;
  group_key?: string | null;
}

export interface ActivityEvent<M = Record<string, unknown>> {
  schema_version: string;
  event_id: string;
  session_id: string;
  timestamp: string;
  /** ms since the content-script context started; robust to clock changes. */
  monotonic_ms: number;
  event_type: EventType;
  page: EventPageContext;
  field?: EventFieldContext;
  metadata: M;
  /**
   * Optional idempotency key. Two events with the same dedupe_key inside the
   * dedupe window collapse into one. Used for high-frequency signals.
   */
  dedupe_key?: string;
}

/** Metadata payloads for the events that carry structured data. */

export interface NetworkRequestMeta {
  method: string;
  /** Sanitized. */
  url: string;
  origin_kind: 'same_origin' | 'cross_origin';
  status: number | null;
  ok: boolean | null;
  duration_ms: number | null;
  transport: 'fetch' | 'xhr' | 'beacon' | 'navigation';
  looks_like_submission: boolean;
  /** Which heuristics fired, e.g. ['method_post','path_apply','after_click']. */
  reasons: string[];
  /** Body is NEVER captured. Present only as a size hint. */
  request_body_bytes: number | null;
}

export interface DomConfirmationMeta {
  /** Matched phrase key, not the full page text. */
  matcher: string;
  /** Short, redacted excerpt (<= 160 chars) for auditability. */
  excerpt: string;
  source: 'text' | 'toast' | 'modal' | 'status_change' | 'adapter';
  selector: string | null;
}

export interface ValidationErrorMeta {
  count: number;
  /** Canonical fields that reported an error, where identifiable. */
  fields: CanonicalField[];
  excerpt: string | null;
}
