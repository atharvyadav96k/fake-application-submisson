import { adapterManager } from '../adapters/adapter-manager';
import type { PageType, PortalAdapter } from '../adapters/types';
import type { EventPageContext } from '@/models/event';
import type { PageRecord } from '@/models/payload';
import { shortId } from '@/utils/ids';
import { createLogger } from '@/utils/logger';
import { sanitizeText, sanitizeUrl, urlParts } from '../utils/redaction';
import { nowIso } from '@/utils/timestamps';
import { extractPageContent, mergePageContent } from './page-content';

const log = createLogger('page-detector');

export interface PageTransition {
  from: PageRecord | null;
  to: PageRecord;
  kind: 'initial_load' | 'spa_navigation' | 'full_navigation';
  path_changed: boolean;
  adapter: PortalAdapter;
  page_type: PageType;
}

/**
 * Tracks URL/page state, including SPA route changes.
 *
 * `history.pushState`/`replaceState` are patched (in the isolated world's view of the
 * page's History object) and combined with `popstate`, `hashchange`, and a lightweight
 * poll as a backstack for routers that bypass the History API.
 */
export class PageDetector {
  private current: PageRecord | null = null;
  private sequence = 0;
  private readonly pages = new Map<string, PageRecord>();
  private listeners: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastHref = '';
  private onTransition: ((t: PageTransition) => void) | null = null;

  constructor(private readonly win: Window = window) {}

  start(onTransition: (t: PageTransition) => void): PageTransition {
    this.onTransition = onTransition;
    this.installHistoryHooks();
    this.installEventListeners();
    // Backstop poll: some routers mutate the URL through means we cannot hook.
    this.pollTimer = setInterval(() => this.checkForChange('spa_navigation'), 1000);
    return this.record('initial_load');
  }

  stop(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private installHistoryHooks(): void {
    const history = this.win.history;
    const wrap = (name: 'pushState' | 'replaceState') => {
      const original = history[name];
      if (typeof original !== 'function') return () => undefined;
      const patched = (...args: unknown[]) => {
        const result = (original as (...a: unknown[]) => unknown).apply(history, args);
        // Defer: the router usually renders synchronously right after this call.
        queueMicrotask(() => this.checkForChange('spa_navigation'));
        return result;
      };
      (history as unknown as Record<string, unknown>)[name] = patched;
      return () => {
        (history as unknown as Record<string, unknown>)[name] = original;
      };
    };
    this.listeners.push(wrap('pushState'), wrap('replaceState'));
  }

  private installEventListeners(): void {
    const onPop = () => this.checkForChange('spa_navigation');
    const onHash = () => this.checkForChange('spa_navigation');
    this.win.addEventListener('popstate', onPop);
    this.win.addEventListener('hashchange', onHash);
    this.listeners.push(
      () => this.win.removeEventListener('popstate', onPop),
      () => this.win.removeEventListener('hashchange', onHash),
    );
  }

  /** Re-evaluates the URL; emits a transition when it changed. */
  checkForChange(kind: 'spa_navigation' | 'full_navigation'): PageTransition | null {
    const href = this.win.location.href;
    if (href === this.lastHref) return null;
    const transition = this.record(kind);
    this.onTransition?.(transition);
    return transition;
  }

  private record(kind: PageTransition['kind']): PageTransition {
    const win = this.win;
    const href = win.location.href;
    this.lastHref = href;

    const parts = urlParts(href);
    const ctx = adapterManager.contextFor(win.document);
    const adapter = adapterManager.select(ctx.url);
    const pageType = adapterManager.safeCall<'identifyPage', PageType>(
      adapter,
      'identifyPage',
      (a) => a.identifyPage(ctx),
      'unknown',
    );

    const key = `${parts.sanitized}|${ctx.isFrame ? 'iframe' : 'top'}`;
    const existing = this.pages.get(key);
    const previous = this.current;

    // Re-captured on every visit: SPA steps render after the first pass, so a later
    // capture fills gaps the initial one could not see.
    const content = mergePageContent(existing?.content ?? null, extractPageContent(win.document));

    const page: PageRecord = existing
      ? {
          ...existing,
          last_seen_at: nowIso(),
          title: sanitizeText(win.document.title, 120),
          page_type: pageType,
          content,
        }
      : {
          page_id: shortId('pg'),
          sanitized_url: parts.sanitized,
          domain: parts.domain,
          path: parts.path,
          title: sanitizeText(win.document.title, 120),
          referrer: this.resolveReferrer(previous),
          entry_point: ctx.isFrame ? 'iframe' : kind,
          frame: ctx.isFrame ? 'iframe' : 'top',
          page_type: pageType,
          first_seen_at: nowIso(),
          last_seen_at: nowIso(),
          sequence: this.sequence++,
          content,
        };

    this.pages.set(key, page);
    this.current = page;

    log.debug('page', page.page_type, page.path);

    return {
      from: previous,
      to: page,
      kind,
      path_changed: previous ? previous.path !== page.path : true,
      adapter,
      page_type: pageType,
    };
  }

  private resolveReferrer(previous: PageRecord | null): string | null {
    if (previous) return previous.sanitized_url;
    const ref = this.win.document.referrer;
    return ref ? sanitizeUrl(ref) : null;
  }

  context(): EventPageContext {
    const page = this.current;
    const isFrame = this.win.top !== this.win.self;
    if (!page) {
      const parts = urlParts(this.win.location.href);
      return {
        domain: parts.domain,
        path: parts.path,
        sanitized_url: parts.sanitized,
        title: sanitizeText(this.win.document.title, 120),
        frame: isFrame ? 'iframe' : 'top',
      };
    }
    return {
      domain: page.domain,
      path: page.path,
      sanitized_url: page.sanitized_url,
      title: page.title,
      frame: page.frame,
      ...(page.frame === 'iframe' ? { frame_url: page.sanitized_url } : {}),
    };
  }

  currentPage(): PageRecord | null {
    return this.current;
  }

  allPages(): PageRecord[] {
    return [...this.pages.values()].sort((a, b) => a.sequence - b.sequence);
  }
}
