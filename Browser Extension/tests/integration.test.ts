import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/client';
import { buildSessionPayload } from '@/background/payload-builder';
import { Uploader } from '@/background/uploader';
import { collectEnvironment, parseUserAgent } from '@/background/environment';
import { getConfig, setConfig } from '@/common/config';
import type { ContentToBackground } from '@/common/messages';
import { Observer } from '@/collector/content/observer';
import type { ActivityEvent } from '@/models/event';
import type { CandidateRecord } from '@/models/session';
import { EventStore } from '@/storage/event-store';
import { MemoryDriver } from '@/storage/local';
import { SessionStore } from '@/storage/session-store';
import { settle, setUrl } from './setup';

/**
 * End-to-end flows: a content script observing a full application, the background
 * assembling a payload, and the uploader delivering it (including offline retry).
 */

const CANDIDATE: CandidateRecord = {
  candidate_id: 'cand-1',
  fields: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    phone: '+91 98765 43210',
    current_company: 'Example Ltd',
    current_job_title: 'Senior Engineer',
  },
  fetched_at: new Date().toISOString(),
};

const APPLICATION_HTML = `
  <form id="application">
    <label for="fn">First name</label><input id="fn" name="fname" required />
    <label for="ln">Last name</label><input id="ln" name="lname" required />
    <label for="em">Email address</label><input id="em" name="email" type="email" required />
    <label for="ph">Phone</label><input id="ph" name="phone" type="tel" />
    <label for="co">Current company</label><input id="co" name="company" />
    <label for="ti">Job title</label><input id="ti" name="jobtitle" />
    <label for="pw">Account password</label><input id="pw" name="password" type="password" />
    <button type="button" id="apply">Submit application</button>
  </form>`;

function typeInto(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  for (const ch of value) input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

/** Wires an Observer to real stores through the same message shapes the SW handles. */
async function bootstrap() {
  setConfig({
    dom: { ...getConfig().dom, fill_settle_ms: 1, mutation_debounce_ms: 5 },
    session: { ...getConfig().session, submit_correlation_window_ms: 2000 },
  });

  const sessions = new SessionStore(new MemoryDriver(), new MemoryDriver());
  const events = new EventStore(new MemoryDriver());
  const session = await sessions.start({
    operator_id: 'op-1',
    candidate_id: 'cand-1',
    candidate_email: 'jane.doe@example.com',
    portal_domain: 'jobs.example-portal.com',
    adapter_name: 'example-portal',
    matched_adapter: 'known',
  });
  await sessions.setCandidate(CANDIDATE);

  const sent: ActivityEvent[] = [];
  const send = async (message: ContentToBackground) => {
    switch (message.type) {
      case 'REQUEST_CONTEXT':
        return { type: 'CONTEXT' as const, session, candidate: CANDIDATE, config_override: null };
      case 'EVENT_BATCH':
        sent.push(...message.events);
        await events.append(message.events);
        return { ok: true };
      case 'FIELD_SNAPSHOT':
        await sessions.upsertFields(message.fields);
        return { ok: true };
      case 'PAGE_SNAPSHOT':
        await sessions.upsertPages(message.pages);
        return { ok: true };
      case 'SUBMISSION_UPDATE':
        await sessions.setSubmission(message.assessment);
        return { ok: true };
      default:
        return { ok: true };
    }
  };

  const observer = new Observer(window, send as never);
  await observer.start();
  return { observer, sessions, events, sent, session };
}

describe('end-to-end application flow', () => {
  beforeEach(() => {
    setUrl('https://jobs.example-portal.com/apply/job-123');
    document.body.innerHTML = APPLICATION_HTML;
  });

  it('observes filling, submission, and confirmation, then produces a payload', async () => {
    const ctx = await bootstrap();

    typeInto('fn', 'Jane');
    await settle();
    typeInto('ln', 'Doe');
    await settle();
    typeInto('em', 'jane.doe@example.com');
    await settle();
    typeInto('co', 'Example Ltd');
    await settle();

    // Operator clicks Apply.
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // The page posts the application and then renders the confirmation.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: '__aav_page_hook__',
          kind: 'network',
          payload: {
            method: 'POST',
            url: 'https://jobs.example-portal.com/api/v1/applications',
            status: 201,
            ok: true,
            duration_ms: 180,
            transport: 'fetch',
            request_body_bytes: 2048,
            started_at: Date.now(),
          },
        },
      }),
    );

    document.body.innerHTML = '<div data-application-state="submitted">Application submitted</div>';
    window.history.pushState({}, '', '/apply/job-123/confirmation');
    await settle(60);
    // Ending the observer flushes the final snapshots, exactly as the popup's
    // END_SESSION path does before the payload is assembled.
    ctx.observer.stop();
    await settle(20);

    const payload = await buildSessionPayload(ctx.sessions, ctx.events);
    expect(payload).not.toBeNull();

    // Submission evidence
    expect(payload!.submission.applied_clicked).toBe(true);
    expect(payload!.submission.submit_detected).toBe(true);
    expect(payload!.submission.confirmation_detected).toBe(true);
    expect(payload!.submission.state).toBe('confirmed');
    expect(payload!.submission.confidence_score).toBeGreaterThanOrEqual(0.85);
    expect(payload!.submission.evidence_kinds).toEqual(
      expect.arrayContaining(['submit_button_clicked', 'submission_request_success']),
    );

    // Field evidence
    const byField = new Map(payload!.fields.map((f) => [f.canonical_field, f]));
    expect(byField.get('first_name')!.match_result).toBe('match');
    expect(byField.get('current_company')!.value).toBe('Example Ltd');
    expect(byField.get('email')!.value).toBeNull();
    expect(byField.get('email')!.value_hash).toMatch(/^(sha256|fnv):/);
    expect(byField.get('password')!.sensitivity).toBe('never_store');

    // Fill order
    expect(payload!.fill_order.map((f) => f.canonical_field)).toEqual([
      'first_name',
      'last_name',
      'email',
      'current_company',
    ]);

    // Pages and events
    expect(payload!.pages.length).toBeGreaterThanOrEqual(2);
    expect(payload!.events.length).toBeGreaterThan(5);
    expect(payload!.schema_version).toBe('1.0');
    expect(payload!.environment.timezone).toBeTruthy();

    // Nothing sensitive escaped.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('jane.doe@example.com');
    expect(serialized).not.toContain('hunter2');
  });

  it('records the clicked-but-not-submitted case without calling it a submission', async () => {
    const ctx = await bootstrap();
    typeInto('fn', 'Jane');
    await settle();

    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The portal renders validation errors instead of submitting.
    const error = document.createElement('span');
    error.className = 'field-error';
    error.textContent = 'Email is required';
    document.getElementById('application')!.append(error);
    // jsdom never lays anything out, so `isVisible()` (which the validation-error scan
    // now checks, to ignore hidden template/error-boundary text) treats every element as
    // hidden by default — mark this one visible, the way a real rendered error would be.
    Object.defineProperty(error, 'offsetParent', { value: document.body, configurable: true });
    await settle(600); // the detector re-inspects shortly after a submit attempt

    const submission = await ctx.sessions.getSubmission();
    expect(submission.applied_clicked).toBe(true);
    expect(submission.submit_detected).toBe(false);
    expect(submission.state).toBe('click_without_submission');
    expect(submission.confidence_score).toBeLessThan(0.5);

    const ended = await ctx.sessions.end('operator_ended');
    expect(ended!.outcome).toBe('flagged');
    expect(ended!.outcome_reasons.join(' ')).toMatch(/negative evidence|no submission signal/);

    ctx.observer.stop();
  });

  it('marks unfilled fields as skipped when a submission is attempted', async () => {
    const ctx = await bootstrap();
    typeInto('fn', 'Jane');
    await settle();
    document.getElementById('apply')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(60);

    const fields = await ctx.sessions.getFields();
    const skipped = fields.filter((f) => f.interaction.skipped).map((f) => f.canonical_field);
    expect(skipped).toContain('last_name');
    expect(skipped).not.toContain('first_name');
    ctx.observer.stop();
  });

  it('does not collect on an origin outside the allow-list', async () => {
    setConfig({ allowed_origins: ['https://some-other-portal.example.com'] });
    const messages: string[] = [];
    const observer = new Observer(window, (async (m: ContentToBackground) => {
      messages.push(m.type);
      if (m.type === 'REQUEST_CONTEXT') {
        return {
          type: 'CONTEXT' as const,
          session: { session_id: 's', state: 'active', hash_salt: '' } as never,
          candidate: null,
          config_override: null,
        };
      }
      return { ok: true };
    }) as never);
    await observer.start();
    expect(messages).not.toContain('CONTENT_READY');
    observer.stop();
  });
});

describe('uploader', () => {
  async function fixture() {
    const sessions = new SessionStore(new MemoryDriver(), new MemoryDriver());
    const events = new EventStore(new MemoryDriver());
    const session = await sessions.start({
      operator_id: 'op',
      candidate_id: 'c',
      candidate_email: 'jane@example.com',
    });
    await events.append(
      Array.from({ length: 5 }, (_, i) => ({
        schema_version: '1.0',
        event_id: `e-${i}`,
        session_id: session.session_id,
        timestamp: new Date().toISOString(),
        monotonic_ms: i,
        event_type: 'field_input' as const,
        page: { domain: 'd', path: '/', sanitized_url: '', title: '', frame: 'top' as const },
        metadata: {},
      })),
    );
    return { sessions, events, session };
  }

  it('uploads a batch and acknowledges it', async () => {
    const { sessions, events } = await fixture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: [] }), { status: 200 }));
    const uploader = new Uploader(new ApiClient(fetchMock as never), events, sessions);

    expect(await uploader.flush(true)).toBe(true);
    expect(await events.size()).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.schema_version).toBe('1.0');
    expect(body.events).toHaveLength(5);
    expect(body.environment.extension_version).toBe('1.0.0');
  });

  it('retains events and backs off when the network fails', async () => {
    const { sessions, events } = await fixture();
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const uploader = new Uploader(new ApiClient(fetchMock as never), events, sessions);

    expect(await uploader.flush(true)).toBe(false);
    expect(await events.size()).toBe(5);
    const state = uploader.getState();
    expect(state.attempt).toBe(1);
    expect(state.next_attempt_at).not.toBeNull();
    expect(state.last_error).toContain('network down');
  });

  it('retries after a 5xx and succeeds later', async () => {
    const { sessions, events } = await fixture();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ accepted: [] }), { status: 200 });
    });
    const uploader = new Uploader(new ApiClient(fetchMock as never), events, sessions);

    await uploader.flush(true);
    expect(await events.size()).toBe(5);
    await uploader.flush(true);
    expect(await events.size()).toBe(0);
  });

  it('drops a batch the backend permanently rejects rather than blocking the queue', async () => {
    const { sessions, events } = await fixture();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 400 }));
    const uploader = new Uploader(new ApiClient(fetchMock as never), events, sessions);
    await uploader.flush(true);
    expect(await events.size()).toBe(0);
  });

  it('finalizes with the full payload and purges the session', async () => {
    const { sessions, events, session } = await fixture();
    await sessions.end('operator_ended');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ received: true }), { status: 200 }));
    const uploader = new Uploader(new ApiClient(fetchMock as never), events, sessions);

    expect(await uploader.finalize()).toBe(true);
    const finalCall = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(finalCall[0]).toContain(`/v1/activity/sessions/${session.session_id}/finalize`);
    const payload = JSON.parse(String(finalCall[1].body));
    expect(payload.session.outcome).toBeDefined();
    expect(payload.partial).toBe(false);
    // The hashing salt stays in the browser.
    expect(payload.session.hash_salt).toBe('');
    expect(await events.allForSession(session.session_id)).toHaveLength(0);
  });

  it('keeps session data when finalize fails', async () => {
    const { sessions, events, session } = await fixture();
    await sessions.end('operator_ended');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    const uploader = new Uploader(new ApiClient(fetchMock as never), events, sessions);
    expect(await uploader.finalize()).toBe(false);
    expect((await events.allForSession(session.session_id)).length).toBeGreaterThan(0);
  });
});

describe('environment metadata', () => {
  it('parses browser families in the right order', () => {
    expect(parseUserAgent('Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36').browser).toBe('Chrome');
    expect(parseUserAgent('Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0').browser).toBe('Edge');
    expect(parseUserAgent('Mozilla/5.0 Firefox/128.0').browser).toBe('Firefox');
    expect(parseUserAgent('nonsense').browser).toBe('unknown');
  });

  it('collects only coarse environment data', () => {
    const env = collectEnvironment();
    expect(env.extension_version).toBe('1.0.0');
    expect(env.timezone).toBeTruthy();
    expect(typeof env.timezone_offset_minutes).toBe('number');
    expect(Object.keys(env).sort()).toEqual(
      [
        'browser',
        'browser_version',
        'engine',
        'extension_version',
        'language',
        'platform',
        'timestamp',
        'timezone',
        'timezone_offset_minutes',
        'viewport',
      ].sort(),
    );
  });
});
