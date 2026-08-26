import { beforeEach, describe, expect, it } from 'vitest';
import { genericAdapter } from '@/collector/adapters/generic-adapter';
import type { PortalAdapter } from '@/collector/adapters/types';
import { examplePortalAdapter } from '@/collector/adapters/portals/example-portal';
import { DEFAULT_SCORING, getConfig, setConfig } from '@/common/config';
import { EventBuffer } from '@/collector/content/event-buffer';
import { NetworkBridge } from '@/collector/content/network-bridge';
import { collectValidationErrors, scoreSignals, SubmissionDetector } from '@/collector/content/submission-detector';
import type { ActivityEvent } from '@/models/event';
import type { PageRecord } from '@/models/payload';
import type { SubmissionSignal } from '@/models/submission';
import { PAGE_HOOK_CHANNEL } from '@/common/messages';
import { monotonicMs, nowIso } from '@/utils/timestamps';

function signal(kind: SubmissionSignal['kind'], signal_class: SubmissionSignal['signal_class']): SubmissionSignal {
  return { kind, signal_class, timestamp: nowIso(), monotonic_ms: monotonicMs(), detail: kind };
}

function harness(adapter: PortalAdapter = genericAdapter) {
  const events: ActivityEvent[] = [];
  const buffer = new EventBuffer(
    () => 'session-test',
    () => ({ domain: 'jobs.example.com', path: '/apply', sanitized_url: '', title: '', frame: 'top' }),
    (batch) => {
      events.push(...batch);
    },
  );
  const assessments: number[] = [];
  const attempts: number[] = [];
  const detector = new SubmissionDetector({
    buffer,
    adapter: () => adapter,
    onAssessment: (a) => assessments.push(a.confidence_score),
    onSubmitAttempt: () => attempts.push(1),
  });
  detector.start();
  return { detector, buffer, events, assessments, attempts, flush: () => buffer.flush() };
}

// ---------------------------------------------------------------------------

describe('confidence scoring', () => {
  it('scores nothing as zero', () => {
    const result = scoreSignals([]);
    expect(result.confidence_score).toBe(0);
    expect(result.state).toBe('unknown');
    expect(result.evidence).toHaveLength(0);
  });

  it('never reaches confirmed from a click alone', () => {
    const result = scoreSignals([signal('submit_button_clicked', 'dom_intent')]);
    expect(result.confidence_score).toBe(0.2);
    expect(result.state).toBe('clicked_only');
    expect(result.confirmation_detected).toBe(false);
  });

  it('never reaches confirmed from a successful POST alone', () => {
    const result = scoreSignals([
      signal('submit_button_clicked', 'dom_intent'),
      signal('form_submit_event', 'dom_submit'),
      signal('submission_request_success', 'network'),
    ]);
    expect(result.state).toBe('submitted');
    expect(result.confidence_score).toBeGreaterThan(0.8);
    expect(result.state).not.toBe('confirmed');
  });

  it('reaches confirmed only with confirmation-class evidence', () => {
    const result = scoreSignals([
      signal('submit_button_clicked', 'dom_intent'),
      signal('form_submit_event', 'dom_submit'),
      signal('submission_request_success', 'network'),
      signal('confirmation_text', 'confirmation'),
    ]);
    expect(result.state).toBe('confirmed');
    expect(result.confidence_score).toBeGreaterThanOrEqual(DEFAULT_SCORING.confirm_threshold);
  });

  it('does not inflate the score from repeated signals of one class', () => {
    const once = scoreSignals([signal('submit_button_clicked', 'dom_intent')]);
    const thrice = scoreSignals([
      signal('submit_button_clicked', 'dom_intent'),
      signal('submit_button_clicked', 'dom_intent'),
      signal('submit_button_clicked', 'dom_intent'),
    ]);
    expect(thrice.confidence_score).toBe(once.confidence_score);
    expect(thrice.evidence.filter((e) => e.counted)).toHaveLength(1);
    expect(thrice.evidence).toHaveLength(3); // all retained for inspection
  });

  it('subtracts negative evidence', () => {
    const positive = scoreSignals([signal('submit_button_clicked', 'dom_intent'), signal('form_submit_event', 'dom_submit')]);
    const contradicted = scoreSignals([
      signal('submit_button_clicked', 'dom_intent'),
      signal('form_submit_event', 'dom_submit'),
      signal('validation_error_after_submit', 'negative'),
    ]);
    expect(contradicted.confidence_score).toBeLessThan(positive.confidence_score);
    expect(contradicted.negative_evidence).toHaveLength(1);
  });

  it('classifies a click that produced nothing as click_without_submission', () => {
    const result = scoreSignals([
      signal('submit_button_clicked', 'dom_intent'),
      signal('validation_error_after_submit', 'negative'),
    ]);
    expect(result.state).toBe('click_without_submission');
    expect(result.submit_detected).toBe(false);
  });

  it('classifies submission with no observed click', () => {
    const result = scoreSignals([signal('submission_request_success', 'network')]);
    expect(result.state).toBe('submission_without_click');
    expect(result.notes.join(' ')).toMatch(/keyboard submit|SPA/i);
  });

  it('is reproducible from the stored evidence weights', () => {
    const signals = [
      signal('submit_button_clicked', 'dom_intent'),
      signal('form_submit_event', 'dom_submit'),
      signal('submission_request_success', 'network'),
    ];
    const result = scoreSignals(signals);
    const recomputed = result.evidence
      .filter((e) => e.counted)
      .reduce((acc, e) => 1 - (1 - acc) * (1 - e.weight), 0);
    expect(Number(recomputed.toFixed(4))).toBe(result.confidence_score);
  });

  it('honours a custom scoring configuration', () => {
    const strict = {
      ...DEFAULT_SCORING,
      weights: { ...DEFAULT_SCORING.weights, confirmation_text: 0.5 },
      confirm_threshold: 0.99,
    };
    const result = scoreSignals([signal('confirmation_text', 'confirmation')], strict);
    expect(result.state).not.toBe('confirmed');
    expect(result.notes.join(' ')).toMatch(/below the configured threshold/);
  });
});

// ---------------------------------------------------------------------------

describe('signal A — DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="app">
        <input name="email" />
        <button type="button" id="apply">Submit application</button>
      </form>`;
  });

  it('detects a click on a submit-like control', async () => {
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await h.flush();
    expect(h.detector.current().applied_clicked).toBe(true);
    expect(h.events.map((e) => e.event_type)).toContain('submit_button_click');
    expect(h.attempts).toHaveLength(1);
    h.detector.stop();
  });

  it('records which control was clicked and what it said', () => {
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const clicked = h.detector.current().clicked_control;
    expect(clicked?.text).toBe('Submit application');
    expect(clicked?.tag).toBe('button');
    expect(clicked?.dom_path).toContain('button');
    h.detector.stop();
  });

  it('has no clicked control recorded before anything is clicked', () => {
    const h = harness();
    expect(h.detector.current().clicked_control).toBeNull();
    h.detector.stop();
  });

  it('ignores clicks on unrelated controls', async () => {
    document.body.innerHTML = '<button id="cancel">Cancel</button><button id="search">Search</button>';
    const h = harness();
    document.getElementById('cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('search')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.detector.current().applied_clicked).toBe(false);
    h.detector.stop();
  });

  it('detects a native form submit event', async () => {
    const h = harness();
    document.getElementById('app')!.dispatchEvent(new Event('submit', { bubbles: true }));
    await h.flush();
    expect(h.detector.current().submit_detected).toBe(true);
    expect(h.events.map((e) => e.event_type)).toContain('form_submit');
    h.detector.stop();
  });

  it('treats Enter inside a form as submission intent', () => {
    const h = harness();
    document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.detector.current().applied_clicked).toBe(true);
    h.detector.stop();
  });
});

// ---------------------------------------------------------------------------

describe('signal B — network', () => {
  beforeEach(() => {
    document.body.innerHTML = '<form><button id="apply">Apply now</button></form>';
  });

  const meta = (over: Partial<Parameters<SubmissionDetector['onNetworkRequest']>[0]> = {}) => ({
    method: 'POST',
    url: 'https://jobs.example.com/api/application',
    origin_kind: 'same_origin' as const,
    status: 200,
    ok: true,
    duration_ms: 120,
    transport: 'fetch' as const,
    looks_like_submission: true,
    reasons: ['method_post', 'path_application'],
    request_body_bytes: 512,
    ...over,
  });

  it('counts a successful submission-shaped request', async () => {
    const h = harness();
    h.detector.onNetworkRequest(meta());
    await h.flush();
    const current = h.detector.current();
    expect(current.submit_detected).toBe(true);
    expect(current.evidence_kinds).toContain('submission_request_success');
    const event = h.events.find((e) => e.event_type === 'network_request');
    expect(event).toBeDefined();
    // Metadata must never contain a body.
    expect(JSON.stringify(event!.metadata)).not.toMatch(/"body"|"payload"/);
    h.detector.stop();
  });

  it('treats a 4xx response as negative evidence', () => {
    const h = harness();
    h.detector.onNetworkRequest(meta({ status: 422, ok: false }));
    const current = h.detector.current();
    expect(current.negative_evidence.map((e) => e.kind)).toContain('submission_request_failed');
    expect(current.state).not.toBe('confirmed');
    h.detector.stop();
  });

  it('ignores unrelated requests that are not correlated with a submit intent', () => {
    const h = harness();
    h.detector.onNetworkRequest(meta({ url: 'https://jobs.example.com/api/search', looks_like_submission: false, reasons: [] }));
    expect(h.detector.current().evidence).toHaveLength(0);
    h.detector.stop();
  });

  it('counts an otherwise-unremarkable request when it follows a click', () => {
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    h.detector.onNetworkRequest(meta({ url: 'https://jobs.example.com/x/y', looks_like_submission: false, reasons: [] }));
    expect(h.detector.current().evidence_kinds).toContain('submission_request_success');
    h.detector.stop();
  });
});

describe('network bridge', () => {
  it('accepts metadata from the page hook and sanitizes the URL', () => {
    const received: unknown[] = [];
    const bridge = new NetworkBridge(
      (m) => received.push(m),
      () => null,
      window,
    );
    bridge.start();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: PAGE_HOOK_CHANNEL,
          kind: 'network',
          payload: {
            method: 'POST',
            url: 'https://jobs.example.com/api/apply?token=SECRETTOKENVALUE',
            status: 201,
            ok: true,
            duration_ms: 42,
            transport: 'fetch',
            request_body_bytes: 100,
            started_at: Date.now(),
          },
        },
      }),
    );
    expect(received).toHaveLength(1);
    const meta = received[0] as { url: string; looks_like_submission: boolean };
    expect(meta.url).not.toContain('SECRETTOKENVALUE');
    expect(meta.looks_like_submission).toBe(true);
    bridge.stop();
  });

  it('drops analytics traffic entirely', () => {
    const received: unknown[] = [];
    const bridge = new NetworkBridge(
      (m) => received.push(m),
      () => null,
      window,
    );
    bridge.start();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: PAGE_HOOK_CHANNEL,
          kind: 'network',
          payload: {
            method: 'POST',
            url: 'https://jobs.example.com/analytics/collect',
            status: 200,
            ok: true,
            duration_ms: 5,
            transport: 'beacon',
            request_body_bytes: 20,
            started_at: Date.now(),
          },
        },
      }),
    );
    expect(received).toHaveLength(0);
    bridge.stop();
  });

  it('ignores messages from other windows', () => {
    const received: unknown[] = [];
    const bridge = new NetworkBridge(
      (m) => received.push(m),
      () => null,
      window,
    );
    bridge.start();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: null,
        data: { channel: PAGE_HOOK_CHANNEL, kind: 'network', payload: { method: 'POST', url: 'https://x/apply' } },
      }),
    );
    expect(received).toHaveLength(0);
    bridge.stop();
  });
});

// ---------------------------------------------------------------------------

describe('signal C — navigation', () => {
  it('counts navigation to a confirmation page', () => {
    const h = harness();
    const page: PageRecord = {
      page_id: 'pg_1',
      sanitized_url: 'https://jobs.example.com/apply/123/confirmation',
      domain: 'jobs.example.com',
      path: '/apply/123/confirmation',
      title: 'Application submitted',
      referrer: null,
      entry_point: 'spa_navigation',
      frame: 'top',
      page_type: 'confirmation',
      first_seen_at: nowIso(),
      last_seen_at: nowIso(),
      sequence: 1,
    };
    h.detector.onNavigation(page);
    expect(h.detector.current().evidence_kinds).toContain('confirmation_navigation');
    h.detector.stop();
  });
});

// ---------------------------------------------------------------------------

describe('signal D — DOM confirmation', () => {
  it('detects a confirmation heading', () => {
    document.body.innerHTML = '<h1>Your application has been submitted</h1>';
    const h = harness();
    expect(h.detector.checkConfirmation()).toBe(true);
    expect(h.detector.current().confirmation_detected).toBe(true);
    h.detector.stop();
  });

  it('detects a success toast', () => {
    document.body.innerHTML = '<div role="status">Successfully applied to Senior Engineer</div>';
    const h = harness();
    expect(h.detector.checkConfirmation()).toBe(true);
    h.detector.stop();
  });

  it('does not fire on an unrelated heading', () => {
    document.body.innerHTML = '<h1>Apply for this role</h1>';
    const h = harness();
    expect(h.detector.checkConfirmation()).toBe(false);
    h.detector.stop();
  });

  it('caps the stored excerpt and redacts contact details in it', async () => {
    document.body.innerHTML = `<div role="status">Application submitted. We emailed jane.doe@example.com.</div>`;
    const h = harness();
    h.detector.checkConfirmation();
    await h.flush();
    const event = h.events.find((e) => e.event_type === 'dom_confirmation')!;
    const excerpt = String((event.metadata as Record<string, unknown>).excerpt);
    expect(excerpt).not.toContain('jane.doe@example.com');
    expect(excerpt.length).toBeLessThanOrEqual(getConfig().dom.max_excerpt_length + 1);
    h.detector.stop();
  });

  it('uses the portal adapter rule when one applies', () => {
    document.body.innerHTML = '<div data-application-state="submitted">Done</div>';
    const h = harness(examplePortalAdapter);
    expect(h.detector.checkConfirmation()).toBe(true);
    expect(h.detector.current().evidence_kinds).toContain('adapter_confirmation');
    expect(h.detector.current().state).toBe('confirmed');
    h.detector.stop();
  });

  it('treats the clicked control\'s own label flipping to "Applied" as confirmation (easy-apply flows with no toast/modal)', () => {
    document.body.innerHTML = '<button type="button">Apply</button>';
    const h = harness();
    const button = document.querySelector('button')!;

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.attempts).toHaveLength(1);

    // No toast/modal/heading appears — the button just relabels itself in place.
    button.textContent = 'Applied';
    expect(h.detector.checkConfirmation()).toBe(true);
    expect(h.detector.current().confirmation_detected).toBe(true);
    expect(h.detector.current().evidence_kinds).toContain('application_status_changed');
    h.detector.stop();
  });

  it('does not treat the original "Apply" label as its own confirmation', () => {
    document.body.innerHTML = '<button type="button">Apply</button>';
    const h = harness();
    const button = document.querySelector('button')!;

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Text never changes after the click.
    expect(h.detector.checkConfirmation()).toBe(false);
    h.detector.stop();
  });

  it('only fires the button-state confirmation once per click', () => {
    document.body.innerHTML = '<button type="button">Apply</button>';
    const h = harness();
    const button = document.querySelector('button')!;

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.textContent = 'Applied';
    expect(h.detector.checkConfirmation()).toBe(true);
    expect(h.detector.checkConfirmation()).toBe(false);
    h.detector.stop();
  });
});

// ---------------------------------------------------------------------------

describe('unconfirmed-submission context snapshot', () => {
  it('captures a sanitized excerpt once a submit is detected but never confirmed', () => {
    document.body.innerHTML = `
      <form id="app">
        <button type="submit">Apply</button>
        <div role="status">Thanks jane.doe@example.com, we received it.</div>
      </form>
    `;
    const h = harness();
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('app')!.dispatchEvent(new Event('submit', { bubbles: true }));

    expect(h.detector.current().submit_detected).toBe(true);
    expect(h.detector.current().confirmation_detected).toBe(false);
    expect(h.detector.current().context_excerpt).toBeNull();

    h.detector.captureContext();

    const excerpt = h.detector.current().context_excerpt;
    expect(excerpt).not.toBeNull();
    expect(excerpt).not.toContain('jane.doe@example.com');
    expect(excerpt!.length).toBeLessThanOrEqual(301);
    h.detector.stop();
  });

  it('does not capture once a real confirmation was already found', () => {
    document.body.innerHTML = '<h1>Your application has been submitted</h1><button type="button">Apply</button>';
    const h = harness();
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    h.detector.checkConfirmation();
    expect(h.detector.current().confirmation_detected).toBe(true);

    h.detector.captureContext();
    expect(h.detector.current().context_excerpt).toBeNull();
    h.detector.stop();
  });

  it('does not capture before any submit evidence exists (a click alone)', () => {
    document.body.innerHTML = '<button type="button">Apply</button>';
    const h = harness();
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.detector.current().submit_detected).toBe(false);

    h.detector.captureContext();
    expect(h.detector.current().context_excerpt).toBeNull();
    h.detector.stop();
  });

  it('captures at most once per session', () => {
    document.body.innerHTML = `
      <form id="app">
        <button type="submit">Apply</button>
        <div role="alert">Something happened</div>
      </form>
    `;
    const h = harness();
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('app')!.dispatchEvent(new Event('submit', { bubbles: true }));

    h.detector.captureContext();
    const first = h.detector.current().context_excerpt;
    expect(first).not.toBeNull();

    document.querySelector('[role="alert"]')!.textContent = 'A completely different message';
    h.detector.captureContext();
    expect(h.detector.current().context_excerpt).toBe(first);
    h.detector.stop();
  });
});

/** jsdom never lays out elements, so `isVisible()` treats everything as hidden by
 *  default (`offsetParent` is always null) — mark the node under test visible the same
 *  way a real, rendered element would report itself. */
function markVisible(el: Element): void {
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
}

describe('validation errors', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <input name="email" aria-invalid="true" />
        <span class="field-error">Email is required</span>
        <button type="button" id="apply">Submit application</button>
      </form>`;
    markVisible(document.querySelector('.field-error')!);
  });

  it('collects errors from the DOM', () => {
    const errors = collectValidationErrors(document);
    expect(errors).not.toBeNull();
    expect(errors!.count).toBeGreaterThan(0);
    expect(errors!.excerpt).toContain('required');
  });

  it('ignores a hidden node that merely matches an error-ish class — a React error-boundary fallback, say', () => {
    // Real case: a GitHub tab the candidate opened mid-application (to copy a profile
    // URL) fired this exact pattern — GitHub's own always-in-the-DOM, hidden
    // error-boundary text ("Uh oh! There was an error while loading...") got picked up
    // as validation-error evidence against a completely unrelated job application.
    document.body.innerHTML = `
      <form>
        <div class="error-boundary" hidden>Uh oh! There was an error while loading.</div>
        <button type="button" id="apply">Submit application</button>
      </form>`;
    expect(collectValidationErrors(document)).toBeNull();
  });

  it('ignores a bare aria-invalid flag with no message shown to the user', () => {
    // Real case: MUI/React Hook Form/Formik set aria-invalid="true" on an empty required
    // field the moment it's touched, whether or not any error text is ever rendered —
    // that alone must not count as validation-error evidence, or every ordinary,
    // successful submission with an untouched optional field gets flagged.
    document.body.innerHTML = `
      <form>
        <input name="phone" aria-invalid="true" />
        <button type="button" id="apply">Submit application</button>
      </form>`;
    markVisible(document.querySelector('input')!);
    expect(collectValidationErrors(document)).toBeNull();
  });

  it('counts an aria-invalid field via its accessible description', () => {
    // MUI's real pattern: the input links to its FormHelperText through aria-describedby
    // rather than carrying the message itself.
    document.body.innerHTML = `
      <form>
        <input name="phone" aria-invalid="true" aria-describedby="phone-helper" />
        <p id="phone-helper">Phone number is required</p>
        <button type="button" id="apply">Submit application</button>
      </form>`;
    markVisible(document.querySelector('input')!);
    const errors = collectValidationErrors(document);
    expect(errors).not.toBeNull();
    expect(errors!.excerpt).toContain('Phone number is required');
  });

  it('counts errors as negative evidence only when they follow a submit attempt', () => {
    const h = harness();
    h.detector.reportValidationErrors({ count: 1, fields: [], excerpt: 'Email is required' });
    expect(h.detector.current().negative_evidence).toHaveLength(0);

    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    h.detector.reportValidationErrors({ count: 1, fields: [], excerpt: 'Email is required' });
    expect(h.detector.current().negative_evidence.map((e) => e.kind)).toContain('validation_error_after_submit');
    expect(h.detector.current().state).toBe('click_without_submission');
    h.detector.stop();
  });

  it('is the documented "apply clicked but nothing happened" scenario', () => {
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    h.detector.reportValidationErrors({ count: 2, fields: [], excerpt: 'Required' });
    const current = h.detector.current();
    expect(current.applied_clicked).toBe(true);
    expect(current.submit_detected).toBe(false);
    expect(current.state).toBe('click_without_submission');
    expect(current.confidence_score).toBeLessThan(DEFAULT_SCORING.submit_threshold);
    h.detector.stop();
  });
});

describe('form lifecycle', () => {
  it('records the form disappearing after a submit attempt', async () => {
    document.body.innerHTML = '<form id="f"><button type="button" id="apply">Submit application</button></form>';
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.innerHTML = '<div>Processing…</div>';
    h.detector.checkFormLifecycle();
    await h.flush();
    expect(h.detector.current().evidence_kinds).toContain('form_removed');
    expect(h.events.map((e) => e.event_type)).toContain('form_removed');
    h.detector.stop();
  });

  it('does not record form removal without a preceding submit attempt', () => {
    document.body.innerHTML = '<form id="f"><button>Submit application</button></form>';
    const h = harness();
    h.detector.checkFormLifecycle();
    document.body.innerHTML = '';
    h.detector.checkFormLifecycle();
    expect(h.detector.current().evidence_kinds).not.toContain('form_removed');
    h.detector.stop();
  });
});

describe('click watchdog', () => {
  it('records silence after a click as negative evidence', async () => {
    setConfig({ session: { ...getConfig().session, submit_correlation_window_ms: 20 } });
    document.body.innerHTML = '<form><button type="button" id="apply">Submit application</button></form>';
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const current = h.detector.current();
    expect(current.negative_evidence.map((e) => e.kind)).toContain('form_still_present');
    expect(current.state).toBe('click_without_submission');
    h.detector.stop();
  });

  it('stays quiet when the submission did go through', async () => {
    setConfig({ session: { ...getConfig().session, submit_correlation_window_ms: 20 } });
    document.body.innerHTML = '<form><button type="button" id="apply">Submit application</button></form>';
    const h = harness();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    h.detector.onNetworkRequest({
      method: 'POST',
      url: 'https://jobs.example.com/api/application',
      origin_kind: 'same_origin',
      status: 201,
      ok: true,
      duration_ms: 30,
      transport: 'fetch',
      looks_like_submission: true,
      reasons: ['path_application'],
      request_body_bytes: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(h.detector.current().negative_evidence).toHaveLength(0);
    h.detector.stop();
  });
});
