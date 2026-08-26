import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { SESSION_OUTCOMES, SESSION_STATES, SUBMISSION_STATES } from '../../contract/vocabulary.js';

/**
 * A verification session.
 *
 * The document holds three distinct layers, deliberately kept apart:
 *
 *  · `session` / `submission` / `pages` / `fields` — what the extension reported, stored
 *    verbatim so the record stays faithful to what the browser actually observed.
 *  · `verification` — what this service independently recomputed from the same evidence.
 *  · `analysis` — what the AI model concluded. Advisory, never authoritative.
 *
 * A reviewer can always tell which layer a statement came from.
 */

const Mixed = Schema.Types.Mixed;

const VerificationSchema = new Schema(
  {
    /** Score recomputed server-side from the stored evidence array. */
    recomputed_score: { type: Number, default: null },
    reported_score: { type: Number, default: null },
    score_matches: { type: Boolean, default: null },
    score_delta: { type: Number, default: null },
    recomputed_state: { type: String, enum: SUBMISSION_STATES, default: null },
    state_matches: { type: Boolean, default: null },
    /** Outcome this service derives from the DESIGN §4 resolution table. */
    derived_outcome: { type: String, enum: SESSION_OUTCOMES, default: null },
    outcome_matches: { type: Boolean, default: null },
    /** Machine-checkable integrity problems (privacy violations, gaps, contradictions). */
    issues: {
      type: [
        new Schema(
          {
            code: { type: String, required: true },
            severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
            message: { type: String, required: true },
            context: { type: Mixed, default: {} },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    verified_at: { type: Date, default: null },
  },
  { _id: false },
);

const SessionSchema = new Schema(
  {
    session_id: { type: String, required: true, unique: true, index: true },
    schema_version: { type: String, required: true },

    operator_id: { type: String, default: null, index: true },
    candidate_id: { type: String, default: null, index: true },
    /** Only ever the hash. The plaintext address is stripped at ingest. */
    candidate_email_hash: { type: String, default: null },

    /** The authenticated portal account this application belongs to (ownership/visibility). */
    user_id: { type: Schema.Types.ObjectId, ref: 'UiUser', default: null, index: true },
    /** The client/company this application was submitted to, if known. */
    client_id: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    /** True for a one-shot record created via `POST /v1/applications/manual` instead of
     *  observed by the extension. Manual entries always start unverified with a trust
     *  score of 0 until a manager/admin reviews and sets one. */
    manual_entry: { type: Boolean, default: false, index: true },
    manual_verification: {
      verified: { type: Boolean, default: false },
      verified_by: { type: Schema.Types.ObjectId, ref: 'UiUser', default: null },
      verified_at: { type: Date, default: null },
      trust_score: { type: Number, default: null },
    },

    portal_domain: { type: String, default: '', index: true },
    /** Every distinct domain the session's pages visited, in order of first appearance — the full redirect chain (e.g. a job board handing off to the employer's own ATS), not just where it started. */
    portal_domains: { type: [String], default: [] },
    matched_adapter: { type: String, enum: ['known', 'unknown'], default: 'unknown' },
    adapter_name: { type: String, default: 'generic' },

    state: { type: String, enum: SESSION_STATES, default: 'active', index: true },
    outcome: { type: String, enum: SESSION_OUTCOMES, default: 'unknown', index: true },
    outcome_reasons: { type: [String], default: [] },
    candidate_record_opened_before_fill: { type: Boolean, default: null },

    timestamps: {
      selected: { type: Date, default: null },
      candidate_record_opened: { type: Date, default: null },
      first_field_fill_at: { type: Date, default: null },
      first_fill: { type: Date, default: null },
      applied_clicked: { type: Date, default: null },
      submit_detected: { type: Date, default: null },
      confirmed: { type: Date, default: null },
      last_activity: { type: Date, default: null },
      ended: { type: Date, default: null },
    },

    /** Latest assessment reported by the extension, verbatim. */
    submission: { type: Mixed, default: null },
    pages: { type: [Mixed], default: [] },
    fields: { type: [Mixed], default: [] },
    fill_order: { type: [Mixed], default: [] },
    environment: { type: Mixed, default: null },

    verification: { type: VerificationSchema, default: () => ({}) },

    /** Denormalised counters so list views never scan the event collection. */
    stats: {
      event_count: { type: Number, default: 0 },
      batch_count: { type: Number, default: 0 },
      duplicate_event_count: { type: Number, default: 0 },
      field_count: { type: Number, default: 0 },
      filled_field_count: { type: Number, default: 0 },
      page_count: { type: Number, default: 0 },
      duration_ms: { type: Number, default: null },
      time_to_first_fill_ms: { type: Number, default: null },
      total_keystrokes: { type: Number, default: 0 },
      total_pastes: { type: Number, default: 0 },
      autofilled_field_count: { type: Number, default: 0 },
    },

    finalized: { type: Boolean, default: false, index: true },
    finalized_at: { type: Date, default: null },
    /** Fingerprint of the finalize payload, so an identical retry is a cheap no-op. */
    finalize_fingerprint: { type: String, default: null },
    finalize_count: { type: Number, default: 0 },

    /** Latest AI analysis, embedded for read-time convenience. History lives in Analysis.
     *  Includes `submission_assessment`/`portal_legitimacy` — the AI's own additive
     *  verdicts, shown beside but never replacing the deterministic outcome above. */
    latest_analysis: { type: Mixed, default: null },

    first_seen_at: { type: Date, required: true, default: () => new Date() },
    last_event_at: { type: Date, default: null },
    created_at: { type: Date, default: null },
    updated_at: { type: Date, default: null },
  },
  { collection: 'sessions', versionKey: false, minimize: false, timestamps: { createdAt: 'db_created_at', updatedAt: 'db_updated_at' } },
);

// Review queue: newest first, filtered by outcome/portal.
SessionSchema.index({ finalized_at: -1 });
SessionSchema.index({ outcome: 1, finalized_at: -1 });
SessionSchema.index({ portal_domain: 1, finalized_at: -1 });
SessionSchema.index({ candidate_id: 1, finalized_at: -1 });
SessionSchema.index({ user_id: 1, first_seen_at: -1 });

export type SessionDoc = InferSchemaType<typeof SessionSchema>;

export const SessionModel: Model<SessionDoc> = model<SessionDoc>('Session', SessionSchema);
