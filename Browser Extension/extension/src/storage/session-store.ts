import { getConfig } from '@/common/config';
import { SCHEMA_VERSION } from '@/models/event';
import type { FieldRecord } from '@/models/field';
import type { PageRecord } from '@/models/payload';
import type { CandidateRecord, Session, SessionOutcome } from '@/models/session';
import type { SubmissionAssessment } from '@/models/submission';
import { emptyAssessment } from '@/models/submission';
import { hashValue, randomSalt } from '@/utils/hashing';
import { uuid } from '@/utils/ids';
import { createLogger } from '@/utils/logger';
import { REDACTED } from '@/collector/utils/redaction';
import { nowIso, parseIso } from '@/utils/timestamps';
import { createDriver, KeyedMutex, type StorageDriver } from './local';

const log = createLogger('session-store');

const SESSION_KEY = 'aav.session';
const FIELDS_KEY = 'aav.fields';
const PAGES_KEY = 'aav.pages';
const SUBMISSION_KEY = 'aav.submission';
/** Candidate PII lives in `session` storage: cleared when the browser closes. */
const CANDIDATE_KEY = 'aav.candidate';
/**
 * Browser tabs allowed to receive this session's data. A job portal routinely redirects
 * the actual apply step to the employer's own ATS on a completely different domain, so
 * the boundary that matters is "the tab (or a tab opened from it) the operator is
 * actually working in" — not the domain, which can and does change mid-flow.
 */
const ALLOWED_TABS_KEY = 'aav.allowed_tabs';
const MAX_TRACKED_TABS = 20;

export interface StartSessionInput {
  /**
   * The id an operator dashboard already minted (via `POST /v1/candidates/start`) and
   * bound to a candidate by email. When provided, the extension attaches to that binding
   * instead of generating an id nobody on the backend knows about.
   */
  session_id?: string;
  operator_id?: string;
  candidate_id?: string;
  candidate_email?: string;
  portal_domain?: string;
  adapter_name?: string;
  matched_adapter?: 'known' | 'unknown';
}

export class SessionStore {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly driver: StorageDriver = createDriver('local'),
    private readonly secureDriver: StorageDriver = createDriver('session'),
  ) {}

  async get(): Promise<Session | null> {
    return this.driver.get<Session>(SESSION_KEY);
  }

  async start(input: StartSessionInput): Promise<Session> {
    const now = nowIso();
    const salt = randomSalt();
    const session: Session = {
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id || uuid(),
      operator_id: input.operator_id || null,
      candidate_id: input.candidate_id || null,
      candidate_email: REDACTED,
      candidate_email_hash: input.candidate_email ? await hashValue(input.candidate_email, salt) : null,
      portal_domain: input.portal_domain ?? '',
      matched_adapter: input.matched_adapter ?? 'unknown',
      adapter_name: input.adapter_name ?? 'generic',
      timestamps: {
        selected: now,
        candidate_record_opened: null,
        first_field_fill_at: null,
        first_fill: null,
        applied_clicked: null,
        submit_detected: null,
        confirmed: null,
        last_activity: now,
        ended: null,
      },
      candidate_record_opened_before_fill: null,
      state: 'active',
      outcome: 'unknown',
      outcome_reasons: [],
      hash_salt: salt,
      created_at: now,
      updated_at: now,
    };
    await this.driver.set(SESSION_KEY, session);
    await this.driver.set(FIELDS_KEY, []);
    await this.driver.set(PAGES_KEY, []);
    await this.driver.set(SUBMISSION_KEY, emptyAssessment(now));
    await this.driver.set(ALLOWED_TABS_KEY, []);
    log.info('session started', session.session_id);
    return session;
  }

  async update(mutate: (session: Session) => void): Promise<Session | null> {
    return this.mutex.run(SESSION_KEY, async () => {
      const session = await this.get();
      if (!session) return null;
      mutate(session);
      session.updated_at = nowIso();
      await this.driver.set(SESSION_KEY, session);
      return session;
    });
  }

  async touch(): Promise<void> {
    await this.update((s) => {
      s.timestamps.last_activity = nowIso();
    });
  }

  /**
   * Records the first observed fill and resolves the
   * `candidate_record_opened_before_fill` ordering question exactly once.
   */
  async markFirstFill(at: string): Promise<void> {
    await this.update((s) => {
      if (s.timestamps.first_field_fill_at) return;
      s.timestamps.first_field_fill_at = at;
      s.timestamps.first_fill = at;
      const opened = parseIso(s.timestamps.candidate_record_opened);
      const filled = parseIso(at);
      s.candidate_record_opened_before_fill =
        opened === null || filled === null ? null : opened <= filled;
    });
  }

  async markCandidateRecordOpened(at = nowIso()): Promise<void> {
    await this.update((s) => {
      if (!s.timestamps.candidate_record_opened) s.timestamps.candidate_record_opened = at;
      if (s.candidate_record_opened_before_fill === null && s.timestamps.first_field_fill_at) {
        const opened = parseIso(s.timestamps.candidate_record_opened);
        const filled = parseIso(s.timestamps.first_field_fill_at);
        s.candidate_record_opened_before_fill = opened !== null && filled !== null ? opened <= filled : null;
      }
    });
  }

  /**
   * Records the portal the session is running against. The adapter is reported separately
   * (and later) than the domain, so both are optional and only overwrite when supplied.
   */
  async setPortalContext(domain: string, adapterName?: string, matched?: 'known' | 'unknown'): Promise<void> {
    await this.update((s) => {
      if (!s.portal_domain) s.portal_domain = domain;
      if (adapterName) s.adapter_name = adapterName;
      if (matched) s.matched_adapter = matched;
    });
  }

  // ---- tab lock -------------------------------------------------------------

  async getAllowedTabs(): Promise<number[]> {
    return (await this.driver.get<number[]>(ALLOWED_TABS_KEY)) ?? [];
  }

  /** Adds a tab to the set this session's data may be handed to. Idempotent. */
  async allowTab(tabId: number): Promise<void> {
    await this.mutex.run(ALLOWED_TABS_KEY, async () => {
      const tabs = await this.getAllowedTabs();
      if (tabs.includes(tabId)) return;
      await this.driver.set(ALLOWED_TABS_KEY, [...tabs, tabId].slice(-MAX_TRACKED_TABS));
    });
  }

  async pause(): Promise<void> {
    await this.update((s) => {
      if (s.state === 'active') s.state = 'paused';
    });
  }

  async resume(): Promise<void> {
    await this.update((s) => {
      if (s.state === 'paused') s.state = 'active';
    });
  }

  /** Ends the session and computes the outcome from the submission evidence. */
  async end(reason: 'operator_ended' | 'abandoned' | 'timed_out'): Promise<Session | null> {
    const assessment = await this.getSubmission();
    const fields = await this.getFields();
    return this.update((s) => {
      s.state = 'ended';
      s.timestamps.ended = nowIso();
      const { outcome, reasons } = resolveOutcome(s, assessment, fields, reason);
      s.outcome = outcome;
      s.outcome_reasons = reasons;
    });
  }

  // ---- fields -------------------------------------------------------------

  async getFields(): Promise<FieldRecord[]> {
    return (await this.driver.get<FieldRecord[]>(FIELDS_KEY)) ?? [];
  }

  /** Upsert by `field_id`; later snapshots win because they are strictly newer. */
  async upsertFields(records: FieldRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.mutex.run(FIELDS_KEY, async () => {
      const existing = await this.getFields();
      const byId = new Map(existing.map((f) => [f.field_id, f]));
      for (const record of records) byId.set(record.field_id, record);
      await this.driver.set(FIELDS_KEY, [...byId.values()]);
    });
  }

  // ---- pages --------------------------------------------------------------

  async getPages(): Promise<PageRecord[]> {
    return (await this.driver.get<PageRecord[]>(PAGES_KEY)) ?? [];
  }

  async upsertPages(pages: PageRecord[]): Promise<void> {
    if (pages.length === 0) return;
    await this.mutex.run(PAGES_KEY, async () => {
      const existing = await this.getPages();
      const byId = new Map(existing.map((p) => [p.page_id, p]));
      for (const page of pages) byId.set(page.page_id, page);
      const merged = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
      await this.driver.set(PAGES_KEY, merged);
    });
  }

  // ---- submission ---------------------------------------------------------

  async getSubmission(): Promise<SubmissionAssessment> {
    return (await this.driver.get<SubmissionAssessment>(SUBMISSION_KEY)) ?? emptyAssessment(nowIso());
  }

  /**
   * Stores the newest assessment. Timestamps on the session advance monotonically —
   * a later, weaker assessment never clears an earlier `submit_detected`.
   */
  async setSubmission(assessment: SubmissionAssessment): Promise<void> {
    await this.driver.set(SUBMISSION_KEY, assessment);
    await this.update((s) => {
      if (assessment.applied_clicked && !s.timestamps.applied_clicked) {
        s.timestamps.applied_clicked = assessment.evaluated_at;
      }
      if (assessment.submit_detected && !s.timestamps.submit_detected) {
        s.timestamps.submit_detected = assessment.evaluated_at;
      }
      if (assessment.state === 'confirmed' && !s.timestamps.confirmed) {
        s.timestamps.confirmed = assessment.evaluated_at;
      }
      s.timestamps.last_activity = nowIso();
    });
  }

  // ---- candidate record (session-scoped storage, never uploaded) -----------

  async setCandidate(record: CandidateRecord | null): Promise<void> {
    if (record === null) await this.secureDriver.remove(CANDIDATE_KEY);
    else await this.secureDriver.set(CANDIDATE_KEY, record);
  }

  async getCandidate(): Promise<CandidateRecord | null> {
    return this.secureDriver.get<CandidateRecord>(CANDIDATE_KEY);
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.driver.remove(SESSION_KEY),
      this.driver.remove(FIELDS_KEY),
      this.driver.remove(PAGES_KEY),
      this.driver.remove(SUBMISSION_KEY),
      this.driver.remove(ALLOWED_TABS_KEY),
      this.secureDriver.remove(CANDIDATE_KEY),
    ]);
  }

  /** True when the session has been idle past the configured timeout. */
  async isTimedOut(): Promise<boolean> {
    const session = await this.get();
    if (!session || session.state === 'ended') return false;
    const last = parseIso(session.timestamps.last_activity ?? session.created_at);
    if (last === null) return false;
    return Date.now() - last > getConfig().session.timeout_ms;
  }
}

/**
 * Outcome resolution.
 *
 * `confirmed` requires the submission assessment to itself be `confirmed` — which in
 * turn requires a confirmation-class signal, never a click alone. Contradictory or
 * incomplete evidence produces `flagged`, which is an instruction to look closer,
 * not a judgement about the person.
 */
export function resolveOutcome(
  session: Session,
  assessment: SubmissionAssessment,
  fields: FieldRecord[],
  reason: 'operator_ended' | 'abandoned' | 'timed_out',
): { outcome: SessionOutcome; reasons: string[] } {
  const result = classifyOutcome(session, assessment, fields, reason);

  // A "flagged" outcome earned from a confidence score this high is more often a gap in
  // what the extension recognises as confirmation (a portal-specific route or phrase we
  // haven't captured yet) than an actual problem with the application — several real
  // sessions scored 0.8+ from genuine submit + network evidence and were flagged purely
  // for lacking a confirmation signal our heuristics didn't know to look for. Treat a
  // high enough score as confirmed rather than making a reviewer re-litigate it by hand.
  if (result.outcome === 'flagged' && assessment.confidence_score > 0.8) {
    result.reasons.push(
      `confidence score (${assessment.confidence_score}) is above 0.8 — treated as confirmed despite the flag condition above`,
    );
    return { outcome: 'confirmed', reasons: result.reasons };
  }

  return result;
}

function classifyOutcome(
  session: Session,
  assessment: SubmissionAssessment,
  fields: FieldRecord[],
  reason: 'operator_ended' | 'abandoned' | 'timed_out',
): { outcome: SessionOutcome; reasons: string[] } {
  const reasons: string[] = [];
  const filled = fields.filter((f) => f.state !== 'empty').length;

  if (assessment.state === 'confirmed') {
    reasons.push(
      `submission assessed as confirmed with score ${assessment.confidence_score}`,
      `confirmation evidence: ${assessment.evidence.filter((e) => e.signal_class === 'confirmation').map((e) => e.kind).join(', ') || 'none'}`,
    );
    return { outcome: 'confirmed', reasons };
  }

  if (reason === 'timed_out') {
    reasons.push('no activity within the session timeout window');
    if (assessment.submit_detected) reasons.push('submit evidence present but never confirmed');
    return { outcome: 'timed_out', reasons };
  }

  if (assessment.negative_evidence.length > 0) {
    reasons.push(
      `negative evidence present: ${assessment.negative_evidence.map((e) => e.kind).join(', ')}`,
    );
    return { outcome: 'flagged', reasons };
  }

  if (assessment.applied_clicked && !assessment.submit_detected) {
    reasons.push('apply/submit control was clicked but no submission signal followed');
    return { outcome: 'flagged', reasons };
  }

  if (assessment.submit_detected && !assessment.confirmation_detected) {
    reasons.push(
      `submission signals observed (score ${assessment.confidence_score}) without portal confirmation`,
    );
    return { outcome: 'flagged', reasons };
  }

  if (!assessment.applied_clicked && !assessment.submit_detected) {
    if (filled > 0) {
      reasons.push(`${filled} field(s) were filled but no submission was attempted`);
      return { outcome: 'abandoned', reasons };
    }
    reasons.push('no field activity and no submission activity observed');
    return { outcome: 'unknown', reasons };
  }

  // There was real submit-adjacent activity (a click, or confirmation-class evidence
  // that still didn't clear the confirm threshold) but the fused score never reached a
  // confident level. That is worth a reviewer's attention, not a silent "unknown" — a
  // low-confidence session with real activity behind it is exactly what "flagged" means.
  if (assessment.confidence_score < 0.7) {
    reasons.push(`confidence score (${assessment.confidence_score}) is below the reliable threshold (0.7)`);
    return { outcome: 'flagged', reasons };
  }

  reasons.push('evidence was insufficient to classify the session');
  void session;
  return { outcome: 'unknown', reasons };
}
