import { z } from 'zod';
import {
  CANONICAL_FIELDS,
  CONTROL_KINDS,
  EVENT_TYPES,
  FIELD_STATES,
  IDENTIFICATION_SIGNALS,
  INPUT_METHODS,
  MATCH_RESULTS,
  SENSITIVITIES,
  SESSION_OUTCOMES,
  SESSION_STATES,
  SIGNAL_CLASSES,
  SIGNAL_KINDS,
  SUBMISSION_STATES,
} from './vocabulary.js';

/**
 * Wire-contract validation.
 *
 * Two rules shape everything below:
 *
 *  1. **Reject what is malformed, tolerate what is merely new.** Unknown *keys* are
 *     stripped rather than rejected, so a newer extension build that adds a field does
 *     not take the fleet offline. Unknown *enum members* are rejected, because a value
 *     outside the vocabulary cannot be interpreted or scored.
 *  2. **Bound everything.** Every string and array has a cap. This endpoint is the only
 *     way untrusted-ish data enters storage.
 */

const iso = z.string().datetime({ offset: true }).or(z.string().datetime());
const nullableIso = iso.nullable();
const uuidish = z.string().min(8).max(128);
const shortText = z.string().max(512);
const longText = z.string().max(4_000);

export const CanonicalFieldSchema = z.enum(CANONICAL_FIELDS);

export const EventPageContextSchema = z
  .object({
    domain: z.string().max(255),
    path: z.string().max(2_048),
    sanitized_url: z.string().max(2_048),
    title: shortText,
    frame: z.enum(['top', 'iframe']),
    frame_url: z.string().max(2_048).optional(),
  })
  .strip();

export const EventFieldContextSchema = z
  .object({
    field_id: z.string().max(128),
    canonical_name: CanonicalFieldSchema,
    instance_index: z.number().int().min(0).max(1_000),
    group_key: z.string().max(128).nullish(),
  })
  .strip();

export const ActivityEventSchema = z
  .object({
    schema_version: z.string().max(16),
    event_id: uuidish,
    session_id: uuidish,
    timestamp: iso,
    monotonic_ms: z.number().min(0).max(1e12),
    event_type: z.enum(EVENT_TYPES),
    page: EventPageContextSchema,
    field: EventFieldContextSchema.optional(),
    metadata: z.record(z.unknown()).default({}),
    // Truncated rather than capped-and-rejected: some call sites build this from a full
    // network request URL, which routinely exceeds any fixed limit on real portals. This
    // is an idempotency hint, not evidence — losing the tail of an overlong key only
    // coarsens deduping, whereas rejecting it used to fail the entire containing batch or
    // finalize payload outright, silently dropping every real event alongside it.
    dedupe_key: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : v.slice(0, 256))),
  })
  .strip();

export const EnvironmentSchema = z
  .object({
    browser: z.string().max(64),
    browser_version: z.string().max(64),
    engine: z.string().max(64).nullable(),
    platform: z.string().max(64).nullable(),
    extension_version: z.string().max(32),
    timestamp: iso,
    timezone: z.string().max(64),
    timezone_offset_minutes: z.number().int().min(-900).max(900),
    language: z.string().max(32).nullable(),
    viewport: z
      .object({ width: z.number().int().min(0).max(100_000), height: z.number().int().min(0).max(100_000) })
      .strip()
      .nullable(),
  })
  .strip();

export const EventBatchSchema = z
  .object({
    schema_version: z.string().max(16),
    session_id: uuidish,
    batch_id: uuidish,
    events: z.array(ActivityEventSchema).min(1),
    environment: EnvironmentSchema,
    sent_at: iso,
    attempt: z.number().int().min(1).max(1_000),
  })
  .strip();

/* ── Session ─────────────────────────────────────────────────────────────────── */

export const SessionTimestampsSchema = z
  .object({
    selected: nullableIso,
    candidate_record_opened: nullableIso,
    first_field_fill_at: nullableIso,
    first_fill: nullableIso,
    applied_clicked: nullableIso,
    submit_detected: nullableIso,
    confirmed: nullableIso,
    last_activity: nullableIso,
    ended: nullableIso,
  })
  .partial()
  .strip();

export const SessionSchema = z
  .object({
    schema_version: z.string().max(16),
    session_id: uuidish,
    operator_id: z.string().max(128).nullable(),
    candidate_id: z.string().max(128).nullable(),
    candidate_email: shortText,
    candidate_email_hash: z.string().max(128).nullable(),
    portal_domain: z.string().max(255),
    matched_adapter: z.enum(['known', 'unknown']),
    adapter_name: z.string().max(128),
    timestamps: SessionTimestampsSchema,
    candidate_record_opened_before_fill: z.boolean().nullable(),
    state: z.enum(SESSION_STATES),
    outcome: z.enum(SESSION_OUTCOMES),
    outcome_reasons: z.array(shortText).max(50).default([]),
    // Accepted but never persisted — see `stripSecrets` in the ingest service.
    hash_salt: z.string().max(256).optional(),
    created_at: iso,
    updated_at: iso,
  })
  .strip();

/* ── Pages ───────────────────────────────────────────────────────────────────── */

export const JobContextSchema = z
  .object({
    title: shortText.nullable(),
    company: shortText.nullable(),
    location: shortText.nullable(),
    employment_type: shortText.nullable(),
    date_posted: z.string().max(64).nullable(),
    requisition_id: z.string().max(128).nullable(),
    source: z.enum(['json_ld', 'meta']),
  })
  .strip();

export const PageContentSchema = z
  .object({
    headline: shortText.nullable(),
    summary: longText.nullable(),
    site_name: shortText.nullable(),
    job: JobContextSchema.nullable(),
    sections: z.array(shortText).max(50).default([]),
    status_text: z.array(shortText).max(50).default([]),
    captured_at: iso,
    truncated: z.boolean(),
  })
  .strip();

export const PageRecordSchema = z
  .object({
    page_id: z.string().max(128),
    sanitized_url: z.string().max(2_048),
    domain: z.string().max(255),
    path: z.string().max(2_048),
    title: shortText,
    referrer: z.string().max(2_048).nullable(),
    entry_point: z.enum(['initial_load', 'spa_navigation', 'full_navigation', 'iframe', 'unknown']),
    frame: z.enum(['top', 'iframe']),
    page_type: z.string().max(64),
    first_seen_at: iso,
    last_seen_at: iso,
    sequence: z.number().int().min(0),
    content: PageContentSchema.nullish(),
  })
  .strip();

/* ── Fields ──────────────────────────────────────────────────────────────────── */

export const FieldDescriptorSchema = z
  .object({
    kind: z.enum(CONTROL_KINDS),
    tag: z.string().max(32),
    input_type: z.string().max(32).nullable(),
    name_hint: z.string().max(256).nullable(),
    id_hint: z.string().max(256).nullable(),
    label_hint: z.string().max(256).nullable(),
    placeholder_hint: z.string().max(256).nullable(),
    aria_label_hint: z.string().max(256).nullable(),
    autocomplete: z.string().max(64).nullable(),
    dom_path: z.string().max(1_024),
    signals: z.array(z.enum(IDENTIFICATION_SIGNALS)).max(20).default([]),
    confidence: z.number().min(0).max(1),
  })
  .strip();

export const FieldInteractionSchema = z
  .object({
    focus_count: z.number().int().min(0),
    first_focus_at: nullableIso,
    last_focus_at: nullableIso,
    last_blur_at: nullableIso,
    time_in_field_ms: z.number().min(0),
    keystroke_count: z.number().int().min(0),
    paste_count: z.number().int().min(0),
    edit_count: z.number().int().min(0),
    clear_count: z.number().int().min(0),
    fill_sequence_number: z.number().int().min(0).nullable(),
    first_fill_at: nullableIso,
    last_change_at: nullableIso,
    skipped: z.boolean(),
  })
  .strip();

export const FieldRecordSchema = z
  .object({
    field_id: z.string().max(128),
    canonical_field: CanonicalFieldSchema,
    instance_index: z.number().int().min(0).max(1_000),
    group_key: z.string().max(128).nullable(),
    descriptor: FieldDescriptorSchema,
    sensitivity: z.enum(SENSITIVITIES),
    required: z.boolean(),
    state: z.enum(FIELD_STATES),
    input_method: z.enum(INPUT_METHODS),
    interaction: FieldInteractionSchema,
    value: z.string().max(512).nullable(),
    value_hash: z.string().max(128).nullable(),
    value_redacted: z.boolean(),
    value_length: z.number().int().min(0),
    match_result: z.enum(MATCH_RESULTS),
    match_note: shortText.nullable(),
    first_seen_at: iso,
    last_seen_at: iso,
    visible: z.boolean(),
    detached_at: nullableIso,
  })
  .strip();

/* ── Submission ──────────────────────────────────────────────────────────────── */

export const EvidenceItemSchema = z
  .object({
    kind: z.enum(SIGNAL_KINDS),
    signal_class: z.enum(SIGNAL_CLASSES),
    timestamp: iso,
    weight: z.number().min(-1).max(1),
    detail: longText,
    counted: z.boolean(),
  })
  .strip();

export const SubmissionAssessmentSchema = z
  .object({
    applied_clicked: z.boolean(),
    submit_detected: z.boolean(),
    confirmation_detected: z.boolean(),
    state: z.enum(SUBMISSION_STATES),
    confidence_score: z.number().min(0).max(1),
    evidence_kinds: z.array(z.string().max(64)).max(64).default([]),
    evidence: z.array(EvidenceItemSchema).max(500).default([]),
    negative_evidence: z.array(EvidenceItemSchema).max(500).default([]),
    evaluated_at: iso,
    notes: z.array(longText).max(50).default([]),
    /** Sanitized text near the clicked control/status regions, captured once when submitted-but-unconfirmed. */
    context_excerpt: longText.nullable().default(null),
    /** Which control was clicked and what it said — text/tag/structural path only, no attribute values. */
    clicked_control: z
      .object({
        text: shortText.nullable(),
        tag: z.string().max(32).nullable(),
        dom_path: z.string().max(1_024).nullable(),
      })
      .nullable()
      .default(null),
  })
  .strip();

export const FillOrderEntrySchema = z
  .object({
    canonical_field: CanonicalFieldSchema,
    instance_index: z.number().int().min(0),
    field_id: z.string().max(128),
    fill_sequence_number: z.number().int().min(0),
    timestamp: iso,
  })
  .strip();

export const SessionPayloadSchema = z
  .object({
    schema_version: z.string().max(16),
    session: SessionSchema,
    pages: z.array(PageRecordSchema).max(500).default([]),
    fields: z.array(FieldRecordSchema).max(1_000).default([]),
    events: z.array(ActivityEventSchema).max(10_000).default([]),
    submission: SubmissionAssessmentSchema,
    fill_order: z.array(FillOrderEntrySchema).max(1_000).default([]),
    environment: EnvironmentSchema,
    partial: z.boolean().default(false),
    generated_at: iso,
  })
  .strip();

/* ── Candidate record (backend -> extension) ─────────────────────────────────── */

export const CandidateUpsertSchema = z
  .object({
    /** The identifier operators actually use. `candidate_id` is derived from it if omitted. */
    email: z.string().email().max(256),
    candidate_id: z.string().min(1).max(128).optional(),
    fields: z.record(CanonicalFieldSchema, z.string().max(512)).default({}),
    hashed_fields: z.record(CanonicalFieldSchema, z.string().max(160)).default({}),
  })
  .strip();

export const SessionBindingSchema = z
  .object({
    session_id: uuidish,
    candidate_id: z.string().min(1).max(128),
    operator_id: z.string().max(128).nullish(),
  })
  .strip();

/** Starts a session for a candidate identified only by email — no operator/candidate id required. */
export const StartSessionSchema = z
  .object({
    candidate_email: z.string().email().max(256),
    operator_id: z.string().max(128).nullish(),
    /** Which client/company this application is for, if the operator picked one. */
    client_id: z.string().max(64).nullish(),
  })
  .strip();

/* ── Auth / accounts ─────────────────────────────────────────────────────────── */

const ROLE = z.enum(['admin', 'manager', 'user']);

export const LoginSchema = z
  .object({
    email: z.string().trim().email().max(256),
    password: z.string().min(1).max(512),
  })
  .strip();

/** Legacy alias kept for the extension's original field names. */
export const ExtensionLoginSchema = LoginSchema;

export const SignupSchema = z
  .object({
    email: z.string().trim().email().max(256),
    password: z.string().min(8).max(512),
    name: z.string().trim().min(1).max(128),
  })
  .strip();

export const ChangePasswordSchema = z
  .object({
    old_password: z.string().min(1).max(512),
    new_password: z.string().min(8).max(512),
  })
  .strip();

export const WhitelistAddSchema = z
  .object({
    email: z.string().trim().email().max(256),
    role: ROLE.default('user'),
  })
  .strip();

export const SetUserActiveSchema = z
  .object({
    active: z.boolean(),
  })
  .strip();

/* ── Clients ─────────────────────────────────────────────────────────────────── */

export const ClientUpsertSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    domain: z.string().trim().max(255).optional().default(''),
    contact_email: z.string().trim().max(256).optional().default(''),
    phone: z.string().trim().max(64).optional().default(''),
    notes: z.string().trim().max(2000).optional().default(''),
  })
  .strip();

export const ClientListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strip();

/* ── Applications ────────────────────────────────────────────────────────────── */

export const ApplicationListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strip();

export const ManualApplicationSchema = z
  .object({
    client_id: z.string().min(1).max(64),
    portal: z.string().trim().min(1).max(200),
    status: z.enum(['Applied', 'Not Applied']).default('Applied'),
    business_date: z.string().trim().max(32).optional(),
    notes: z.string().trim().max(2000).optional().default(''),
  })
  .strip();

export const VerifyApplicationSchema = z
  .object({
    trust_score: z.coerce.number().min(0).max(100),
  })
  .strip();

/* ── Derived types ───────────────────────────────────────────────────────────── */

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type EventBatch = z.infer<typeof EventBatchSchema>;
export type EnvironmentInfo = z.infer<typeof EnvironmentSchema>;
export type SessionRecord = z.infer<typeof SessionSchema>;
export type PageRecord = z.infer<typeof PageRecordSchema>;
export type FieldRecord = z.infer<typeof FieldRecordSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type SubmissionAssessment = z.infer<typeof SubmissionAssessmentSchema>;
export type FillOrderEntry = z.infer<typeof FillOrderEntrySchema>;
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;
export type CandidateUpsert = z.infer<typeof CandidateUpsertSchema>;
export type SessionBinding = z.infer<typeof SessionBindingSchema>;
export type StartSession = z.infer<typeof StartSessionSchema>;
export type ExtensionLogin = z.infer<typeof ExtensionLoginSchema>;
export type Login = z.infer<typeof LoginSchema>;
export type Signup = z.infer<typeof SignupSchema>;
export type ChangePassword = z.infer<typeof ChangePasswordSchema>;
export type WhitelistAdd = z.infer<typeof WhitelistAddSchema>;
export type SetUserActive = z.infer<typeof SetUserActiveSchema>;
export type ClientUpsert = z.infer<typeof ClientUpsertSchema>;
export type ManualApplication = z.infer<typeof ManualApplicationSchema>;
export type VerifyApplication = z.infer<typeof VerifyApplicationSchema>;
