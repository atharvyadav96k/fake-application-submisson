import { beforeEach, describe, expect, it } from 'vitest';
import { genericAdapter } from '@/collector/adapters/generic-adapter';
import { getConfig, setConfig } from '@/common/config';
import { EventBuffer } from '@/collector/content/event-buffer';
import { FieldTracker } from '@/collector/content/field-tracker';
import { FormTracker, type DomChangeSummary } from '@/collector/content/form-tracker';
import { PageDetector, type PageTransition } from '@/collector/content/page-detector';
import { settle, setUrl } from './setup';

/**
 * SPA behaviour: route changes without a reload, dynamically rendered forms,
 * multi-step flows, and modal application forms.
 */

function fieldHarness() {
  setConfig({ dom: { ...getConfig().dom, fill_settle_ms: 1, mutation_debounce_ms: 5 } });
  const buffer = new EventBuffer(
    () => 'session-spa',
    () => ({ domain: 'jobs.example-portal.com', path: '/apply', sanitized_url: '', title: '', frame: 'top' }),
    () => undefined,
  );
  const tracker = new FieldTracker({
    buffer,
    adapter: () => genericAdapter,
    candidate: () => null,
    salt: () => 'salt',
    onFirstFill: () => undefined,
    onSnapshot: () => undefined,
  });
  tracker.start();
  return { tracker, buffer };
}

describe('page detection and routing', () => {
  beforeEach(() => {
    setUrl('https://jobs.example-portal.com/jobs/123');
  });

  it('records the initial page load', () => {
    const detector = new PageDetector(window);
    const initial = detector.start(() => undefined);
    expect(initial.kind).toBe('initial_load');
    expect(initial.to.domain).toBe('jobs.example-portal.com');
    expect(initial.to.path).toBe('/jobs/123');
    detector.stop();
  });

  it('emits a transition on history.pushState', async () => {
    const transitions: PageTransition[] = [];
    const detector = new PageDetector(window);
    detector.start((t) => transitions.push(t));

    window.history.pushState({}, '', '/apply/123');
    await settle(5);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.kind).toBe('spa_navigation');
    expect(transitions[0]!.path_changed).toBe(true);
    expect(transitions[0]!.from?.path).toBe('/jobs/123');
    expect(transitions[0]!.to.path).toBe('/apply/123');
    detector.stop();
  });

  it('emits a transition on replaceState and popstate', async () => {
    const transitions: PageTransition[] = [];
    const detector = new PageDetector(window);
    detector.start((t) => transitions.push(t));

    window.history.replaceState({}, '', '/apply/123/step-2');
    await settle(5);
    setUrl('/apply/123/step-3');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle(5);

    expect(transitions.map((t) => t.to.path)).toEqual(['/apply/123/step-2', '/apply/123/step-3']);
    detector.stop();
  });

  it('restores the original history methods on stop', () => {
    const original = window.history.pushState;
    const detector = new PageDetector(window);
    detector.start(() => undefined);
    expect(window.history.pushState).not.toBe(original);
    detector.stop();
    expect(window.history.pushState).toBe(original);
  });

  it('keeps one page record per distinct URL', async () => {
    const detector = new PageDetector(window);
    detector.start(() => undefined);
    window.history.pushState({}, '', '/apply/123');
    await settle(5);
    window.history.pushState({}, '', '/jobs/123');
    await settle(5);
    window.history.pushState({}, '', '/apply/123');
    await settle(5);
    expect(detector.allPages()).toHaveLength(2);
    detector.stop();
  });

  it('classifies page types from the URL and DOM', async () => {
    setUrl('https://jobs.example-portal.com/apply/123/confirmation');
    const detector = new PageDetector(window);
    const t = detector.start(() => undefined);
    expect(t.page_type).toBe('confirmation');
    detector.stop();
  });

  it('sanitizes the URL it stores', () => {
    setUrl('https://jobs.example-portal.com/apply?id=9&access_token=SECRETVALUE123');
    const detector = new PageDetector(window);
    const t = detector.start(() => undefined);
    expect(t.to.sanitized_url).not.toContain('SECRETVALUE123');
    expect(t.to.sanitized_url).toContain('id=9');
    detector.stop();
  });
});

describe('dynamic form rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('notifies when a form is rendered after page load', async () => {
    const summaries: DomChangeSummary[] = [];
    setConfig({ dom: { ...getConfig().dom, mutation_debounce_ms: 5 } });
    const tracker = new FormTracker((s) => summaries.push(s), document);
    tracker.start();

    const root = document.getElementById('root')!;
    const form = document.createElement('form');
    form.innerHTML = '<label for="e">Email address</label><input id="e" name="email" />';
    root.append(form);

    await settle(30);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some((s) => s.addedRoots.length > 0 || s.formStructureChanged)).toBe(true);
    tracker.stop();
  });

  it('ignores mutations that contain no form controls', async () => {
    const summaries: DomChangeSummary[] = [];
    setConfig({ dom: { ...getConfig().dom, mutation_debounce_ms: 5 } });
    const tracker = new FormTracker((s) => summaries.push(s), document);
    tracker.start();

    const root = document.getElementById('root')!;
    for (let i = 0; i < 50; i++) {
      const div = document.createElement('div');
      div.textContent = `row ${i}`;
      root.append(div);
    }
    await settle(30);
    expect(summaries).toHaveLength(0);
    tracker.stop();
  });

  it('flags nodes that look like confirmation UI', async () => {
    const summaries: DomChangeSummary[] = [];
    setConfig({ dom: { ...getConfig().dom, mutation_debounce_ms: 5 } });
    const tracker = new FormTracker((s) => summaries.push(s), document);
    tracker.start();

    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.textContent = 'Application submitted';
    document.body.append(toast);

    await settle(30);
    expect(summaries.some((s) => s.possibleConfirmation)).toBe(true);
    tracker.stop();
  });

  it('picks up controls rendered into a modal', async () => {
    const h = fieldHarness();
    expect(h.tracker.snapshot()).toHaveLength(0);

    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `
      <label for="m-email">Email address</label><input id="m-email" name="email" />
      <label for="m-phone">Phone</label><input id="m-phone" name="phone" />`;
    document.body.append(modal);
    h.tracker.scan(modal);

    expect(h.tracker.snapshot().map((f) => f.canonical_field).sort()).toEqual(['email', 'phone']);
    h.tracker.stop();
  });
});

describe('multi-step applications', () => {
  it('keeps records from earlier steps and marks them detached', async () => {
    document.body.innerHTML = `
      <div id="step">
        <label for="fn">First name</label><input id="fn" name="fname" />
        <label for="ln">Last name</label><input id="ln" name="lname" />
      </div>`;
    const h = fieldHarness();

    const step = document.getElementById('step')!;
    const first = document.getElementById('fn') as HTMLInputElement;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', bubbles: true }));
    first.value = 'Jane';
    first.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await settle();

    // Step 2 replaces the DOM of step 1.
    step.innerHTML = `
      <label for="co">Current company</label><input id="co" name="company" />
      <label for="ti">Job title</label><input id="ti" name="jobtitle" />`;
    h.tracker.reconcileDetached();
    h.tracker.scan(step);
    await settle();

    const records = h.tracker.snapshot();
    expect(records).toHaveLength(4);
    const firstNameRecord = records.find((r) => r.canonical_field === 'first_name')!;
    expect(firstNameRecord.detached_at).not.toBeNull();
    expect(firstNameRecord.state).toBe('filled');
    expect(records.find((r) => r.canonical_field === 'current_company')!.detached_at).toBeNull();
    h.tracker.stop();
  });

  it('continues the fill sequence across steps', async () => {
    document.body.innerHTML = '<div id="step"><label for="fn">First name</label><input id="fn" /></div>';
    const h = fieldHarness();
    const first = document.getElementById('fn') as HTMLInputElement;
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', bubbles: true }));
    first.value = 'Jane';
    first.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await settle();

    const step = document.getElementById('step')!;
    step.innerHTML = '<label for="co">Current company</label><input id="co" />';
    h.tracker.scan(step);
    const company = document.getElementById('co') as HTMLInputElement;
    company.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', bubbles: true }));
    company.value = 'Example Ltd';
    company.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await settle();

    expect(h.tracker.fillOrder().map((f) => f.interaction.fill_sequence_number)).toEqual([1, 2]);
    h.tracker.stop();
  });
});
