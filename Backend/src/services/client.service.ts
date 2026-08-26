import type { ClientUpsert } from '../contract/schemas.js';
import { ClientModel } from '../db/models/client.model.js';
import { notFound } from '../utils/errors.js';
import { upsertCandidate } from './candidate.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('client-service');

export interface ClientResponse {
  id: string;
  name: string;
  domain: string;
  contact_email: string;
  phone: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

function toResponse(doc: Record<string, any>): ClientResponse {
  return {
    id: String(doc._id),
    name: doc.name,
    domain: doc.domain ?? '',
    contact_email: doc.contact_email ?? '',
    phone: doc.phone ?? '',
    notes: doc.notes ?? '',
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at.toISOString(),
  };
}

/**
 * Keeps a `Candidate` record in step with the client's own email.
 *
 * The extension's automatic observation flow starts a session by candidate email
 * (`POST /v1/candidates/start`), and in this product a "client" IS the person the
 * application is being tracked for — the same email captured at onboarding, never
 * re-entered by the operator. A client with no (or an invalid) email simply can't be
 * tracked automatically yet; that never blocks creating/updating the client itself.
 */
async function syncCandidateForClient(contactEmail: string): Promise<void> {
  if (!contactEmail) return;
  try {
    await upsertCandidate({ email: contactEmail, fields: {}, hashed_fields: {} });
  } catch (err) {
    log.warn('could not sync a candidate record for this client email', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function createClient(input: ClientUpsert, createdBy: string): Promise<ClientResponse> {
  const now = new Date();
  const created = await ClientModel.create({ ...input, created_by: createdBy, created_at: now, updated_at: now });
  await syncCandidateForClient(input.contact_email);
  return toResponse(created.toObject());
}

export async function listClients(page: number, limit: number): Promise<{ items: ClientResponse[]; total: number; page: number; limit: number }> {
  const [items, total] = await Promise.all([
    ClientModel.find()
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ClientModel.countDocuments(),
  ]);
  return { items: items.map(toResponse), total, page, limit };
}

export async function getClient(id: string): Promise<ClientResponse> {
  const doc = await ClientModel.findById(id).lean();
  if (!doc) throw notFound(`No client '${id}'`);
  return toResponse(doc);
}

export async function updateClient(id: string, input: ClientUpsert): Promise<ClientResponse> {
  const doc = await ClientModel.findByIdAndUpdate(id, { $set: { ...input, updated_at: new Date() } }, { new: true }).lean();
  if (!doc) throw notFound(`No client '${id}'`);
  await syncCandidateForClient(input.contact_email);
  return toResponse(doc);
}

export async function deleteClient(id: string): Promise<void> {
  const result = await ClientModel.findByIdAndDelete(id).lean();
  if (!result) throw notFound(`No client '${id}'`);
}
