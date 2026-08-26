import type { AdapterContext, ConfirmationSignal, NetworkMetaForAdapter, PageType, PortalAdapter } from '../types';
import { genericAdapter } from '../generic-adapter';

/**
 * Naukri.com.
 *
 * Built in two passes. The first pass encoded only route naming that's stable and
 * publicly observable (job listing URLs, the candidate profile path) without a captured
 * session to verify against. This pass adds the one thing a real flagged-at-85%
 * direct-apply session actually confirmed: a genuine, same-tab in-place apply lands on
 * `/myapply/saveApply`, titled "Apply Confirmation" — a real confirmation page that
 * neither this adapter's earlier route list nor the generic detector's phrase list
 * recognised, so the session sat at a `submitted`-but-not-`confirmed` score and got
 * flagged despite the application having gone through.
 *
 * Naukri jobs come in two shapes that matter for verification:
 *   - "Easy Apply" / direct apply: submitted in place, landing on the confirmation route
 *     above; some variants also relabel the button from "Apply" to "Applied" in place,
 *     which the generic adapter's button-relabel heuristic already covers.
 *   - "Apply on company site": the click hands off to the employer's own careers page,
 *     often on a different domain entirely — already covered by tab-based session
 *     scoping and the redirect-chain (`portal_domains`) tracking, neither of which is
 *     portal-specific.
 * Click detection, field mapping, and network classification remain deferred to the
 * generic heuristics — nothing captured so far has shown those to be wrong for Naukri.
 */

function isNaukriHost(hostname: string): boolean {
  return hostname === 'naukri.com' || hostname.endsWith('.naukri.com');
}

/** The confirmation route for a direct/easy apply, observed in a real session. */
const CONFIRMATION_PATH = /^\/myapply\/saveApply\b/;

export class NaukriAdapter implements PortalAdapter {
  readonly name = 'naukri';
  readonly kind = 'known' as const;
  readonly priority = 100;

  matches(url: URL): boolean {
    return isNaukriHost(url.hostname);
  }

  identifyPage(ctx: AdapterContext): PageType {
    const path = ctx.url.pathname;
    if (CONFIRMATION_PATH.test(path)) return 'confirmation';
    if (/^\/mnjuser\/profile\b/.test(path)) return 'candidate_record';
    if (/^\/job-listings-/.test(path)) return 'job_listing';
    return genericAdapter.identifyPage(ctx);
  }

  getCandidateFields() {
    // No confirmed field-name inventory for Naukri's apply flow yet — the generic
    // label/autocomplete/placeholder mapper handles it reasonably well on its own.
    return genericAdapter.getCandidateFields();
  }

  mapField(element: HTMLElement, ctx: AdapterContext) {
    return genericAdapter.mapField(element, ctx);
  }

  detectSubmission(event: Event, ctx: AdapterContext) {
    return genericAdapter.detectSubmission(event, ctx);
  }

  detectConfirmation(ctx: AdapterContext): ConfirmationSignal | null {
    if (CONFIRMATION_PATH.test(ctx.url.pathname)) {
      return {
        kind: 'adapter_confirmation',
        detail: "navigated to Naukri's known apply-confirmation route",
        selector: null,
      };
    }
    // Falls through to the generic detector, which also checks the page title — Naukri's
    // confirmation page titles itself "Apply Confirmation", which the generic phrase list
    // now recognises too, so this still confirms even off the exact known route.
    return genericAdapter.detectConfirmation(ctx);
  }

  classifyNetwork(meta: NetworkMetaForAdapter, ctx: AdapterContext): boolean | null {
    try {
      const url = new URL(meta.url);
      if (!isNaukriHost(url.hostname)) return null;
    } catch {
      return null;
    }
    return genericAdapter.classifyNetwork?.(meta, ctx) ?? null;
  }
}

export const naukriAdapter = new NaukriAdapter();
