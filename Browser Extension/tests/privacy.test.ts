import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, setConfig } from '@/common/config';
import { EventBuffer } from '@/collector/content/event-buffer';
import { FieldTracker } from '@/collector/content/field-tracker';
import { readValue } from '@/collector/content/dom-utils';
import type { ActivityEvent } from '@/models/event';
import {
  classifySensitivity,
  isSensitiveName,
  looksLikeSecretValue,
  redactInlineSecrets,
  sanitizeUrl,
  scrubObject,
} from '@/collector/utils/redaction';
import { genericAdapter } from '@/collector/adapters/generic-adapter';
import { settle } from './setup';

/**
 * These tests encode the privacy guarantees from the design as executable assertions.
 * A regression here is a privacy incident, not a test failure.
 */

describe('URL sanitization', () => {
  it('redacts tokens while preserving benign identifiers', () => {
    const out = sanitizeUrl('https://example.com/apply?id=123&token=SECRETVALUE123');
    expect(out).toContain('id=123');
    expect(out).toContain('token=%5BREDACTED%5D');
    expect(out).not.toContain('SECRETVALUE123');
  });

  it('redacts every configured sensitive parameter', () => {
    const params = getConfig().privacy.redacted_query_params;
    for (const param of params) {
      const url = sanitizeUrl(`https://example.com/x?${param}=sensitive-value-here`);
      expect(url, `param ${param} leaked`).not.toContain('sensitive-value-here');
    }
  });

  it('drops fragments entirely', () => {
    expect(sanitizeUrl('https://example.com/apply#access_token=abc123')).toBe('https://example.com/apply');
  });

  it('strips credentials embedded in the authority', () => {
    const out = sanitizeUrl('https://user:hunter2@example.com/apply');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('user:');
  });

  it('redacts opaque credential-shaped path segments but keeps readable ones', () => {
    const out = sanitizeUrl('https://example.com/apply/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/step-2');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('step-2');
  });

  it('never throws on malformed input', () => {
    expect(() => sanitizeUrl('not a url')).not.toThrow();
    expect(sanitizeUrl('javascript:alert(1)')).toContain('[REDACTED]');
  });
});

describe('sensitive value and name detection', () => {
  it('flags credential-shaped field names', () => {
    for (const name of ['password', 'user_password', 'otp', 'cvv', 'cardNumber', 'ssn', 'api_key', 'access-token']) {
      expect(isSensitiveName(name), name).toBe(true);
    }
    expect(isSensitiveName('current_company')).toBe(false);
    expect(isSensitiveName('first name')).toBe(false);
  });

  it('flags token-shaped values', () => {
    expect(looksLikeSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc')).toBe(true);
    expect(looksLikeSecretValue('4111111111111111')).toBe(true);
    expect(looksLikeSecretValue('sk-livekeyabcdefghijklmnop')).toBe(true);
    expect(looksLikeSecretValue('Example Ltd')).toBe(false);
  });

  it('classifies fields into the three storage tiers', () => {
    expect(classifySensitivity('password')).toBe('never_store');
    expect(classifySensitivity('current_company')).toBe('storable');
    expect(classifySensitivity('email')).toBe('hashed_only');
    expect(classifySensitivity('unknown')).toBe('hashed_only');
    expect(classifySensitivity('current_company', { inputType: 'password' })).toBe('never_store');
    expect(classifySensitivity('current_company', { nameHints: ['card_number'] })).toBe('never_store');
  });

  it('honours a deployment that hashes everything', () => {
    setConfig({ privacy: { ...getConfig().privacy, hash_all_values: true } });
    expect(classifySensitivity('current_company')).toBe('hashed_only');
  });
});

describe('password handling', () => {
  it('readValue never returns a password value', () => {
    document.body.innerHTML = '<input type="password" id="p" />';
    const input = document.getElementById('p') as HTMLInputElement;
    input.value = 'hunter2';
    expect(readValue(input)).toBeNull();
  });

  it('records only metadata for a password field, never its value or hash', async () => {
    document.body.innerHTML = `
      <form>
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" />
      </form>`;
    const events: ActivityEvent[] = [];
    const buffer = new EventBuffer(
      () => 'session-1',
      () => ({ domain: 'x', path: '/', sanitized_url: '', title: '', frame: 'top' }),
      (batch) => {
        events.push(...batch);
      },
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

    const input = document.getElementById('pw') as HTMLInputElement;
    input.value = 'hunter2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    await buffer.flush();

    const record = tracker.snapshot().find((f) => f.descriptor.input_type === 'password');
    expect(record).toBeDefined();
    expect(record!.sensitivity).toBe('never_store');
    expect(record!.value).toBeNull();
    expect(record!.value_hash).toBeNull();
    expect(record!.value_redacted).toBe(true);

    const serialized = JSON.stringify({ record, events });
    expect(serialized).not.toContain('hunter2');
    tracker.stop();
  });
});

describe('keystrokes', () => {
  it('stores a count and never the keys themselves', async () => {
    document.body.innerHTML = '<label for="c">Current company</label><input id="c" name="company" />';
    const events: ActivityEvent[] = [];
    const buffer = new EventBuffer(
      () => 's',
      () => ({ domain: 'x', path: '/', sanitized_url: '', title: '', frame: 'top' }),
      (batch) => {
        events.push(...batch);
      },
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

    const input = document.getElementById('c') as HTMLInputElement;
    input.focus();
    for (const key of ['A', 'c', 'm', 'e']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    input.value = 'Acme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    await buffer.flush();

    const record = tracker.snapshot()[0]!;
    expect(record.interaction.keystroke_count).toBe(4);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/"keys"/);
    expect(serialized).not.toMatch(/"key"\s*:/);
    tracker.stop();
  });
});

describe('outbound payload scrubbing', () => {
  it('redacts secret-named keys and token-shaped values at any depth', () => {
    const scrubbed = scrubObject({
      safe: 'Example Ltd',
      access_token: 'abc',
      nested: { api_key: 'xyz', list: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'] },
    });
    expect(scrubbed.safe).toBe('Example Ltd');
    expect(scrubbed.access_token).toBe('[REDACTED]');
    expect(scrubbed.nested.api_key).toBe('[REDACTED]');
    expect(scrubbed.nested.list[0]).toBe('[REDACTED]');
  });

  it('preserves hash fields, which are the whole point of hashing', () => {
    const scrubbed = scrubObject({ value_hash: 'sha256:deadbeef', candidate_email_hash: 'sha256:cafe' });
    expect(scrubbed.value_hash).toBe('sha256:deadbeef');
    expect(scrubbed.candidate_email_hash).toBe('sha256:cafe');
  });

  it('redacts contact details out of free text excerpts', () => {
    const out = redactInlineSecrets('Contact jane.doe@example.com or +1 415 555 0100');
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).not.toContain('555');
  });
});

describe('no ambient collection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never reads cookies or storage', async () => {
    // Guard against a component reaching for the browser's ambient credentials.
    const cookieSpy = vi.spyOn(document, 'cookie', 'get');
    document.body.innerHTML = '<label for="c">City</label><input id="c" />';
    const buffer = new EventBuffer(
      () => 's',
      () => ({ domain: 'x', path: '/', sanitized_url: '', title: '', frame: 'top' }),
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
    const input = document.getElementById('c') as HTMLInputElement;
    input.value = 'Pune';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(cookieSpy).not.toHaveBeenCalled();
    tracker.stop();
  });
});
