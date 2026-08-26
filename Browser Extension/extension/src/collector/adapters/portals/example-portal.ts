import type { SubmissionSignal } from '@/models/submission';
import { controlText } from '../../content/dom-utils';
import { sanitizeText } from '../../utils/redaction';
import { monotonicMs, nowIso } from '@/utils/timestamps';
import type {
  AdapterContext,
  CanonicalMapping,
  ConfirmationSignal,
  FieldDefinition,
  NetworkMetaForAdapter,
  PageType,
  PortalAdapter,
} from '../types';
import { genericAdapter } from '../generic-adapter';

/**
 * Reference implementation of a *known* portal adapter.
 *
 * Copy this file to add a portal: implement `matches`, the selectors your portal uses,
 * and its confirmation rule. Anything you don't implement falls through to the generic
 * heuristics, so an adapter only needs to encode what the heuristics get wrong.
 */

const HOSTS = ['jobs.example-portal.com', 'careers.example-portal.com'];

/** Portal-specific `data-field` values -> canonical fields. */
const FIELD_MAP: Record<string, CanonicalMapping['canonical_field']> = {
  applicant_first: 'first_name',
  applicant_last: 'last_name',
  applicant_email: 'email',
  applicant_phone: 'phone',
  employer_current: 'current_company',
  role_current: 'current_job_title',
  yrs_exp: 'experience_years',
  linkedin: 'linkedin_url',
  cv_upload: 'resume',
  motivation: 'cover_letter',
  notice: 'notice_period',
};

export class ExamplePortalAdapter implements PortalAdapter {
  readonly name = 'example-portal';
  readonly kind = 'known' as const;
  readonly priority = 100;

  matches(url: URL): boolean {
    return HOSTS.includes(url.hostname);
  }

  identifyPage(ctx: AdapterContext): PageType {
    const path = ctx.url.pathname;
    if (/^\/apply\/[^/]+\/confirmation/.test(path)) return 'confirmation';
    if (/^\/apply\/[^/]+\/step-\d+/.test(path)) return 'application_step';
    if (/^\/apply\//.test(path)) return 'application_form';
    if (/^\/candidates?\//.test(path)) return 'candidate_record';
    if (/^\/jobs?\//.test(path)) return 'job_listing';
    return genericAdapter.identifyPage(ctx);
  }

  getCandidateFields(ctx: AdapterContext): FieldDefinition[] {
    const page = this.identifyPage(ctx);
    if (page !== 'application_form' && page !== 'application_step') return [];
    return Object.entries(FIELD_MAP).map(([key, canonical_field]) => ({
      canonical_field,
      selector: `[data-field="${key}"]`,
      required: ['applicant_first', 'applicant_last', 'applicant_email', 'cv_upload'].includes(key),
      group_key: key.startsWith('employer_') ? 'employer' : null,
    }));
  }

  mapField(element: HTMLElement, ctx: AdapterContext): CanonicalMapping | null {
    const key = element.getAttribute('data-field');
    const mapped = key ? FIELD_MAP[key] : undefined;
    if (mapped) {
      const row = element.closest('[data-repeat-index]');
      const idx = row ? Number(row.getAttribute('data-repeat-index')) : NaN;
      return {
        canonical_field: mapped,
        confidence: 0.98,
        signals: ['adapter'],
        group_key: row?.getAttribute('data-repeat-group') ?? null,
        ...(Number.isFinite(idx) ? { instance_index: idx } : {}),
      };
    }
    return genericAdapter.mapField(element, ctx);
  }

  isSubmitControl(element: HTMLElement, ctx: AdapterContext): boolean {
    if (element.getAttribute('data-action') === 'submit-application') return true;
    return genericAdapter.isSubmitControl(element, ctx);
  }

  detectSubmission(event: Event, ctx: AdapterContext): SubmissionSignal | null {
    if (event.type === 'click' && event.target instanceof HTMLElement) {
      const control = event.target.closest<HTMLElement>('[data-action="submit-application"]');
      if (control) {
        return {
          kind: 'submit_button_clicked',
          signal_class: 'dom_intent',
          timestamp: nowIso(),
          monotonic_ms: monotonicMs(),
          detail: `portal submit control clicked: "${controlText(control)}"`,
          context: { adapter: this.name },
        };
      }
    }
    return genericAdapter.detectSubmission(event, ctx);
  }

  detectConfirmation(ctx: AdapterContext): ConfirmationSignal | null {
    const doc = ctx.document;

    // Strongest portal-specific rule: an explicit application-state attribute.
    const stateNode = doc.querySelector<HTMLElement>('[data-application-state]');
    const state = stateNode?.getAttribute('data-application-state');
    if (state === 'submitted' || state === 'received') {
      return {
        kind: 'adapter_confirmation',
        detail: `portal reported data-application-state="${state}"`,
        excerpt: sanitizeText(stateNode?.textContent ?? ''),
        selector: '[data-application-state]',
      };
    }

    const banner = doc.querySelector<HTMLElement>('.application-confirmation, [data-testid="confirmation-banner"]');
    if (banner) {
      return {
        kind: 'confirmation_modal',
        detail: 'portal confirmation banner rendered',
        excerpt: sanitizeText(banner.textContent ?? ''),
        selector: '.application-confirmation',
      };
    }

    if (/^\/apply\/[^/]+\/confirmation/.test(ctx.url.pathname)) {
      return {
        kind: 'adapter_confirmation',
        detail: 'navigated to the portal confirmation route',
        selector: null,
      };
    }

    return genericAdapter.detectConfirmation(ctx);
  }

  classifyNetwork(meta: NetworkMetaForAdapter): boolean | null {
    try {
      const url = new URL(meta.url);
      if (!HOSTS.includes(url.hostname) && !url.hostname.endsWith('.example-portal.com')) return null;
      if (/^\/api\/v\d+\/applications?\/?$/.test(url.pathname) && meta.method.toUpperCase() === 'POST') return true;
      if (/^\/api\/v\d+\/applications\/[^/]+\/submit$/.test(url.pathname)) return true;
      if (/^\/api\/v\d+\/(autosave|draft)/.test(url.pathname)) return false;
    } catch {
      return null;
    }
    return null;
  }
}

export const examplePortalAdapter = new ExamplePortalAdapter();
