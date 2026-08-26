import type { FilterQuery } from 'mongoose';
import { EventModel } from '../db/models/event.model.js';
import { SessionModel, type SessionDoc } from '../db/models/session.model.js';
import { notFound } from '../utils/errors.js';

/**
 * Read side: the review API.
 *
 * List views project a deliberately small summary; the full evidence — fields, pages,
 * every event — is only served from the per-session endpoints, so a broad query can
 * never accidentally page thousands of complete records into a dashboard.
 */

export interface SessionListQuery {
  outcome?: string;
  state?: string;
  portal_domain?: string;
  candidate_id?: string;
  operator_id?: string;
  finalized?: boolean;
  /** Only sessions whose verification produced at least one issue at this severity. */
  min_severity?: 'info' | 'warning' | 'critical';
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface SessionSummary {
  session_id: string;
  candidate_id: string | null;
  operator_id: string | null;
  portal_domain: string;
  /** The full redirect chain, in visiting order — a job board handing off to the employer's own ATS shows up here, not just where the session started. */
  portal_domains: string[];
  adapter_name: string;
  matched_adapter: string;
  state: string;
  outcome: string;
  derived_outcome: string | null;
  submission_state: string | null;
  reported_score: number | null;
  recomputed_score: number | null;
  score_matches: boolean | null;
  issue_count: number;
  critical_issue_count: number;
  finalized: boolean;
  finalized_at: string | null;
  first_seen_at: string | null;
  stats: Record<string, unknown>;
  has_analysis: boolean;
  /** Why the extension resolved this outcome — plain-language, from `resolveOutcome` in the extension. */
  outcome_reasons: string[];
  /** Integrity notes from this service's own verification pass (`services/integrity.ts`). */
  issue_messages: string[];
  /** Sanitized text the extension captured near the submit control when nothing ever confirmed it. */
  context_excerpt: string | null;
  /** Which control was clicked and what it said — null if no submit-like click was ever observed. */
  clicked_control: { text: string | null; tag: string | null; dom_path: string | null } | null;
  /** The AI's advisory read, if one has run. Never authoritative — shown beside the deterministic outcome, not instead of it. */
  ai_risk_level: string | null;
  ai_summary: string | null;
  /** AI's independent read on whether the submission genuinely happened. Additive only. */
  ai_submission_verdict: string | null;
  /** AI's read on whether the destination the session ended on plausibly continues the job posting it started from. */
  ai_portal_verdict: string | null;
}

export async function listSessions(query: SessionListQuery): Promise<{ total: number; items: SessionSummary[] }> {
  const filter: FilterQuery<SessionDoc> = {};
  if (query.outcome) filter.outcome = query.outcome;
  if (query.state) filter.state = query.state;
  if (query.portal_domain) filter.portal_domain = query.portal_domain;
  if (query.candidate_id) filter.candidate_id = query.candidate_id;
  if (query.operator_id) filter.operator_id = query.operator_id;
  if (query.finalized !== undefined) filter.finalized = query.finalized;
  if (query.min_severity) {
    const severities =
      query.min_severity === 'critical'
        ? ['critical']
        : query.min_severity === 'warning'
          ? ['critical', 'warning']
          : ['critical', 'warning', 'info'];
    filter['verification.issues.severity'] = { $in: severities };
  }
  if (query.from || query.to) {
    filter.first_seen_at = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const [total, docs] = await Promise.all([
    SessionModel.countDocuments(filter),
    SessionModel.find(filter)
      .select(
        'session_id candidate_id operator_id portal_domain portal_domains adapter_name matched_adapter state ' +
          'outcome outcome_reasons verification submission.state submission.context_excerpt ' +
          'submission.clicked_control finalized ' +
          'finalized_at first_seen_at stats latest_analysis',
      )
      .sort({ first_seen_at: -1 })
      .skip(query.offset)
      .limit(query.limit)
      .lean(),
  ]);

  return { total, items: docs.map(toSummary) };
}

function toSummary(doc: Record<string, any>): SessionSummary {
  const issues: { severity: string; message: string }[] = doc.verification?.issues ?? [];
  return {
    session_id: doc.session_id,
    candidate_id: doc.candidate_id ?? null,
    operator_id: doc.operator_id ?? null,
    portal_domain: doc.portal_domain ?? '',
    portal_domains: doc.portal_domains && doc.portal_domains.length > 0 ? doc.portal_domains : doc.portal_domain ? [doc.portal_domain] : [],
    adapter_name: doc.adapter_name ?? '',
    matched_adapter: doc.matched_adapter ?? 'unknown',
    state: doc.state ?? 'active',
    outcome: doc.outcome ?? 'unknown',
    derived_outcome: doc.verification?.derived_outcome ?? null,
    submission_state: doc.submission?.state ?? null,
    reported_score: doc.verification?.reported_score ?? null,
    recomputed_score: doc.verification?.recomputed_score ?? null,
    score_matches: doc.verification?.score_matches ?? null,
    issue_count: issues.length,
    critical_issue_count: issues.filter((i) => i.severity === 'critical').length,
    finalized: Boolean(doc.finalized),
    finalized_at: doc.finalized_at ? new Date(doc.finalized_at).toISOString() : null,
    first_seen_at: doc.first_seen_at ? new Date(doc.first_seen_at).toISOString() : null,
    stats: doc.stats ?? {},
    has_analysis: Boolean(doc.latest_analysis),
    outcome_reasons: doc.outcome_reasons ?? [],
    issue_messages: issues.map((i) => `[${i.severity}] ${i.message}`),
    context_excerpt: doc.submission?.context_excerpt ?? null,
    clicked_control: doc.submission?.clicked_control ?? null,
    ai_risk_level: doc.latest_analysis?.risk_level ?? null,
    ai_summary: doc.latest_analysis?.summary ?? null,
    ai_submission_verdict: doc.latest_analysis?.submission_assessment?.verdict ?? null,
    ai_portal_verdict: doc.latest_analysis?.portal_legitimacy?.verdict ?? null,
  };
}

export async function getSession(sessionId: string): Promise<Record<string, unknown>> {
  const doc = await SessionModel.findOne({ session_id: sessionId }).lean();
  if (!doc) throw notFound(`No session '${sessionId}'`);
  return doc as Record<string, unknown>;
}

export interface EventQuery {
  event_type?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export async function getSessionEvents(
  sessionId: string,
  query: EventQuery,
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const exists = await SessionModel.exists({ session_id: sessionId });
  if (!exists) throw notFound(`No session '${sessionId}'`);

  const filter: FilterQuery<any> = { session_id: sessionId };
  if (query.event_type) filter.event_type = query.event_type;
  if (query.from || query.to) {
    filter.timestamp = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const [total, items] = await Promise.all([
    EventModel.countDocuments(filter),
    EventModel.find(filter).sort({ timestamp: 1 }).skip(query.offset).limit(query.limit).lean(),
  ]);

  return { total, items: items as Record<string, unknown>[] };
}

/** Aggregate counts for a dashboard header. Cheap: all covered by existing indexes. */
export async function getSessionStatistics(from?: Date, to?: Date): Promise<Record<string, unknown>> {
  const match: FilterQuery<SessionDoc> = {};
  if (from || to) {
    match.first_seen_at = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  }

  const [byOutcome, byPortal, totals] = await Promise.all([
    SessionModel.aggregate([{ $match: match }, { $group: { _id: '$outcome', count: { $sum: 1 } } }]),
    SessionModel.aggregate([
      { $match: match },
      { $group: { _id: '$portal_domain', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
    SessionModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          sessions: { $sum: 1 },
          finalized: { $sum: { $cond: ['$finalized', 1, 0] } },
          events: { $sum: '$stats.event_count' },
          score_mismatches: { $sum: { $cond: [{ $eq: ['$verification.score_matches', false] }, 1, 0] } },
          outcome_mismatches: { $sum: { $cond: [{ $eq: ['$verification.outcome_matches', false] }, 1, 0] } },
          avg_duration_ms: { $avg: '$stats.duration_ms' },
        },
      },
    ]),
  ]);

  const totalRow = totals[0] ?? {};
  return {
    totals: {
      sessions: totalRow.sessions ?? 0,
      finalized: totalRow.finalized ?? 0,
      events: totalRow.events ?? 0,
      score_mismatches: totalRow.score_mismatches ?? 0,
      outcome_mismatches: totalRow.outcome_mismatches ?? 0,
      avg_duration_ms: totalRow.avg_duration_ms ?? null,
    },
    by_outcome: Object.fromEntries(byOutcome.map((r: { _id: string; count: number }) => [r._id ?? 'unknown', r.count])),
    top_portals: byPortal.map((r: { _id: string; count: number }) => ({ portal_domain: r._id, count: r.count })),
  };
}
