import { ZodError } from 'zod';
import { EventBatchSchema, SessionPayloadSchema } from '../contract/schemas.js';
import { IngestLogModel } from '../db/models/ingest-log.model.js';
import { uuid } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { finalizeSession, ingestEventBatch } from './ingest.service.js';

const log = createLogger('ingest-log');

export type IngestRoute = 'events' | 'finalize';

/** Best-effort session id extraction from a body that may not have validated yet. */
export function extractSessionId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.session_id === 'string') return b.session_id;
  const session = b.session as Record<string, unknown> | undefined;
  if (session && typeof session.session_id === 'string') return session.session_id;
  return null;
}

function zodDetails(err: unknown): unknown {
  if (err instanceof ZodError) return err.issues.slice(0, 25).map((i) => ({ path: i.path.join('.'), message: i.message }));
  return err instanceof Error ? err.message : String(err);
}

/**
 * Persists a request before or regardless of validation outcome, so a payload the wire
 * contract rejects is never silently gone — the raw body and the reason are both kept.
 * This is best-effort: a write failure here is logged, never thrown, so logging can
 * never itself take down the request it's trying to protect.
 */
export async function recordIngest(entry: {
  route: IngestRoute;
  sessionId: string | null;
  requestId: string | undefined;
  rawBody: unknown;
  status: 'accepted' | 'rejected';
  error?: unknown;
}): Promise<void> {
  try {
    await IngestLogModel.create({
      log_id: uuid(),
      route: entry.route,
      session_id: entry.sessionId,
      request_id: entry.requestId ?? null,
      raw_body: entry.rawBody,
      status: entry.status,
      error: entry.status === 'rejected' ? zodDetails(entry.error) : null,
    });
  } catch (err) {
    log.error('failed to persist ingest log entry', {
      route: entry.route,
      session_id: entry.sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface IngestLogListQuery {
  status?: 'accepted' | 'rejected';
  route?: IngestRoute;
  session_id?: string;
  limit: number;
  offset: number;
}

export async function listIngestLog(query: IngestLogListQuery): Promise<{ total: number; items: unknown[] }> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.route) filter.route = query.route;
  if (query.session_id) filter.session_id = query.session_id;

  const [total, items] = await Promise.all([
    IngestLogModel.countDocuments(filter),
    IngestLogModel.find(filter).sort({ received_at: -1 }).skip(query.offset).limit(query.limit).lean(),
  ]);
  return { total, items };
}

/**
 * Re-attempts validation and processing of a stored raw payload. Used once whatever
 * caused the original rejection (a schema mismatch, an unsupported field) has been
 * fixed, so the evidence a candidate actually produced is not permanently lost to a bug
 * on either side of the wire contract.
 */
export async function replayIngestLogEntry(logId: string): Promise<{ status: 'success' | 'failed'; error?: unknown }> {
  const entry = await IngestLogModel.findOne({ log_id: logId });
  if (!entry) throw new Error(`No ingest log entry '${logId}'.`);

  try {
    if (entry.route === 'events') {
      const batch = EventBatchSchema.parse(entry.raw_body);
      await ingestEventBatch(batch);
    } else {
      const payload = SessionPayloadSchema.parse(entry.raw_body);
      await finalizeSession(payload);
    }
    entry.status = 'accepted';
    entry.error = null;
    entry.replayed_at = new Date();
    entry.replay_status = 'success';
    entry.replay_error = null;
    await entry.save();
    return { status: 'success' };
  } catch (err) {
    const details = zodDetails(err);
    entry.replayed_at = new Date();
    entry.replay_status = 'failed';
    entry.replay_error = details;
    await entry.save();
    return { status: 'failed', error: details };
  }
}
