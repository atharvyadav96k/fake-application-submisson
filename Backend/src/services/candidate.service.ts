import type { CandidateUpsert, SessionBinding, StartSession } from '../contract/schemas.js';
import { CandidateModel, SessionBindingModel } from '../db/models/candidate.model.js';
import { SessionModel } from '../db/models/session.model.js';
import { notFound } from '../utils/errors.js';
import { sha256Hex, uuid } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

/**
 * Candidate reference data for in-browser comparison.
 *
 * This is the one endpoint that sends data *to* the extension, so it is the one place
 * where PII could be pushed into a job-portal page context. Deployments should populate
 * `hashed_fields` wherever possible and keep `fields` to low-sensitivity values only —
 * the extension can decide `match` / `mismatch` from a hash alone.
 */

export interface CandidateRecordResponse {
  candidate_id: string;
  email: string;
  fields: Record<string, string>;
  hashed_fields: Record<string, string>;
  fetched_at: string;
}

/** Deterministic id from the email, so operators never have to invent or type one. */
function candidateIdFromEmail(email: string): string {
  return `cand_${sha256Hex(email.trim().toLowerCase()).slice(0, 16)}`;
}

export async function upsertCandidate(input: CandidateUpsert): Promise<CandidateRecordResponse> {
  const now = new Date();
  const email = input.email.trim().toLowerCase();
  const candidateId = input.candidate_id ?? candidateIdFromEmail(email);

  const doc = await CandidateModel.findOneAndUpdate(
    { candidate_id: candidateId },
    {
      $setOnInsert: { candidate_id: candidateId, created_at: now },
      $set: { email, fields: input.fields, hashed_fields: input.hashed_fields, updated_at: now },
    },
    { upsert: true, new: true },
  ).lean();

  return toResponse(doc);
}

export interface CandidateListItem {
  candidate_id: string;
  email: string;
  latest_session_id: string | null;
  state: string | null;
  outcome: string | null;
  /** Total sessions ever started for this candidate — a candidate can have any number. */
  attempt_count: number;
}

/** Directory operators pick from — email is the only identifier they ever see. */
export async function listCandidates(): Promise<CandidateListItem[]> {
  const candidates = await CandidateModel.find().sort({ email: 1 }).lean();
  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.candidate_id);
  const sessions = await SessionModel.find({ candidate_id: { $in: ids } })
    .select('candidate_id session_id state outcome first_seen_at')
    .sort({ first_seen_at: -1 })
    .lean();

  const latestByCandidate = new Map<string, (typeof sessions)[number]>();
  const countByCandidate = new Map<string, number>();
  for (const session of sessions) {
    if (!session.candidate_id) continue;
    countByCandidate.set(session.candidate_id, (countByCandidate.get(session.candidate_id) ?? 0) + 1);
    if (!latestByCandidate.has(session.candidate_id)) latestByCandidate.set(session.candidate_id, session);
  }

  return candidates.map((c) => {
    const latest = latestByCandidate.get(c.candidate_id);
    return {
      candidate_id: c.candidate_id,
      email: c.email,
      latest_session_id: latest?.session_id ?? null,
      state: latest?.state ?? null,
      outcome: latest?.outcome ?? null,
      attempt_count: countByCandidate.get(c.candidate_id) ?? 0,
    };
  });
}

export interface StartSessionResult {
  session_id: string;
  candidate_id: string;
  email: string;
}

/**
 * Creates a fresh session id bound to a candidate identified only by email, so an
 * operator never has to know or type an operator id or candidate id — they select a
 * candidate by email and this is the one call that starts the paper trail.
 *
 * `authenticatedUser` is the real logged-in account starting the session (from the JWT,
 * not anything the client claims) — it is what makes the resulting application show up
 * under the right person on the frontend, and `client_id` (also from the request) is
 * which company the application is for, if the operator picked one.
 */
export async function startSessionForEmail(
  input: StartSession,
  authenticatedUser: { id: string },
): Promise<StartSessionResult> {
  const email = input.candidate_email.trim().toLowerCase();
  const candidate = await CandidateModel.findOne({ email }).lean();
  if (!candidate) throw notFound(`No candidate with email '${email}'`);

  const sessionId = uuid();
  await SessionBindingModel.create({
    session_id: sessionId,
    candidate_id: candidate.candidate_id,
    operator_id: input.operator_id ?? authenticatedUser.id,
    created_at: new Date(),
  });

  // Pre-create the session shell so ownership/client attribution exist before the
  // extension ever streams an event — `ingest.service.ts`'s `$setOnInsert`/`$set` never
  // touch these fields, so they survive the later event/finalize writes untouched.
  await SessionModel.updateOne(
    { session_id: sessionId },
    {
      $setOnInsert: {
        session_id: sessionId,
        schema_version: '1.0',
        candidate_id: candidate.candidate_id,
        operator_id: input.operator_id ?? authenticatedUser.id,
        user_id: authenticatedUser.id,
        client_id: input.client_id ?? null,
        state: 'active',
        outcome: 'unknown',
        first_seen_at: new Date(),
      },
    },
    { upsert: true },
  );

  return { session_id: sessionId, candidate_id: candidate.candidate_id, email: candidate.email };
}

export async function bindSession(input: SessionBinding): Promise<{ session_id: string; candidate_id: string }> {
  const exists = await CandidateModel.exists({ candidate_id: input.candidate_id });
  if (!exists) throw notFound(`No candidate '${input.candidate_id}'`);

  await SessionBindingModel.updateOne(
    { session_id: input.session_id },
    {
      $setOnInsert: { session_id: input.session_id, created_at: new Date() },
      $set: { candidate_id: input.candidate_id, operator_id: input.operator_id ?? null },
    },
    { upsert: true },
  );

  return { session_id: input.session_id, candidate_id: input.candidate_id };
}

/**
 * Resolves the candidate for a session.
 *
 * The binding is the authority. If the ATS never bound the session, we fall back to the
 * candidate_id the extension itself reported — and if neither exists we return 404
 * rather than guessing, because handing the wrong person's record to a page would be
 * both a privacy incident and a false mismatch.
 */
export async function getCandidateForSession(sessionId: string): Promise<CandidateRecordResponse> {
  const binding = await SessionBindingModel.findOne({ session_id: sessionId }).lean();
  let candidateId = binding?.candidate_id ?? null;

  if (!candidateId) {
    const session = await SessionModel.findOne({ session_id: sessionId }).select('candidate_id').lean();
    candidateId = session?.candidate_id ?? null;
  }

  if (!candidateId) throw notFound(`No candidate is bound to session '${sessionId}'`);

  const doc = await CandidateModel.findOne({ candidate_id: candidateId }).lean();
  if (!doc) throw notFound(`No candidate '${candidateId}'`);

  return toResponse(doc);
}

function toResponse(doc: Record<string, any> | null): CandidateRecordResponse {
  if (!doc) throw notFound('Candidate not found');
  return {
    candidate_id: doc.candidate_id,
    email: doc.email ?? '',
    fields: mapToObject(doc.fields),
    hashed_fields: mapToObject(doc.hashed_fields),
    fetched_at: nowIso(),
  };
}

/** Mongoose `Map` fields come back as a Map from documents and a plain object from lean(). */
function mapToObject(value: unknown): Record<string, string> {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  return { ...(value as Record<string, string>) };
}
