import { beforeEach, describe, expect, it } from 'vitest';
import { genericAdapter } from '@/collector/adapters/generic-adapter';
import { getConfig, setConfig } from '@/common/config';
import { EventBuffer } from '@/collector/content/event-buffer';
import { deriveState, FieldTracker } from '@/collector/content/field-tracker';
import type { ActivityEvent, EventType } from '@/models/event';
import type { CandidateRecord } from '@/models/session';
import { settle } from './setup';

/** Harness that wires a FieldTracker to an in-memory event sink. */
function harness(candidate: CandidateRecord | null = null) {
  // Shorten the settle debounce so tests do not wait on the production delay.
  setConfig({ dom: { ...getConfig().dom, fill_settle_ms: 1 } });
  const events: ActivityEvent[] = [];
  const snapshots: number[] = [];
  const buffer = new EventBuffer(
    () => 'session-test',
    () => ({ domain: 'jobs.example.com', path: '/apply', sanitized_url: '', title: '', frame: 'top' }),
    (batch) => {
      events.push(...batch);
    },
  );
  const tracker = new FieldTracker({
    buffer,
    adapter: () => genericAdapter,
    candidate: () => candidate,
    salt: () => 'test-salt',
    onFirstFill: () => undefined,
    onSnapshot: (fields) => snapshots.push(fields.length),
  });
  tracker.start();
  return {
    tracker,
    buffer,
    events,
    snapshots,
    types: () => events.map((e) => e.event_type),
    async flush() {
      await buffer.flush();
    },
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  for (const ch of value) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
  }
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function paste(input: HTMLInputElement, value: string): void {
  input.focus();
  input.dispatchEvent(new Event('paste', { bubbles: true }));
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
}

function autofill(input: HTMLInputElement, value: string): void {
  // Browser autofill: value materialises with no keystrokes and no paste.
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
}

function programmatic(input: HTMLInputElement, value: string): void {
  input.value = value;
  // Untrusted event — what a script-driven fill produces.
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

describe('field discovery and canonical mapping', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <label for="fn">First name</label><input id="fn" name="fname" />
        <label for="ln">Last name</label><input id="ln" name="lname" required />
        <label for="em">Email address</label><input id="em" name="email" type="email" />
        <label for="ph">Phone</label><input id="ph" name="telephone" type="tel" />
        <label for="co">Current company</label><input id="co" name="company" />
        <label for="ti">Job title</label><input id="ti" name="jobtitle" />
        <label for="cl">Cover letter</label><textarea id="cl" name="cover_letter"></textarea>
        <label for="cy">Country</label><select id="cy" name="country"><option value=""></option><option value="IN">India</option></select>
      </form>`;
  });

  it('maps controls to canonical fields using labels and autocomplete', () => {
    const h = harness();
    const byId = new Map(h.tracker.snapshot().map((f) => [f.descriptor.id_hint, f.canonical_field]));
    expect(byId.get('fn')).toBe('first_name');
    expect(byId.get('ln')).toBe('last_name');
    expect(byId.get('em')).toBe('email');
    expect(byId.get('ph')).toBe('phone');
    expect(byId.get('co')).toBe('current_company');
    expect(byId.get('ti')).toBe('current_job_title');
    expect(byId.get('cl')).toBe('cover_letter');
    expect(byId.get('cy')).toBe('country');
    h.tracker.stop();
  });

  it('records required vs optional', () => {
    const h = harness();
    const fields = h.tracker.snapshot();
    expect(fields.find((f) => f.descriptor.id_hint === 'ln')!.required).toBe(true);
    expect(fields.find((f) => f.descriptor.id_hint === 'fn')!.required).toBe(false);
    h.tracker.stop();
  });

  it('emits field_discovered with the mapping signals that were used', async () => {
    const h = harness();
    await h.flush();
    const discovered = h.events.filter((e) => e.event_type === 'field_discovered');
    expect(discovered.length).toBe(8);
    const meta = discovered[0]!.metadata as Record<string, unknown>;
    expect(Array.isArray(meta.mapping_signals)).toBe(true);
    expect((meta.mapping_signals as string[]).length).toBeGreaterThan(0);
    h.tracker.stop();
  });

  it('reports unknown rather than guessing on an unidentifiable control', () => {
    document.body.innerHTML = '<input id="mystery" name="xq7" />';
    const h = harness();
    expect(h.tracker.snapshot()[0]!.canonical_field).toBe('unknown');
    h.tracker.stop();
  });
});

describe('input methods', () => {
  beforeEach(() => {
    document.body.innerHTML = '<label for="co">Current company</label><input id="co" name="company" />';
  });

  const field = () => document.getElementById('co') as HTMLInputElement;

  it('detects typing', async () => {
    const h = harness();
    type(field(), 'Example Ltd');
    await settle();
    expect(h.tracker.snapshot()[0]!.input_method).toBe('typed');
    h.tracker.stop();
  });

  it('detects pasting and counts it without reading the clipboard', async () => {
    const h = harness();
    paste(field(), 'Example Ltd');
    await settle();
    const record = h.tracker.snapshot()[0]!;
    expect(record.input_method).toBe('pasted');
    expect(record.interaction.paste_count).toBe(1);
    expect(record.interaction.keystroke_count).toBe(0);
    h.tracker.stop();
  });

  it('detects autofill-shaped population', async () => {
    const h = harness();
    autofill(field(), 'Example Ltd');
    await settle();
    expect(h.tracker.snapshot()[0]!.input_method).toBe('autofilled');
    h.tracker.stop();
  });

  it('emits field_autofill with a note that the pattern has innocent causes', async () => {
    const h = harness();
    autofill(field(), 'Example Ltd');
    await settle();
    await h.flush();
    const event = h.events.find((e) => e.event_type === 'field_autofill');
    expect(event).toBeDefined();
    expect(String((event!.metadata as Record<string, unknown>).note)).toMatch(/password manager|assistive/i);
    h.tracker.stop();
  });

  it('detects untrusted programmatic fills', async () => {
    const h = harness();
    programmatic(field(), 'Example Ltd');
    await settle();
    expect(h.tracker.snapshot()[0]!.input_method).toBe('programmatic');
    h.tracker.stop();
  });

  it('detects silent value changes with no events at all', async () => {
    const h = harness();
    field().value = 'Set By Framework';
    h.tracker.reconcileValues();
    await settle();
    const record = h.tracker.snapshot()[0]!;
    expect(record.input_method).toBe('programmatic');
    expect(record.state).toBe('filled');
    h.tracker.stop();
  });

  it('reports mixed when a value is typed and then pasted over', async () => {
    const h = harness();
    type(field(), 'Ex');
    paste(field(), 'Example Ltd');
    await settle();
    expect(h.tracker.snapshot()[0]!.input_method).toBe('mixed');
    h.tracker.stop();
  });
});

describe('field state and interaction', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <label for="co">Current company</label><input id="co" name="company" />
      <label for="ci">City</label><input id="ci" name="city" />`;
  });

  it('transitions empty -> partial -> filled', async () => {
    const h = harness();
    const input = document.getElementById('co') as HTMLInputElement;
    expect(h.tracker.snapshot()[0]!.state).toBe('empty');
    type(input, 'E');
    await settle();
    expect(h.tracker.snapshot()[0]!.state).toBe('partial');
    type(input, 'Example');
    await settle();
    expect(h.tracker.snapshot()[0]!.state).toBe('filled');
    h.tracker.stop();
  });

  it('counts edits after the first fill', async () => {
    const h = harness();
    const input = document.getElementById('co') as HTMLInputElement;
    type(input, 'Example');
    await settle();
    type(input, 'Example Ltd');
    await settle();
    const record = h.tracker.snapshot()[0]!;
    expect(record.interaction.edit_count).toBe(1);
    expect(record.interaction.fill_sequence_number).toBe(1);
    h.tracker.stop();
  });

  it('records clearing a filled field', async () => {
    const h = harness();
    const input = document.getElementById('co') as HTMLInputElement;
    type(input, 'Example');
    await settle();
    input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    await settle();
    await h.flush();
    const record = h.tracker.snapshot()[0]!;
    expect(record.state).toBe('empty');
    expect(record.interaction.clear_count).toBe(1);
    expect(h.types()).toContain('field_cleared' as EventType);
    h.tracker.stop();
  });

  it('accumulates focus time and focus counts', async () => {
    const h = harness();
    const input = document.getElementById('co') as HTMLInputElement;
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    const record = h.tracker.snapshot()[0]!;
    expect(record.interaction.focus_count).toBe(1);
    expect(record.interaction.time_in_field_ms).toBeGreaterThan(0);
    expect(record.interaction.first_focus_at).not.toBeNull();
    expect(record.interaction.last_blur_at).not.toBeNull();
    h.tracker.stop();
  });

  it('records fill order across fields', async () => {
    const h = harness();
    type(document.getElementById('ci') as HTMLInputElement, 'Pune');
    await settle();
    type(document.getElementById('co') as HTMLInputElement, 'Example Ltd');
    await settle();
    const order = h.tracker.fillOrder().map((f) => f.canonical_field);
    expect(order).toEqual(['city', 'current_company']);
    h.tracker.stop();
  });

  it('marks unfilled fields as skipped only when asked', async () => {
    const h = harness();
    type(document.getElementById('co') as HTMLInputElement, 'Example Ltd');
    await settle();
    expect(h.tracker.snapshot().every((f) => !f.interaction.skipped)).toBe(true);
    const skipped = h.tracker.markSkipped('submit_attempt');
    expect(skipped.map((f) => f.canonical_field)).toEqual(['city']);
    h.tracker.stop();
  });
});

describe('repeated field groups', () => {
  it('keeps an instance index per repeated block', () => {
    document.body.innerHTML = `
      <div data-repeat-index="0" data-group="employer">
        <label for="e0">Employer name</label><input id="e0" name="employer[0].name" />
      </div>
      <div data-repeat-index="1" data-group="employer">
        <label for="e1">Employer name</label><input id="e1" name="employer[1].name" />
      </div>
      <div data-repeat-index="2" data-group="employer">
        <label for="e2">Employer name</label><input id="e2" name="employer[2].name" />
      </div>`;
    const h = harness();
    const records = h.tracker.snapshot();
    expect(records.map((r) => r.instance_index)).toEqual([0, 1, 2]);
    expect(records.every((r) => r.group_key === 'employer')).toBe(true);
    h.tracker.stop();
  });

  it('assigns sequential indices when the DOM offers no explicit index', () => {
    document.body.innerHTML = `
      <label>Employer name<input name="employer_name_a" /></label>
      <label>Employer name<input name="employer_name_b" /></label>`;
    const h = harness();
    const records = h.tracker.snapshot();
    expect(records.map((r) => r.instance_index)).toEqual([0, 1]);
    h.tracker.stop();
  });
});

describe('dynamic fields', () => {
  it('registers controls added after the initial scan', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const h = harness();
    expect(h.tracker.snapshot()).toHaveLength(0);

    const host = document.getElementById('host')!;
    host.innerHTML = '<label for="late">Email address</label><input id="late" name="email" />';
    h.tracker.scan(host);

    const records = h.tracker.snapshot();
    expect(records).toHaveLength(1);
    expect(records[0]!.canonical_field).toBe('email');
    h.tracker.stop();
  });

  it('registers a control lazily when an event arrives before the scan', async () => {
    document.body.innerHTML = '<label for="x">City</label><input id="x" />';
    const h = harness();
    h.tracker.stop();

    // Simulate a control that appeared between scans.
    document.body.innerHTML += '<label for="y">Country</label><input id="y" />';
    const fresh = harness();
    const input = document.getElementById('y') as HTMLInputElement;
    type(input, 'India');
    await settle();
    expect(fresh.tracker.snapshot().some((f) => f.canonical_field === 'country')).toBe(true);
    fresh.tracker.stop();
  });

  it('marks controls detached from the DOM', async () => {
    document.body.innerHTML = '<label for="co">Current company</label><input id="co" />';
    const h = harness();
    document.body.innerHTML = '';
    h.tracker.reconcileDetached();
    await h.flush();
    expect(h.tracker.snapshot()[0]!.detached_at).not.toBeNull();
    expect(h.types()).toContain('field_detached' as EventType);
    h.tracker.stop();
  });
});

describe('candidate matching', () => {
  const candidate: CandidateRecord = {
    candidate_id: 'c1',
    fields: {
      current_company: 'Example Ltd',
      email: 'jane.doe@example.com',
      phone: '+91 98765 43210',
      city: 'Pune',
    },
    fetched_at: new Date().toISOString(),
  };

  it('reports match for a value equal to the candidate record', async () => {
    document.body.innerHTML = '<label for="co">Current company</label><input id="co" name="company" />';
    const h = harness(candidate);
    type(document.getElementById('co') as HTMLInputElement, 'Example Ltd');
    await settle();
    const record = h.tracker.snapshot()[0]!;
    expect(record.match_result).toBe('match');
    expect(record.value).toBe('Example Ltd');
    h.tracker.stop();
  });

  it('reports mismatch and stores no plaintext for a sensitive field', async () => {
    document.body.innerHTML = '<label for="em">Email address</label><input id="em" type="email" />';
    const h = harness(candidate);
    type(document.getElementById('em') as HTMLInputElement, 'someone.else@example.com');
    await settle();
    const record = h.tracker.snapshot()[0]!;
    expect(record.match_result).toBe('mismatch');
    expect(record.value).toBeNull();
    expect(record.value_hash).toMatch(/^(sha256|fnv):/);
    h.tracker.stop();
  });

  it('normalizes formatting differences instead of reporting a mismatch', async () => {
    document.body.innerHTML = '<label for="ph">Phone</label><input id="ph" type="tel" />';
    const h = harness(candidate);
    type(document.getElementById('ph') as HTMLInputElement, '+919876543210');
    await settle();
    expect(h.tracker.snapshot()[0]!.match_result).toBe('match');
    h.tracker.stop();
  });

  it('reports not_available when the record lacks the field', async () => {
    document.body.innerHTML = '<label for="li">LinkedIn</label><input id="li" />';
    const h = harness(candidate);
    type(document.getElementById('li') as HTMLInputElement, 'linkedin.com/in/jane');
    await settle();
    expect(h.tracker.snapshot()[0]!.match_result).toBe('not_available');
    h.tracker.stop();
  });

  it('reports not_available when no candidate record was supplied at all', async () => {
    document.body.innerHTML = '<label for="co">Current company</label><input id="co" />';
    const h = harness(null);
    type(document.getElementById('co') as HTMLInputElement, 'Example Ltd');
    await settle();
    expect(h.tracker.snapshot()[0]!.match_result).toBe('not_available');
    h.tracker.stop();
  });
});

describe('deriveState', () => {
  it('treats choice controls as binary', () => {
    expect(deriveState('IN', 'select')).toBe('filled');
    expect(deriveState('', 'select')).toBe('empty');
    expect(deriveState('on', 'checkbox')).toBe('filled');
  });

  it('treats a single character in a text field as partial', () => {
    expect(deriveState('a', 'input')).toBe('partial');
    expect(deriveState('ab', 'input')).toBe('filled');
    expect(deriveState('   ', 'input')).toBe('empty');
  });
});
