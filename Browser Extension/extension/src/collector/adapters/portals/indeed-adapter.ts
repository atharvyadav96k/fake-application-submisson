import type { AdapterContext, ConfirmationSignal, NetworkMetaForAdapter, PageType, PortalAdapter } from '../types';
import { genericAdapter } from '../generic-adapter';

/**
 * Indeed's "Indeed Apply" flow.
 *
 * Built from an actual observed session rather than guesswork: the page sequence for a
 * completed application is
 *   /beta/indeedapply/applybyapplyablejobid
 *   /beta/indeedapply/form/review-module     ("Review the contents of this job application")
 *   /beta/indeedapply/form/post-apply        ("Your application has been submitted")
 * plus incidental reCAPTCHA / service-worker iframes that carry no signal either way.
 *
 * What this adapter does NOT attempt: Indeed's actual submit control and its GraphQL API
 * (`apis.indeed.com/graphql`) are both unknowns worth naming honestly rather than
 * guessing at. A single GraphQL endpoint serves every mutation the app has — autosave,
 * follow, notifications, the real apply — so it cannot be told apart by URL alone without
 * reading the request body, which this project deliberately never does. Click detection
 * and network classification are left to the generic heuristics; only the page-route
 * knowledge below is genuinely portal-specific.
 */

function isIndeedHost(hostname: string): boolean {
  return hostname === 'indeed.com' || hostname.endsWith('.indeed.com');
}

export class IndeedAdapter implements PortalAdapter {
  readonly name = 'indeed';
  readonly kind = 'known' as const;
  readonly priority = 100;

  matches(url: URL): boolean {
    return isIndeedHost(url.hostname);
  }

  identifyPage(ctx: AdapterContext): PageType {
    const path = ctx.url.pathname;
    if (/\/beta\/indeedapply\/form\/post-apply\b/.test(path)) return 'confirmation';
    if (/\/beta\/indeedapply\//.test(path)) return 'application_step';
    return genericAdapter.identifyPage(ctx);
  }

  getCandidateFields() {
    return genericAdapter.getCandidateFields();
  }

  mapField(element: HTMLElement, ctx: AdapterContext) {
    return genericAdapter.mapField(element, ctx);
  }

  detectSubmission(event: Event, ctx: AdapterContext) {
    return genericAdapter.detectSubmission(event, ctx);
  }

  detectConfirmation(ctx: AdapterContext): ConfirmationSignal | null {
    if (/\/beta\/indeedapply\/form\/post-apply\b/.test(ctx.url.pathname)) {
      return {
        kind: 'adapter_confirmation',
        detail: 'navigated to Indeed Apply\'s known post-apply route',
        selector: null,
      };
    }
    return genericAdapter.detectConfirmation(ctx);
  }

  classifyNetwork(meta: NetworkMetaForAdapter, ctx: AdapterContext): boolean | null {
    try {
      const url = new URL(meta.url);
      if (!isIndeedHost(url.hostname)) return null;
      if (url.pathname === '/graphql') return null;
    } catch {
      return null;
    }
    return genericAdapter.classifyNetwork?.(meta, ctx) ?? null;
  }
}

export const indeedAdapter = new IndeedAdapter();
