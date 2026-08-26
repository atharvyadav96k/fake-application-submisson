import { describe, expect, it } from 'vitest';
import confirmedFixture from './fixtures/session-payload.confirmed.json' with { type: 'json' };
import flaggedFixture from './fixtures/session-payload.flagged.json' with { type: 'json' };
import { SessionPayloadSchema, type EvidenceItem } from '../src/contract/schemas.js';
import { recomputeAssessment, resolveOutcome } from '../src/services/scoring.js';

const confirmed = SessionPayloadSchema.parse(confirmedFixture);
const flagged = SessionPayloadSchema.parse(flaggedFixture);

const evidence = (kind: string, signalClass: string, weight: number): EvidenceItem => ({
  kind: kind as EvidenceItem['kind'],
  signal_class: signalClass as EvidenceItem['signal_class'],
  timestamp: '2026-08-15T09:00:00.000Z',
  weight,
  detail: 'test',
  counted: true,
});

describe('server-side re-scoring', () => {
  it('reproduces the confirmed session within the verification tolerance', () => {
    const result = recomputeAssessment(confirmed.submission.evidence, confirmed.submission.negative_evidence);

    // adapter_confirmation carries weight 1.0, which saturates the noisy-OR: with that
    // signal counted, the fused score is exactly 1. The fixture reports 0.9976 — the
    // value the same rule produces from a confirmation_text/success_toast pair rather
    // than an adapter confirmation — so the published example is internally stale.
    // The 0.0024 gap sits inside SCORE_TOLERANCE, so verification still passes it.
    expect(result.score).toBe(1);
    expect(Math.abs(result.score - confirmed.submission.confidence_score)).toBeLessThanOrEqual(0.005);
    expect(result.state).toBe('confirmed');
  });

  it('reproduces the score for a flagged session', () => {
    const result = recomputeAssessment(flagged.submission.evidence, flagged.submission.negative_evidence);
    expect(result.score).toBeCloseTo(flagged.submission.confidence_score, 4);
    expect(result.state).toBe('click_without_submission');
  });

  it('counts only the strongest signal per class, so repeats cannot inflate a score', () => {
    const once = recomputeAssessment([evidence('submit_button_clicked', 'dom_intent', 0.2)], []);
    const thrice = recomputeAssessment(
      [
        evidence('submit_button_clicked', 'dom_intent', 0.2),
        evidence('submit_button_clicked', 'dom_intent', 0.2),
        evidence('submit_button_clicked', 'dom_intent', 0.2),
      ],
      [],
    );
    expect(thrice.score).toBe(once.score);
    expect(thrice.score).toBeCloseTo(0.2, 4);
  });

  it('fuses independent classes with noisy-OR', () => {
    // 1 - (1-0.2)(1-0.4) = 0.52
    const result = recomputeAssessment(
      [evidence('submit_button_clicked', 'dom_intent', 0.2), evidence('form_submit_event', 'dom_submit', 0.4)],
      [],
    );
    expect(result.score).toBeCloseTo(0.52, 4);
  });

  it('ignores the weight the client claims and uses the configured weight', () => {
    // A client inflating its own weight must not be able to raise its score.
    const inflated = recomputeAssessment([evidence('submit_button_clicked', 'dom_intent', 1.0)], []);
    expect(inflated.score).toBeCloseTo(0.2, 4);
    expect(inflated.reweighted).toEqual([{ kind: 'submit_button_clicked', reported: 1, expected: 0.2 }]);
  });

  it('never reaches confirmed from a click alone', () => {
    const result = recomputeAssessment([evidence('submit_button_clicked', 'dom_intent', 0.2)], []);
    expect(result.state).toBe('clicked_only');
    expect(result.confirmation_detected).toBe(false);
  });

  it('never reaches confirmed from a successful POST alone', () => {
    const result = recomputeAssessment(
      [
        evidence('submit_button_clicked', 'dom_intent', 0.2),
        evidence('submission_request_success', 'network', 0.8),
      ],
      [],
    );
    expect(result.state).not.toBe('confirmed');
    expect(result.submit_detected).toBe(true);
  });

  it('subtracts each distinct negative kind exactly once', () => {
    const result = recomputeAssessment(
      [evidence('submission_request_success', 'network', 0.8)],
      [
        evidence('validation_error_after_submit', 'negative', -0.35),
        evidence('validation_error_after_submit', 'negative', -0.35),
      ],
    );
    expect(result.score).toBeCloseTo(0.45, 4);
  });

  it('clamps a heavily contradicted score at zero rather than going negative', () => {
    const result = recomputeAssessment(
      [evidence('submit_button_clicked', 'dom_intent', 0.2)],
      [
        evidence('validation_error_after_submit', 'negative', -0.35),
        evidence('submission_request_failed', 'negative', -0.4),
      ],
    );
    expect(result.score).toBe(0);
  });
});

describe('outcome resolution', () => {
  const base = { anyFieldFilled: true, sessionState: 'ended', endedAt: null, lastActivityAt: null };

  it('resolves confirmed only with confirmation evidence above threshold', () => {
    const assessment = recomputeAssessment(
      [evidence('adapter_confirmation', 'confirmation', 1.0)],
      [],
    );
    expect(resolveOutcome({ ...base, assessment }).outcome).toBe('confirmed');
  });

  it('flags submit evidence that never produced a confirmation', () => {
    const assessment = recomputeAssessment([evidence('submission_request_success', 'network', 0.8)], []);
    expect(resolveOutcome({ ...base, assessment }).outcome).toBe('flagged');
  });

  it('flags a click contradicted by a validation error', () => {
    const assessment = recomputeAssessment(
      [evidence('submit_button_clicked', 'dom_intent', 0.2)],
      [evidence('validation_error_after_submit', 'negative', -0.35)],
    );
    expect(resolveOutcome({ ...base, assessment }).outcome).toBe('flagged');
  });

  it('marks a filled-but-unsubmitted closed session abandoned', () => {
    const assessment = recomputeAssessment([], []);
    expect(resolveOutcome({ ...base, assessment }).outcome).toBe('abandoned');
  });

  it('marks a long-idle session timed_out', () => {
    const assessment = recomputeAssessment([], []);
    const outcome = resolveOutcome({
      ...base,
      assessment,
      lastActivityAt: '2026-08-15T09:00:00.000Z',
      endedAt: '2026-08-15T10:30:00.000Z',
    });
    expect(outcome.outcome).toBe('timed_out');
  });

  it('returns unknown rather than guessing when nothing was observed', () => {
    const assessment = recomputeAssessment([], []);
    expect(resolveOutcome({ ...base, assessment, anyFieldFilled: false }).outcome).toBe('unknown');
  });
});
