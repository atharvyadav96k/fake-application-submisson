import { describe, expect, it } from 'vitest';
import { AdapterManager, adapterManager } from '@/collector/adapters/adapter-manager';
import { genericAdapter } from '@/collector/adapters/generic-adapter';
import { examplePortalAdapter } from '@/collector/adapters/portals/example-portal';
import { indeedAdapter } from '@/collector/adapters/portals/indeed-adapter';
import { naukriAdapter } from '@/collector/adapters/portals/naukri-adapter';
import type { AdapterContext, PortalAdapter } from '@/collector/adapters/types';

/** Clones an adapter instance, preserving its prototype methods. */
function derive(base: PortalAdapter, name: string, priority: number): PortalAdapter {
  const clone = Object.create(Object.getPrototypeOf(base)) as PortalAdapter;
  Object.assign(clone, base, { name, priority });
  return clone;
}

function ctx(url: string, html = ''): AdapterContext {
  document.body.innerHTML = html;
  return { url: new URL(url), document, isFrame: false };
}

describe('adapter selection', () => {
  it('selects a known adapter for a matching host', () => {
    const adapter = adapterManager.select(new URL('https://jobs.example-portal.com/apply/123'));
    expect(adapter.name).toBe('example-portal');
    expect(adapter.kind).toBe('known');
  });

  it('falls back to the generic adapter for unknown portals', () => {
    const adapter = adapterManager.select(new URL('https://careers.some-other-company.com/apply'));
    expect(adapter.name).toBe('generic');
    expect(adapter.kind).toBe('generic');
  });

  it('prefers the highest-priority matching adapter', () => {
    const manager = new AdapterManager([genericAdapter]);
    const low = derive(examplePortalAdapter, 'low', 1);
    const high = derive(examplePortalAdapter, 'high', 50);
    manager.register(low);
    manager.register(high);
    expect(manager.select(new URL('https://jobs.example-portal.com/apply')).name).toBe('high');
  });

  it('survives an adapter that throws and falls back to generic', () => {
    const manager = new AdapterManager([genericAdapter]);
    const broken: PortalAdapter = {
      name: 'broken',
      kind: 'known',
      priority: 10,
      matches: () => true,
      identifyPage: () => {
        throw new Error('boom');
      },
      getCandidateFields: () => [],
      mapField: () => null,
      detectSubmission: () => null,
      detectConfirmation: () => null,
    };
    manager.register(broken);
    const selected = manager.select(new URL('https://anything.example.com/apply'));
    expect(selected.name).toBe('broken');
    const page = manager.safeCall(selected, 'identifyPage', (a) => a.identifyPage(ctx('https://anything.example.com/apply')), 'unknown');
    // The generic fallback ran instead of the throw propagating.
    expect(page).toBeTypeOf('string');
  });

  it('ignores an adapter whose matches() throws', () => {
    const manager = new AdapterManager([genericAdapter]);
    const explosive = derive(examplePortalAdapter, 'explosive', 99);
    explosive.matches = () => {
      throw new Error('boom');
    };
    manager.register(explosive);
    manager.register(derive(examplePortalAdapter, 'example-portal', 100));
    expect(manager.select(new URL('https://jobs.example-portal.com/apply')).name).toBe('example-portal' as string);
  });
});

describe('generic page identification', () => {
  it('identifies an application form', () => {
    const page = genericAdapter.identifyPage(
      ctx(
        'https://careers.example.com/apply/456',
        '<form><input name="a"/><input name="b"/><input name="c"/><input name="d"/></form>',
      ),
    );
    expect(page).toBe('application_form');
  });

  it('identifies a multi-step application', () => {
    const page = genericAdapter.identifyPage(
      ctx(
        'https://careers.example.com/apply/456',
        '<div class="stepper"></div><form><input name="a"/><input name="b"/><input name="c"/></form>',
      ),
    );
    expect(page).toBe('application_step');
  });

  it('identifies a confirmation page from its content', () => {
    const page = genericAdapter.identifyPage(
      ctx('https://careers.example.com/done', '<h1>Thank you for applying</h1>'),
    );
    expect(page).toBe('confirmation');
  });

  it('identifies login and candidate-record pages', () => {
    expect(genericAdapter.identifyPage(ctx('https://careers.example.com/login'))).toBe('login');
    expect(genericAdapter.identifyPage(ctx('https://ats.example.com/candidates/99/profile'))).toBe('candidate_record');
  });

  it('identifies a confirmation page from its title alone, even with no matching on-page element', () => {
    // Real case: Indeed's post-apply page has this exact title but a custom-component
    // body the generic heading/toast selectors never match.
    document.title = 'Your application has been submitted | Indeed';
    const page = genericAdapter.identifyPage(ctx('https://in.indeed.com/beta/indeedapply/form/post-apply', '<div>ok</div>'));
    expect(page).toBe('confirmation');
    document.title = '';
  });

  it('recognises "Apply Confirmation" as a title alone — a real Naukri session used exactly this wording', () => {
    document.title = 'Apply Confirmation';
    const page = genericAdapter.identifyPage(ctx('https://www.naukri.com/myapply/saveApply', '<div>ok</div>'));
    expect(page).toBe('confirmation');
    document.title = '';
  });
});

describe('generic field mapping', () => {
  const map = (html: string) => {
    document.body.innerHTML = html;
    const el = document.querySelector('input,textarea,select') as HTMLElement;
    return genericAdapter.mapField(el);
  };

  it('maps from the autocomplete attribute with high confidence', () => {
    const mapping = map('<input autocomplete="family-name" name="x1" />');
    expect(mapping!.canonical_field).toBe('last_name');
    expect(mapping!.signals).toContain('autocomplete');
    expect(mapping!.confidence).toBeGreaterThan(0.6);
  });

  it('maps from a wrapping label', () => {
    const mapping = map('<label>Current company<input name="q7" /></label>');
    expect(mapping!.canonical_field).toBe('current_company');
    expect(mapping!.signals).toContain('label');
  });

  it('maps from an aria-label when no label element exists', () => {
    const mapping = map('<input aria-label="Phone number" name="q8" />');
    expect(mapping!.canonical_field).toBe('phone');
  });

  it('maps from a placeholder as a weaker signal', () => {
    const mapping = map('<input placeholder="LinkedIn profile URL" name="q9" />');
    expect(mapping!.canonical_field).toBe('linkedin_url');
  });

  it('maps from a data-testid attribute', () => {
    const mapping = map('<input data-testid="cover-letter-input" name="q10" />');
    expect(mapping!.canonical_field).toBe('cover_letter');
  });

  it('uses negative phrases to disambiguate similar labels', () => {
    // 'Company website' vetoes both `current_company` and `website`: the honest answer
    // is that neither rule applies, not a coin flip between them.
    const ambiguous = map('<label>Company website<input name="w" /></label>');
    expect(ambiguous === null || ambiguous.canonical_field === 'unknown').toBe(true);
    expect(map('<label>First name<input name="n" /></label>')!.canonical_field).toBe('first_name');
  });

  it('returns unknown rather than a low-confidence guess', () => {
    const mapping = map('<input name="q_11_b" />');
    expect(mapping === null || mapping.canonical_field === 'unknown').toBe(true);
  });

  it('does not let input type alone decide the mapping', () => {
    // `type="url"` hints at `website`, but the label is decisive.
    const mapping = map('<label>GitHub<input type="url" name="g" /></label>');
    expect(mapping!.canonical_field).toBe('github_url');
  });
});

describe('example portal adapter', () => {
  it('maps portal-specific data-field attributes authoritatively', () => {
    document.body.innerHTML = '<input data-field="employer_current" name="whatever" />';
    const el = document.querySelector('input') as HTMLElement;
    const mapping = examplePortalAdapter.mapField(el, ctx('https://jobs.example-portal.com/apply/1'));
    expect(mapping!.canonical_field).toBe('current_company');
    expect(mapping!.signals).toEqual(['adapter']);
    expect(mapping!.confidence).toBeGreaterThan(0.9);
  });

  it('defers to the generic heuristics for unmapped controls', () => {
    document.body.innerHTML = '<label>City<input name="city" /></label>';
    const el = document.querySelector('input') as HTMLElement;
    const mapping = examplePortalAdapter.mapField(el, ctx('https://jobs.example-portal.com/apply/1'));
    expect(mapping!.canonical_field).toBe('city');
  });

  it('identifies portal routes', () => {
    const c = (path: string) => ctx(`https://jobs.example-portal.com${path}`);
    expect(examplePortalAdapter.identifyPage(c('/apply/1/confirmation'))).toBe('confirmation');
    expect(examplePortalAdapter.identifyPage(c('/apply/1/step-2'))).toBe('application_step');
    expect(examplePortalAdapter.identifyPage(c('/apply/1'))).toBe('application_form');
    expect(examplePortalAdapter.identifyPage(c('/candidates/7'))).toBe('candidate_record');
  });

  it('classifies portal network endpoints', () => {
    const submit = examplePortalAdapter.classifyNetwork({
      method: 'POST',
      url: 'https://jobs.example-portal.com/api/v1/applications',
      status: 201,
      transport: 'fetch',
    });
    expect(submit).toBe(true);

    const autosave = examplePortalAdapter.classifyNetwork({
      method: 'POST',
      url: 'https://jobs.example-portal.com/api/v1/autosave',
      status: 200,
      transport: 'fetch',
    });
    expect(autosave).toBe(false);

    const unrelated = examplePortalAdapter.classifyNetwork({
      method: 'POST',
      url: 'https://cdn.other.com/x',
      status: 200,
      transport: 'fetch',
    });
    expect(unrelated).toBeNull();
  });

  it('reports expected fields so skipped fields are meaningful', () => {
    const fields = examplePortalAdapter.getCandidateFields(ctx('https://jobs.example-portal.com/apply/1'));
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.some((f) => f.canonical_field === 'resume' && f.required)).toBe(true);
  });
});

describe('indeed adapter', () => {
  it('matches indeed.com and its subdomains', () => {
    expect(indeedAdapter.matches(new URL('https://in.indeed.com/beta/indeedapply/form/post-apply'))).toBe(true);
    expect(indeedAdapter.matches(new URL('https://www.indeed.com/jobs'))).toBe(true);
    expect(indeedAdapter.matches(new URL('https://careers.example.com/apply'))).toBe(false);
  });

  it('identifies the real observed route sequence for a completed application', () => {
    const c = (path: string) => ctx(`https://in.indeed.com${path}`);
    expect(indeedAdapter.identifyPage(c('/beta/indeedapply/form/review-module'))).toBe('application_step');
    expect(indeedAdapter.identifyPage(c('/beta/indeedapply/form/post-apply'))).toBe('confirmation');
  });

  it('confirms via the known post-apply route regardless of page title', () => {
    document.title = '';
    const confirmation = indeedAdapter.detectConfirmation(ctx('https://in.indeed.com/beta/indeedapply/form/post-apply'));
    expect(confirmation?.kind).toBe('adapter_confirmation');
  });

  it('falls back to the generic detector (including its title check) off the known route', () => {
    document.title = 'Your application has been submitted | Indeed';
    const confirmation = indeedAdapter.detectConfirmation(ctx('https://in.indeed.com/some/other/path'));
    expect(confirmation?.kind).toBe('confirmation_text');
    document.title = '';
  });

  it('never claims to classify its own GraphQL endpoint — defers to click correlation', () => {
    const verdict = indeedAdapter.classifyNetwork(
      { method: 'POST', url: 'https://apis.indeed.com/graphql', status: 200, transport: 'fetch' },
      ctx('https://in.indeed.com/beta/indeedapply/form/review-module'),
    );
    expect(verdict).toBeNull();
  });
});

describe('naukri adapter', () => {
  it('matches naukri.com and its subdomains', () => {
    expect(naukriAdapter.matches(new URL('https://www.naukri.com/job-listings-123'))).toBe(true);
    expect(naukriAdapter.matches(new URL('https://m.naukri.com/mnjuser/profile'))).toBe(true);
    expect(naukriAdapter.matches(new URL('https://careers.example.com/apply'))).toBe(false);
  });

  it('identifies the job listing, candidate profile, and apply-confirmation routes', () => {
    const c = (path: string) => ctx(`https://www.naukri.com${path}`);
    expect(naukriAdapter.identifyPage(c('/job-listings-software-engineer-acme-1'))).toBe('job_listing');
    expect(naukriAdapter.identifyPage(c('/mnjuser/profile'))).toBe('candidate_record');
    expect(naukriAdapter.identifyPage(c('/myapply/saveApply'))).toBe('confirmation');
  });

  it('confirms via the known apply-confirmation route regardless of page title — the real observed case', () => {
    // A real direct-apply session landed here titled exactly "Apply Confirmation" and
    // scored 0.84 without ever being marked confirmed, because neither this route nor
    // that title was recognised anywhere yet.
    document.title = '';
    const confirmation = naukriAdapter.detectConfirmation(ctx('https://www.naukri.com/myapply/saveApply'));
    expect(confirmation?.kind).toBe('adapter_confirmation');
  });

  it('falls back to the generic detector (including its title check) off the known route', () => {
    document.title = 'Your application has been submitted | Naukri.com';
    const confirmation = naukriAdapter.detectConfirmation(ctx('https://www.naukri.com/job-listings-software-engineer-acme-1'));
    expect(confirmation?.kind).toBe('confirmation_text');
    document.title = '';
  });

  it('defers network classification on its own host to the generic heuristics', () => {
    const meta = { method: 'POST', url: 'https://www.naukri.com/api/mutate', status: 200, transport: 'fetch' as const };
    const verdict = naukriAdapter.classifyNetwork(meta, ctx('https://www.naukri.com/job-listings-software-engineer-acme-1'));
    expect(verdict).toBe(genericAdapter.classifyNetwork(meta));
  });

  it('does not claim requests to other hosts', () => {
    const verdict = naukriAdapter.classifyNetwork(
      { method: 'POST', url: 'https://careers.acme.com/api/apply', status: 200, transport: 'fetch' },
      ctx('https://www.naukri.com/job-listings-software-engineer-acme-1'),
    );
    expect(verdict).toBeNull();
  });
});
