import { describe, expect, it } from 'vitest';
import confirmedFixture from './fixtures/session-payload.confirmed.json' with { type: 'json' };
import { SessionPayloadSchema } from '../src/contract/schemas.js';
import { computePortalDomains } from '../src/services/ingest.service.js';

const confirmed = SessionPayloadSchema.parse(confirmedFixture);

describe('computePortalDomains', () => {
  it('reports every top-level domain in visiting order', () => {
    expect(computePortalDomains(confirmed.pages)).toEqual(['jobs.example-portal.com']);
  });

  it('ignores iframe pages entirely — a real flagged session showed ad/tracking domains leaking in otherwise', () => {
    const iframePage: (typeof confirmed.pages)[number] = {
      ...confirmed.pages[0]!,
      page_id: 'pg_iframe1',
      domain: '14155760.fls.doubleclick.net',
      sanitized_url: 'https://14155760.fls.doubleclick.net/pixel',
      path: '/pixel',
      frame: 'iframe' as const,
      entry_point: 'iframe' as const,
      sequence: 1,
    };
    const pages = [...confirmed.pages, iframePage];
    expect(computePortalDomains(pages)).toEqual(['jobs.example-portal.com']);
  });

  it('includes a genuine top-level redirect to a different domain, in order', () => {
    const handoff: (typeof confirmed.pages)[number] = {
      ...confirmed.pages[0]!,
      page_id: 'pg_handoff',
      domain: 'careers.acme-employer.com',
      sanitized_url: 'https://careers.acme-employer.com/apply/8891',
      path: '/apply/8891',
      frame: 'top' as const,
      entry_point: 'full_navigation' as const,
      sequence: 99,
    };
    const pages = [...confirmed.pages, handoff];
    expect(computePortalDomains(pages)).toEqual(['jobs.example-portal.com', 'careers.acme-employer.com']);
  });
});
