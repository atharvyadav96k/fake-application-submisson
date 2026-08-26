import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Candidate reference data used for *local* comparison inside the browser.
 *
 * The extension fetches this, compares in-page, and sends back only match results and
 * hashes. Prefer populating `hashed_fields`: the extension can compare a hash without
 * the plaintext ever entering a portal page context.
 */
const CandidateSchema = new Schema(
  {
    candidate_id: { type: String, required: true, unique: true, index: true },
    /** The operator-facing identifier — candidates are looked up and selected by this. */
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    /** Low-sensitivity values only (company, city, job title, public URLs). */
    fields: { type: Map, of: String, default: () => new Map<string, string>() },
    /** `sha256(<session hash_salt>|<normalized value>)` per canonical field. */
    hashed_fields: { type: Map, of: String, default: () => new Map<string, string>() },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'candidates', versionKey: false, minimize: false },
);

export type CandidateDoc = InferSchemaType<typeof CandidateSchema>;

export const CandidateModel: Model<CandidateDoc> = model<CandidateDoc>('Candidate', CandidateSchema);

/**
 * Binds a session to the candidate it is supposed to be an application for.
 *
 * Kept separate from the session document because the binding is created by the ATS
 * *before* the extension has reported anything about that session.
 */
const SessionBindingSchema = new Schema(
  {
    session_id: { type: String, required: true, unique: true, index: true },
    candidate_id: { type: String, required: true, index: true },
    operator_id: { type: String, default: null, index: true },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'session_bindings', versionKey: false },
);

export type SessionBindingDoc = InferSchemaType<typeof SessionBindingSchema>;

export const SessionBindingModel: Model<SessionBindingDoc> = model<SessionBindingDoc>(
  'SessionBinding',
  SessionBindingSchema,
);
