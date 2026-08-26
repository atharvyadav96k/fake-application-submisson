import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig, setConfig } from '@/common/config';
import { EventBuffer } from '@/collector/content/event-buffer';
import type { ActivityEvent } from '@/models/event';
import { SCHEMA_VERSION } from '@/models/event';
import type { FieldRecord } from '@/models/field';
import { emptyInteraction } from '@/models/field';
import { emptyAssessment } from '@/models/submission';
import { EventStore } from '@/storage/event-store';
import { MemoryDriver } from '@/storage/local';
import { resolveOutcome, SessionStore } from '@/storage/session-store';
import { uuid } from '@/utils/ids';
import { nowIso } from '@/utils/timestamps';

function event(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: uuid(),
    session_id: 'sess-1',
    timestamp: nowIso(),
    monotonic_ms: 0,
    event_type: 'field_input',
    page: { domain: 'jobs.example-portal.com', path: '/apply', sanitized_url: '', title: '', frame: 'top' },
    metadata: {},
    ...over,
  };
}

function field(over: Partial<FieldRecord> = {}): FieldRecord {
  return {
    field_id: 'f_1',
    canonical_field: 'current_company',
    instance_index: 0,
    group_key: null,
    descriptor: {
      kind: 'input',
      tag: 'input',
      input_type: 'text',
      name_hint: 'company',
      id_hint: null,
      label_hint: 'current company',
      placeholder_hint: null,
      aria_label_hint: null,
      autocomplete: null,
      dom_path: 'form>input',
      signals: ['label'],
      confidence: 0.9,
    },
    sensitivity: 'storable',
    required: false,
    state: 'filled',
    input_method: 'typed',
    interaction: { ...emptyInteraction(), fill_sequence_number: 1, first_fill_at: nowIso() },
    value: 'Example Ltd',
    value_hash: null,
    value_redacted: false,
    value_length: 11,
    match_result: 'match',
    match_note: null,
    first_seen_at: nowIso(),
    last_seen_at: nowIso(),
    visible: true,
    detached_at: null,
    ...over,
  };
}

describe('event store', () => {
  let driver: MemoryDriver;
  let store: EventStore;

  beforeEach(() => {
    driver = new MemoryDriver();
    store = new EventStore(driver);
  });

  it('appends and reads back in order', async () => {
    await store.append([event(), event()]);
    expect(await store.size()).toBe(2);
  });

  it('is idempotent on event_id', async () => {
    const e = event();
    await store.append([e]);
    await store.append([e]);
    expect(await store.size()).toBe(1);
  });

  it('dedupes on dedupe_key inside the window', async () => {
    await store.append([event({ dedupe_key: 'input:f_1' })]);
    await store.append([event({ dedupe_key: 'input:f_1' })]);
    expect(await store.size()).toBe(1);
  });

  it('keeps events with the same dedupe_key from different sessions', async () => {
    await store.append([event({ dedupe_key: 'k', session_id: 'a' })]);
    await store.append([event({ dedupe_key: 'k', session_id: 'b' })]);
    expect(await store.size()).toBe(2);
  });

  it('removes events only after they are acknowledged', async () => {
    const batch = [event(), event(), event()];
    await store.append(batch);
    const peeked = await store.peek(2);
    expect(peeked).toHaveLength(2);
    expect(await store.size()).toBe(3);

    await store.ack(peeked.map((e) => e.event_id));
    expect(await store.size()).toBe(1);
  });

  it('retains acknowledged events for the final payload', async () => {
    const batch = [event(), event()];
    await store.append(batch);
    await store.ack(batch.map((e) => e.event_id));
    const all = await store.allForSession('sess-1');
    expect(all).toHaveLength(2);
  });

  it('caps the queue and records the truncation instead of losing it silently', async () => {
    setConfig({ buffering: { ...getConfig().buffering, max_stored_events: 10 } });
    await store.append(Array.from({ length: 25 }, () => event()));
    const all = await store.allForSession('sess-1');
    const truncation = all.find((e) => e.event_type === 'buffer_truncated');
    expect(truncation).toBeDefined();
    expect((truncation!.metadata as { dropped: number }).dropped).toBeGreaterThan(0);
    expect(await store.size()).toBeLessThanOrEqual(11);
  });

  it('survives a driver restart', async () => {
    await store.append([event(), event()]);
    const revived = new EventStore(driver);
    expect(await revived.size()).toBe(2);
  });

  it('scrubs secrets out of events before persisting them', async () => {
    await store.append([event({ metadata: { access_token: 'abcdef' } })]);
    const stored = await store.peek(1);
    expect((stored[0]!.metadata as Record<string, unknown>).access_token).toBe('[REDACTED]');
  });

  it('purges a finished session', async () => {
    await store.append([event({ session_id: 'a' }), event({ session_id: 'b' })]);
    await store.purgeSession('a');
    expect(await store.allForSession('a')).toHaveLength(0);
    expect(await store.allForSession('b')).toHaveLength(1);
  });
});

describe('session store', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(new MemoryDriver(), new MemoryDriver());
  });

  it('creates a session with a hashed email and no plaintext', async () => {
    const session = await store.start({
      operator_id: 'op1',
      candidate_id: 'c1',
      candidate_email: 'jane.doe@example.com',
    });
    expect(session.candidate_email).toBe('[REDACTED]');
    expect(session.candidate_email_hash).toMatch(/^(sha256|fnv):/);
    expect(JSON.stringify(session)).not.toContain('jane.doe@example.com');
  });

  it('records whether the candidate record was opened before the first fill', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await store.markCandidateRecordOpened('2026-08-15T10:00:00.000Z');
    await store.markFirstFill('2026-08-15T10:05:00.000Z');
    const session = await store.get();
    expect(session!.candidate_record_opened_before_fill).toBe(true);
  });

  it('reports the reverse ordering as false, not as an error', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await store.markFirstFill('2026-08-15T10:00:00.000Z');
    await store.markCandidateRecordOpened('2026-08-15T10:05:00.000Z');
    const session = await store.get();
    expect(session!.candidate_record_opened_before_fill).toBe(false);
  });

  it('leaves the ordering unknown when the record was never opened', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await store.markFirstFill(nowIso());
    expect((await store.get())!.candidate_record_opened_before_fill).toBeNull();
  });

  it('keeps the first fill timestamp stable', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await store.markFirstFill('2026-08-15T10:00:00.000Z');
    await store.markFirstFill('2026-08-15T11:00:00.000Z');
    expect((await store.get())!.timestamps.first_field_fill_at).toBe('2026-08-15T10:00:00.000Z');
  });

  it('upserts fields by id', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await store.upsertFields([field({ state: 'partial' })]);
    await store.upsertFields([field({ state: 'filled' })]);
    const fields = await store.getFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]!.state).toBe('filled');
  });

  it('advances submission timestamps monotonically', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    const first = { ...emptyAssessment('2026-08-15T10:00:00.000Z'), applied_clicked: true };
    const second = { ...emptyAssessment('2026-08-15T10:01:00.000Z'), applied_clicked: true };
    await store.setSubmission(first);
    await store.setSubmission(second);
    expect((await store.get())!.timestamps.applied_clicked).toBe('2026-08-15T10:00:00.000Z');
  });

  it('keeps the candidate record out of durable storage', async () => {
    const durable = new MemoryDriver();
    const ephemeral = new MemoryDriver();
    const s = new SessionStore(durable, ephemeral);
    await s.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await s.setCandidate({ candidate_id: 'c1', fields: { email: 'jane@example.com' }, fetched_at: nowIso() });
    expect((await durable.keys()).some((k) => k.includes('candidate'))).toBe(false);
    expect(await s.getCandidate()).not.toBeNull();
  });

  it('wipes everything on clear() — the "not doing this job now" discard path relies on this', async () => {
    await store.start({ operator_id: 'op1', candidate_id: 'c1', candidate_email: '' });
    await store.upsertFields([field({ state: 'filled' })]);
    await store.setSubmission({ ...emptyAssessment(nowIso()), applied_clicked: true });
    await store.setCandidate({ candidate_id: 'c1', fields: {}, fetched_at: nowIso() });
    await store.allowTab(7);

    await store.clear();

    expect(await store.get()).toBeNull();
    expect(await store.getFields()).toEqual([]);
    expect(await store.getPages()).toEqual([]);
    expect(await store.getCandidate()).toBeNull();
    expect(await store.getAllowedTabs()).toEqual([]);
  });
});

describe('outcome resolution', () => {
  const session = {
    timestamps: {},
  } as never;

  it('returns confirmed only when the submission itself is confirmed', () => {
    const assessment = { ...emptyAssessment(nowIso()), state: 'confirmed' as const, confidence_score: 0.95 };
    const { outcome } = resolveOutcome(session, assessment, [], 'operator_ended');
    expect(outcome).toBe('confirmed');
  });

  it('flags a click that never became a submission', () => {
    const assessment = { ...emptyAssessment(nowIso()), applied_clicked: true, state: 'clicked_only' as const };
    const { outcome, reasons } = resolveOutcome(session, assessment, [], 'operator_ended');
    expect(outcome).toBe('flagged');
    expect(reasons.join(' ')).toMatch(/no submission signal/);
  });

  it('flags a submission that was never confirmed', () => {
    const assessment = {
      ...emptyAssessment(nowIso()),
      applied_clicked: true,
      submit_detected: true,
      state: 'submitted' as const,
      confidence_score: 0.8,
    };
    expect(resolveOutcome(session, assessment, [], 'operator_ended').outcome).toBe('flagged');
  });

  it('treats a submission above 0.8 as confirmed even without a recognised confirmation signal', () => {
    // Real case: a genuine direct-apply session scored 0.84 from real click + network
    // evidence, but the portal's confirmation page/title wasn't recognised yet, so it sat
    // unconfirmed and got flagged despite the application having gone through. A score
    // this high is more often a gap in what we recognise as confirmation than a real
    // problem, so it's reported confirmed instead of asking a reviewer to re-litigate it.
    const assessment = {
      ...emptyAssessment(nowIso()),
      applied_clicked: true,
      submit_detected: true,
      state: 'submitted' as const,
      confidence_score: 0.84,
    };
    const { outcome, reasons } = resolveOutcome(session, assessment, [], 'operator_ended');
    expect(outcome).toBe('confirmed');
    expect(reasons.join(' ')).toMatch(/above 0\.8/);
  });

  it('still flags a submission at exactly 0.8 without confirmation', () => {
    const assessment = {
      ...emptyAssessment(nowIso()),
      applied_clicked: true,
      submit_detected: true,
      state: 'submitted' as const,
      confidence_score: 0.8,
    };
    expect(resolveOutcome(session, assessment, [], 'operator_ended').outcome).toBe('flagged');
  });

  it('flags any session carrying negative evidence', () => {
    const assessment = {
      ...emptyAssessment(nowIso()),
      submit_detected: true,
      negative_evidence: [
        { kind: 'submission_request_failed' as const, signal_class: 'negative' as const, timestamp: nowIso(), weight: -0.4, detail: '', counted: true },
      ],
    };
    expect(resolveOutcome(session, assessment, [], 'operator_ended').outcome).toBe('flagged');
  });

  it('marks a filled-but-unsubmitted session as abandoned', () => {
    const { outcome } = resolveOutcome(session, emptyAssessment(nowIso()), [field()], 'abandoned');
    expect(outcome).toBe('abandoned');
  });

  it('marks an idle session as timed_out', () => {
    const { outcome } = resolveOutcome(session, emptyAssessment(nowIso()), [], 'timed_out');
    expect(outcome).toBe('timed_out');
  });

  it('returns unknown when there is nothing to go on', () => {
    const { outcome } = resolveOutcome(session, emptyAssessment(nowIso()), [], 'operator_ended');
    expect(outcome).toBe('unknown');
  });

  it('flags — rather than silently reporting unknown — a low-confidence session with real submit activity', () => {
    // Confirmation-class evidence was seen, but the fused score never cleared the
    // confirm threshold, so `state` isn't 'confirmed'. Without the 0.7 floor this used
    // to fall through every branch to the generic "insufficient evidence" -> unknown.
    const assessment = {
      ...emptyAssessment(nowIso()),
      applied_clicked: true,
      submit_detected: true,
      confirmation_detected: true,
      state: 'submitted' as const,
      confidence_score: 0.6,
    };
    const { outcome, reasons } = resolveOutcome(session, assessment, [], 'operator_ended');
    expect(outcome).toBe('flagged');
    expect(reasons.join(' ')).toMatch(/below the reliable threshold/);
  });
});

describe('event buffer', () => {
  it('batches events and flushes on the size threshold', async () => {
    setConfig({ buffering: { ...getConfig().buffering, flush_max_events: 3, flush_interval_ms: 10_000 } });
    const batches: ActivityEvent[][] = [];
    const buffer = new EventBuffer(
      () => 'sess-1',
      () => ({ domain: 'd', path: '/', sanitized_url: '', title: '', frame: 'top' }),
      (b) => {
        batches.push(b);
      },
    );
    buffer.emit('field_focus');
    buffer.emit('field_blur');
    expect(batches).toHaveLength(0);
    buffer.emit('field_input');
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('drops nothing when the sink fails', async () => {
    let fail = true;
    const delivered: ActivityEvent[] = [];
    const buffer = new EventBuffer(
      () => 'sess-1',
      () => ({ domain: 'd', path: '/', sanitized_url: '', title: '', frame: 'top' }),
      (b) => {
        if (fail) throw new Error('offline');
        delivered.push(...b);
      },
    );
    buffer.emit('field_focus');
    await buffer.flush();
    expect(delivered).toHaveLength(0);
    expect(buffer.pendingCount()).toBe(1);

    fail = false;
    await buffer.flush();
    expect(delivered).toHaveLength(1);
  });

  it('suppresses duplicates within the dedupe window', () => {
    const batches: ActivityEvent[][] = [];
    const buffer = new EventBuffer(
      () => 'sess-1',
      () => ({ domain: 'd', path: '/', sanitized_url: '', title: '', frame: 'top' }),
      (b) => {
        batches.push(b);
      },
    );
    expect(buffer.emit('field_input', { dedupe_key: 'k' })).not.toBeNull();
    expect(buffer.emit('field_input', { dedupe_key: 'k' })).toBeNull();
  });

  it('emits nothing without a session', () => {
    const buffer = new EventBuffer(
      () => null,
      () => ({ domain: 'd', path: '/', sanitized_url: '', title: '', frame: 'top' }),
      () => undefined,
    );
    expect(buffer.emit('field_focus')).toBeNull();
  });
});
