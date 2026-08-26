import { describe, expect, it } from 'vitest';
import confirmedFixture from './fixtures/session-payload.confirmed.json' with { type: 'json' };
import flaggedFixture from './fixtures/session-payload.flagged.json' with { type: 'json' };
import { SessionPayloadSchema, type SessionPayload } from '../src/contract/schemas.js';
import { verifyPayload } from '../src/services/integrity.js';

const confirmed = SessionPayloadSchema.parse(confirmedFixture);
const flagged = SessionPayloadSchema.parse(flaggedFixture);

const codes = (payload: SessionPayload) => verifyPayload(payload).issues.map((i) => i.code);

describe('payload verification', () => {
  it('agrees with a well-formed confirmed payload', () => {
    const result = verifyPayload(confirmed);
    expect(result.score_matches).toBe(true);
    expect(result.state_matches).toBe(true);
    expect(result.outcome_matches).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'critical')).toEqual([]);
  });

  it('agrees with a well-formed flagged payload', () => {
    const result = verifyPayload(flagged);
    expect(result.score_matches).toBe(true);
    expect(result.derived_outcome).toBe('flagged');
    expect(result.issues.filter((i) => i.severity === 'critical')).toEqual([]);
  });

  it('catches a confidence score that does not reproduce from the evidence', () => {
    const tampered: SessionPayload = {
      ...flagged,
      submission: { ...flagged.submission, confidence_score: 0.99 },
    };
    expect(codes(tampered)).toContain('scoring.score_mismatch');
  });

  it("catches 'confirmed' claimed without any confirmation-class evidence", () => {
    const tampered: SessionPayload = {
      ...flagged,
      submission: { ...flagged.submission, state: 'confirmed', confirmation_detected: true },
      session: { ...flagged.session, outcome: 'confirmed' },
    };

    const issues = verifyPayload(tampered).issues;
    expect(issues.map((i) => i.code)).toContain('scoring.confirmed_without_confirmation_evidence');
    expect(issues.find((i) => i.code === 'outcome.mismatch')?.severity).toBe('critical');
  });

  it('catches an evidence item carrying a weight this deployment does not use', () => {
    const evidence = structuredClone(flagged.submission.evidence);
    evidence[0]!.weight = 0.95;
    const tampered: SessionPayload = { ...flagged, submission: { ...flagged.submission, evidence } };
    expect(codes(tampered)).toContain('scoring.weight_mismatch');
  });

  it('catches an out-of-order timeline', () => {
    const tampered: SessionPayload = {
      ...confirmed,
      session: {
        ...confirmed.session,
        timestamps: { ...confirmed.session.timestamps, confirmed: '2020-01-01T00:00:00.000Z' },
      },
    };
    expect(codes(tampered)).toContain('timeline.out_of_order');
  });

  it('notes a truncated event buffer as an incomplete record', () => {
    const event = structuredClone(confirmed.events[0]);
    if (!event) throw new Error('fixture has no events');
    event.event_type = 'buffer_truncated';
    const tampered: SessionPayload = { ...confirmed, events: [event] };
    expect(codes(tampered)).toContain('coverage.buffer_truncated');
  });

  it('reports a filled field with no observed interaction as an observation, not a verdict', () => {
    const field = structuredClone(confirmed.fields[0]);
    if (!field) throw new Error('fixture has no fields');
    field.state = 'filled';
    field.interaction = { ...field.interaction, keystroke_count: 0, paste_count: 0, focus_count: 0 };

    const result = verifyPayload({ ...confirmed, fields: [field] });
    const issue = result.issues.find((i) => i.code === 'coverage.filled_without_interaction');
    expect(issue?.severity).toBe('info');
  });
});
