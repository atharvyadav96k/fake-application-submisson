import type { AnyBulkWriteOperation } from 'mongoose';
import type { ActivityEvent, EventBatch, SessionPayload } from '../contract/schemas.js';
import { EventModel, type EventDoc } from '../db/models/event.model.js';
import { SessionModel } from '../db/models/session.model.js';
import { fingerprint } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { parseIso } from '../utils/time.js';
import { verifyPayload } from './integrity.js';
import { sanitizeSessionPayload } from './sanitize.js';
import { computeStats } from './stats.js';

const log = createLogger('ingest');

export interface IngestBatchResult {
  /** Event ids the client may drop from its queue. */
  accepted: string[];
  inserted: number;
  duplicates: number;
  rejected: { event_id: string; reason: string }[];
}

/**
 * Appends a batch of events.
 *
 * Idempotency is the contract: re-sending the same `event_id` must be a no-op, because
 * the extension retries a batch until it is acked and a lost ack is indistinguishable
 * from a lost batch. Duplicates are therefore *accepted*, not rejected — telling the
 * client to keep retrying an event we already hold would loop forever.
 */
export async function ingestEventBatch(batch: EventBatch): Promise<IngestBatchResult> {
  const receivedAt = new Date();
  const rejected: IngestBatchResult['rejected'] = [];
  const usable: ActivityEvent[] = [];

  for (const event of batch.events) {
    if (event.session_id !== batch.session_id) {
      rejected.push({ event_id: event.event_id, reason: 'session_id does not match the batch' });
      continue;
    }
    usable.push(event);
  }

  if (usable.length === 0) {
    return { accepted: [], inserted: 0, duplicates: 0, rejected };
  }

  const operations: AnyBulkWriteOperation<EventDoc>[] = usable.map((event) => ({
    updateOne: {
      filter: { event_id: event.event_id },
      // setOnInsert only: an event already stored is never rewritten by a retry, so the
      // first version of the record — the one closest to the observation — is the one kept.
      update: {
        $setOnInsert: {
          event_id: event.event_id,
          session_id: event.session_id,
          schema_version: event.schema_version,
          timestamp: parseIso(event.timestamp) ?? receivedAt,
          monotonic_ms: event.monotonic_ms,
          event_type: event.event_type,
          page: event.page,
          field: event.field ?? null,
          metadata: event.metadata ?? {},
          dedupe_key: event.dedupe_key ?? null,
          batch_id: batch.batch_id,
          attempt: batch.attempt,
          received_at: receivedAt,
        },
      },
      upsert: true,
    },
  }));

  const result = await EventModel.bulkWrite(operations, { ordered: false });
  const inserted = result.upsertedCount ?? 0;
  const duplicates = usable.length - inserted;

  await touchSession(batch, usable, inserted, duplicates, receivedAt);

  log.debug('batch ingested', {
    session_id: batch.session_id,
    batch_id: batch.batch_id,
    inserted,
    duplicates,
    rejected: rejected.length,
  });

  return { accepted: usable.map((e) => e.event_id), inserted, duplicates, rejected };
}

/**
 * Creates or updates the lightweight session shell that streamed events belong to.
 *
 * Events can arrive before a session is finalized (and, after a browser restart, before
 * this service has ever heard of it), so the shell is upserted from whatever the batch
 * carries. Anything set here is provisional and is overwritten by `finalize`.
 */
async function touchSession(
  batch: EventBatch,
  events: ActivityEvent[],
  inserted: number,
  duplicates: number,
  receivedAt: Date,
): Promise<void> {
  const latest = events.reduce<Date | null>((max, event) => {
    const ts = parseIso(event.timestamp);
    if (!ts) return max;
    return !max || ts > max ? ts : max;
  }, null);

  const first = events[0];
  const domain = first?.page.domain ?? '';

  await SessionModel.updateOne(
    { session_id: batch.session_id },
    {
      $setOnInsert: {
        session_id: batch.session_id,
        schema_version: batch.schema_version,
        first_seen_at: receivedAt,
        state: 'active',
        outcome: 'unknown',
      },
      $set: {
        last_event_at: latest ?? receivedAt,
        ...(domain ? { portal_domain: domain } : {}),
        environment: batch.environment,
      },
      $inc: {
        'stats.event_count': inserted,
        'stats.duplicate_event_count': duplicates,
        'stats.batch_count': 1,
      },
    },
    { upsert: true },
  );
}

/**
 * The full redirect chain, in the order domains were first visited — not just where the
 * session started. A job board routinely hands the real apply step off to the employer's
 * own ATS on a different domain, and that hand-off is exactly what a reviewer needs to
 * see to trust the record. Only top-level pages count: iframes on the same tab (ad/
 * tracking pixels, embedded widgets) never change what's in the address bar, so treating
 * their domains as "redirects" pollutes the chain with sites the candidate never actually
 * visited — an observed real session showed exactly this, ad-network domains
 * (doubleclick.net, LinkedIn's ad platform, etc.) mixed in with the real naukri.com ->
 * employer-ATS handoff.
 */
export function computePortalDomains(pages: SessionPayload['pages']): string[] {
  const portalDomains: string[] = [];
  for (const page of [...pages].sort((a, b) => a.sequence - b.sequence)) {
    if (page.frame !== 'top') continue;
    if (page.domain && !portalDomains.includes(page.domain)) portalDomains.push(page.domain);
  }
  return portalDomains;
}

export interface FinalizeResult {
  received: boolean;
  session_id: string;
  /** True when this exact payload had already been finalized — a retry, not a change. */
  duplicate: boolean;
  outcome: string;
  derived_outcome: string;
  verification_issue_count: number;
  critical_issue_count: number;
  stripped: string[];
  events_stored: number;
}

/**
 * Stores the full session record.
 *
 * The reported payload is kept verbatim (minus anything the privacy policy forbids) and
 * this service's independent verification is stored alongside it rather than replacing
 * it. A reviewer needs both: what the browser said, and whether it holds up.
 */
export async function finalizeSession(raw: SessionPayload): Promise<FinalizeResult> {
  const { payload, stripped } = sanitizeSessionPayload(raw);
  const sessionId = payload.session.session_id;
  const now = new Date();

  const printOfPayload = fingerprint(payload);
  const existing = await SessionModel.findOne({ session_id: sessionId }).select('finalize_fingerprint').lean();
  const isDuplicate = existing?.finalize_fingerprint === printOfPayload;

  const verification = verifyPayload(payload);
  const stats = computeStats(payload);
  const t = payload.session.timestamps;

  const portalDomains = computePortalDomains(payload.pages);

  await SessionModel.updateOne(
    { session_id: sessionId },
    {
      $setOnInsert: { session_id: sessionId, first_seen_at: now },
      $set: {
        schema_version: payload.schema_version,
        operator_id: payload.session.operator_id,
        candidate_id: payload.session.candidate_id,
        candidate_email_hash: payload.session.candidate_email_hash,
        portal_domain: payload.session.portal_domain,
        portal_domains: portalDomains.length > 0 ? portalDomains : payload.session.portal_domain ? [payload.session.portal_domain] : [],
        matched_adapter: payload.session.matched_adapter,
        adapter_name: payload.session.adapter_name,
        state: payload.session.state,
        outcome: payload.session.outcome,
        outcome_reasons: payload.session.outcome_reasons,
        candidate_record_opened_before_fill: payload.session.candidate_record_opened_before_fill,
        timestamps: {
          selected: parseIso(t.selected),
          candidate_record_opened: parseIso(t.candidate_record_opened),
          first_field_fill_at: parseIso(t.first_field_fill_at),
          first_fill: parseIso(t.first_fill),
          applied_clicked: parseIso(t.applied_clicked),
          submit_detected: parseIso(t.submit_detected),
          confirmed: parseIso(t.confirmed),
          last_activity: parseIso(t.last_activity),
          ended: parseIso(t.ended),
        },
        submission: payload.submission,
        pages: payload.pages,
        fields: payload.fields,
        fill_order: payload.fill_order,
        environment: payload.environment,
        verification: {
          recomputed_score: verification.recomputed.score,
          reported_score: verification.reported_score,
          score_matches: verification.score_matches,
          score_delta: verification.score_delta,
          recomputed_state: verification.recomputed.state,
          state_matches: verification.state_matches,
          derived_outcome: verification.derived_outcome,
          outcome_matches: verification.outcome_matches,
          issues: verification.issues,
          verified_at: now,
        },
        'stats.field_count': stats.field_count,
        'stats.filled_field_count': stats.filled_field_count,
        'stats.page_count': stats.page_count,
        'stats.duration_ms': stats.duration_ms,
        'stats.time_to_first_fill_ms': stats.time_to_first_fill_ms,
        'stats.total_keystrokes': stats.total_keystrokes,
        'stats.total_pastes': stats.total_pastes,
        'stats.autofilled_field_count': stats.autofilled_field_count,
        finalized: !payload.partial,
        finalized_at: payload.partial ? null : now,
        finalize_fingerprint: printOfPayload,
        created_at: parseIso(payload.session.created_at),
        updated_at: parseIso(payload.session.updated_at),
      },
      $inc: { finalize_count: 1 },
    },
    { upsert: true },
  );

  // The finalize payload replays the session's events; storing them through the same
  // idempotent path means a session that finalized without ever streaming (offline for
  // its whole life) still ends up with a complete timeline.
  let eventsStored = 0;
  if (payload.events.length > 0) {
    const result = await ingestEventBatch({
      schema_version: payload.schema_version,
      session_id: sessionId,
      batch_id: `finalize:${printOfPayload.slice(0, 16)}`,
      events: payload.events,
      environment: payload.environment,
      sent_at: payload.generated_at,
      attempt: 1,
    });
    eventsStored = result.inserted;
  }

  const criticals = verification.issues.filter((i) => i.severity === 'critical');
  if (criticals.length > 0) {
    log.warn('finalized with critical integrity issues', {
      session_id: sessionId,
      codes: criticals.map((i) => i.code),
    });
  }
  if (stripped.length > 0) {
    log.warn('values stripped at ingest', { session_id: sessionId, stripped });
  }

  return {
    received: true,
    session_id: sessionId,
    duplicate: isDuplicate,
    outcome: payload.session.outcome,
    derived_outcome: verification.derived_outcome,
    verification_issue_count: verification.issues.length,
    critical_issue_count: criticals.length,
    stripped,
    events_stored: eventsStored,
  };
}
