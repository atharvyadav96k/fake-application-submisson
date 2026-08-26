import type { ManualApplication } from '../contract/schemas.js';
import { ClientModel } from '../db/models/client.model.js';
import { SessionModel } from '../db/models/session.model.js';
import { notFound } from '../utils/errors.js';
import { uuid } from '../utils/ids.js';
import { round } from '../utils/time.js';
import type { UserRole } from '../utils/jwt.js';

/**
 * Adapts the `Session` collection (built for the extension's evidence-verification
 * engine) into the "Application" shape the frontend displays.
 *
 * An automatically-observed session's trust score is the evidence-scoring engine's own
 * `verification.recomputed_score` (0..1, scaled to 0..100). A manually-logged
 * application has no in-page evidence at all, so it always starts at a trust score of 0
 * and stays unverified until a manager/admin reviews it and sets a real score.
 */

export interface ApplicationResponse {
  id: string;
  clientId: string | null;
  clientName: string | null;
  portal: string;
  status: 'Applied' | 'Not Applied';
  businessDate: string;
  trustScore: number;
  manualEntry: boolean;
  verified: boolean;
  ownerId: string | null;
}

function statusFromOutcome(outcome: string): 'Applied' | 'Not Applied' {
  return outcome === 'confirmed' ? 'Applied' : 'Not Applied';
}

function toResponse(doc: Record<string, any>, clientNamesById: Map<string, string>): ApplicationResponse {
  const clientId = doc.client_id ? String(doc.client_id) : null;
  const trustScore = doc.manual_entry
    ? (doc.manual_verification?.trust_score ?? 0)
    : round((doc.verification?.recomputed_score ?? 0) * 100, 0);

  return {
    id: doc.session_id,
    clientId,
    clientName: clientId ? (clientNamesById.get(clientId) ?? null) : null,
    portal: doc.portal_domain || doc.adapter_name || 'Unknown',
    status: statusFromOutcome(doc.outcome),
    businessDate: (doc.timestamps?.applied_clicked ?? doc.first_seen_at ?? doc.db_created_at ?? new Date()).toISOString(),
    trustScore,
    manualEntry: !!doc.manual_entry,
    verified: !!doc.manual_verification?.verified,
    ownerId: doc.user_id ? String(doc.user_id) : null,
  };
}

async function namesForClients(clientIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) return new Map();
  const clients = await ClientModel.find({ _id: { $in: unique } }).select('name').lean();
  return new Map(clients.map((c) => [String(c._id), c.name]));
}

export async function listApplications(
  requester: { id: string; role: UserRole },
  page: number,
  limit: number,
): Promise<{ items: ApplicationResponse[]; total: number; page: number; limit: number }> {
  // admin/manager see every application; a plain user sees only their own.
  const filter = requester.role === 'user' ? { user_id: requester.id } : {};

  const [docs, total] = await Promise.all([
    SessionModel.find(filter)
      .sort({ first_seen_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    SessionModel.countDocuments(filter),
  ]);

  const clientNamesById = await namesForClients(docs.filter((d) => d.client_id).map((d) => String(d.client_id)));

  return { items: docs.map((d) => toResponse(d, clientNamesById)), total, page, limit };
}

export async function createManualApplication(
  input: ManualApplication,
  requester: { id: string },
): Promise<ApplicationResponse> {
  const client = await ClientModel.findById(input.client_id).lean();
  if (!client) throw notFound(`No client '${input.client_id}'`);

  const now = new Date();
  const businessDate = input.business_date ? new Date(input.business_date) : now;
  const outcome = input.status === 'Applied' ? 'confirmed' : 'abandoned';

  const created = await SessionModel.create({
    session_id: uuid(),
    schema_version: 'manual-1.0',
    user_id: requester.id,
    client_id: input.client_id,
    manual_entry: true,
    portal_domain: input.portal,
    state: 'ended',
    outcome,
    outcome_reasons: input.notes ? [input.notes] : [],
    timestamps: { applied_clicked: businessDate, ended: now },
    finalized: true,
    finalized_at: now,
    manual_verification: { verified: false, verified_by: null, verified_at: null, trust_score: 0 },
    first_seen_at: now,
  });

  return toResponse(created.toObject(), new Map([[String(client._id), client.name]]));
}

export async function verifyApplication(
  sessionId: string,
  trustScore: number,
  verifier: { id: string },
): Promise<ApplicationResponse> {
  const doc = await SessionModel.findOneAndUpdate(
    { session_id: sessionId },
    {
      $set: {
        'manual_verification.verified': true,
        'manual_verification.verified_by': verifier.id,
        'manual_verification.verified_at': new Date(),
        'manual_verification.trust_score': trustScore,
      },
    },
    { new: true },
  ).lean();
  if (!doc) throw notFound(`No application '${sessionId}'`);

  const clientNamesById = doc.client_id ? await namesForClients([String(doc.client_id)]) : new Map<string, string>();
  return toResponse(doc, clientNamesById);
}
