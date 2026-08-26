import { describe, expect, it } from 'vitest';
import confirmedFixture from './fixtures/session-payload.confirmed.json' with { type: 'json' };
import { SessionPayloadSchema, type FieldRecord, type SessionPayload } from '../src/contract/schemas.js';
import { buildSessionDigest } from '../src/ai/digest.js';
import { verifyPayload } from '../src/services/integrity.js';
import { sanitizeSessionPayload } from '../src/services/sanitize.js';

const base = SessionPayloadSchema.parse(confirmedFixture);

function withField(payload: SessionPayload, overrides: Partial<FieldRecord>): SessionPayload {
  const template = payload.fields[0];
  if (!template) throw new Error('fixture has no fields');
  return { ...payload, fields: [{ ...template, ...overrides }] };
}

/**
 * These assert the hard guarantees in DESIGN §8 at the *storage* boundary. The extension
 * enforces them before data leaves the page; this service enforces them again, because a
 * client bug must not be able to write a credential into this database.
 */
describe('ingest-boundary privacy enforcement', () => {
  it('strips a value that arrived for a never_store field', () => {
    const payload = withField(base, {
      canonical_field: 'password',
      sensitivity: 'never_store',
      value: 'hunter2',
      value_hash: 'sha256:deadbeef',
    });

    const { payload: clean, stripped } = sanitizeSessionPayload(payload);
    expect(clean.fields[0]!.value).toBeNull();
    expect(clean.fields[0]!.value_hash).toBeNull();
    expect(clean.fields[0]!.value_redacted).toBe(true);
    expect(stripped).toContain('field.password.value');
  });

  it('strips plaintext that arrived for a hashed_only field', () => {
    const payload = withField(base, {
      canonical_field: 'email',
      sensitivity: 'hashed_only',
      value: 'jane@example.com',
      value_hash: 'sha256:abc',
    });

    const { payload: clean } = sanitizeSessionPayload(payload);
    expect(clean.fields[0]!.value).toBeNull();
    expect(clean.fields[0]!.value_hash).toBe('sha256:abc');
  });

  it('strips content captured from a password-type control regardless of canonical name', () => {
    const template = base.fields[0]!;
    const payload = withField(base, {
      canonical_field: 'unknown',
      sensitivity: 'storable',
      descriptor: { ...template.descriptor, input_type: 'password' },
      value: 'secret',
    });

    expect(sanitizeSessionPayload(payload).payload.fields[0]!.value).toBeNull();
  });

  it('redacts a plaintext candidate email and drops the session hash salt', () => {
    const payload: SessionPayload = {
      ...base,
      session: { ...base.session, candidate_email: 'jane@example.com', hash_salt: 's3cr3t-salt' },
    };

    const { payload: clean, stripped } = sanitizeSessionPayload(payload);
    expect(clean.session.candidate_email).toBe('[REDACTED]');
    expect(clean.session.hash_salt).toBeUndefined();
    expect(stripped).toEqual(expect.arrayContaining(['session.hash_salt', 'session.candidate_email']));
  });

  it('leaves a compliant payload untouched', () => {
    const { payload: clean, stripped } = sanitizeSessionPayload(base);
    expect(stripped).toEqual([]);
    expect(clean.fields).toEqual(base.fields);
  });

  it('records a privacy violation as a critical issue even though the value is stripped', () => {
    const payload = withField(base, {
      canonical_field: 'ssn',
      sensitivity: 'never_store',
      value: '123-45-6789',
    });

    const issues = verifyPayload(payload).issues;
    expect(issues.some((i) => i.code === 'privacy.never_store_value_present' && i.severity === 'critical')).toBe(true);
  });
});

describe('AI digest boundary', () => {
  const doc = {
    ...base.session,
    submission: base.submission,
    fields: base.fields,
    pages: base.pages,
    fill_order: base.fill_order,
    verification: {},
    stats: {},
    candidate_id: 'cand-90312',
    candidate_email_hash: 'sha256:6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b',
  };

  it('still never carries hashes, DOM paths or raw candidate identifiers to the model', () => {
    const serialized = JSON.stringify(buildSessionDigest(doc as Record<string, any>));

    expect(serialized).not.toContain('sha256:');
    expect(serialized).not.toContain('cand-90312');
    for (const field of base.fields) {
      if (field.descriptor.dom_path) expect(serialized).not.toContain(field.descriptor.dom_path);
    }
  });

  it('keeps a hashed_only/never_store field value null in the digest even though the boundary was widened', () => {
    const digest = buildSessionDigest(doc as Record<string, any>) as any;
    const email = digest.fields.detail.find((f: any) => f.canonical_field === 'email');
    const password = digest.fields.detail.find((f: any) => f.canonical_field === 'password');

    expect(email?.value ?? null).toBeNull();
    expect(password?.value ?? null).toBeNull();
  });

  it('now includes the real navigation flow and storable field values, since those are already safe/available server-side', () => {
    const digest = buildSessionDigest(doc as Record<string, any>) as any;
    const serialized = JSON.stringify(digest);

    // Real domains/URLs/titles are now expected — needed to judge portal legitimacy.
    expect(serialized).toContain('https://');
    expect(digest.pages.flow[0].domain).toBe(base.pages[0]!.domain);
    expect(digest.pages.flow[0].sanitized_url).toBe(base.pages[0]!.sanitized_url);
    expect(digest.pages.flow[0].title).toBe(base.pages[0]!.title);

    // `current_company` is `storable` sensitivity with a real value in the fixture —
    // that value is now expected to cross the boundary.
    const currentCompany = digest.fields.detail.find((f: any) => f.canonical_field === 'current_company');
    expect(currentCompany?.value).toBe('Example Ltd');
  });

  it('omits untouched, non-required fields from the per-field detail — the aggregate counts already cover them', () => {
    // Real case: a 262-field MUI form had 177 fields the candidate never touched (mostly
    // decorative internals), each one sent to the model individually for no analytical
    // gain beyond what `fields.by_state`/`fields.required_empty` already say.
    const untouched = withField(base, {
      canonical_field: 'unknown',
      required: false,
      state: 'empty',
      interaction: {
        ...base.fields[0]!.interaction,
        focus_count: 0,
        keystroke_count: 0,
        paste_count: 0,
        edit_count: 0,
      },
    }).fields[0]!;

    const requiredButEmpty = { ...untouched, canonical_field: 'resume', required: true };
    const touchedButEmpty = {
      ...untouched,
      canonical_field: 'linkedin_url',
      interaction: { ...untouched.interaction, focus_count: 1 },
    };

    const doc = {
      ...base.session,
      submission: base.submission,
      fields: [untouched, requiredButEmpty, touchedButEmpty],
      pages: base.pages,
      fill_order: base.fill_order,
      verification: {},
      stats: {},
    };

    const digest = buildSessionDigest(doc as Record<string, any>) as any;
    const sentFields = digest.fields.detail.map((f: any) => f.canonical_field);

    expect(sentFields).not.toContain('unknown');
    expect(sentFields).toContain('resume');
    expect(sentFields).toContain('linkedin_url');
    // The aggregate still accounts for every field, touched or not.
    expect(digest.fields.total).toBe(3);
  });
});
