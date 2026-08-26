import { describe, expect, it } from 'vitest';
import confirmedFixture from './fixtures/session-payload.confirmed.json' with { type: 'json' };
import flaggedFixture from './fixtures/session-payload.flagged.json' with { type: 'json' };
import batchFixture from './fixtures/event-batch.json' with { type: 'json' };
import { EventBatchSchema, SessionPayloadSchema } from '../src/contract/schemas.js';

/**
 * The fixtures are the extension repository's own published example payloads. If a
 * change here makes them fail to parse, this service has broken the wire contract.
 */
describe('wire contract', () => {
  it('accepts a confirmed session payload', () => {
    const result = SessionPayloadSchema.safeParse(confirmedFixture);
    expect(result.success, JSON.stringify(result.error?.issues?.slice(0, 5))).toBe(true);
  });

  it('accepts a flagged session payload', () => {
    const result = SessionPayloadSchema.safeParse(flaggedFixture);
    expect(result.success, JSON.stringify(result.error?.issues?.slice(0, 5))).toBe(true);
  });

  it('accepts an event batch', () => {
    const result = EventBatchSchema.safeParse(batchFixture);
    expect(result.success, JSON.stringify(result.error?.issues?.slice(0, 5))).toBe(true);
  });

  it('strips unknown keys instead of rejecting them', () => {
    const withExtra = { ...batchFixture, future_field: 'from a newer build' };
    const parsed = EventBatchSchema.parse(withExtra);
    expect(parsed).not.toHaveProperty('future_field');
  });

  it('rejects an event type outside the vocabulary', () => {
    const events = structuredClone(batchFixture.events);
    events[0]!.event_type = 'telepathy_detected';
    const result = EventBatchSchema.safeParse({ ...batchFixture, events });
    expect(result.success).toBe(false);
  });

  it('rejects a batch with no events', () => {
    expect(EventBatchSchema.safeParse({ ...batchFixture, events: [] }).success).toBe(false);
  });
});
