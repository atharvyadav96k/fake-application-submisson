import { getConfig } from '@/common/config';
import type { JobContext, PageContent } from '@/models/payload';
import { createLogger } from '@/utils/logger';
import { sanitizeText } from '../utils/redaction';
import { nowIso } from '@/utils/timestamps';

const log = createLogger('page-content');

/**
 * Extracts the *page's own* descriptive text — never the candidate's input.
 *
 * Two rules shape everything here:
 *
 * 1. **Text, never markup.** Only `textContent` and attribute values are read. `innerHTML`
 *    appears nowhere, so no markup, inline script, or embedded JSON state can leak through.
 * 2. **Required data only.** We do not walk the document and keep what it says. We ask a
 *    fixed set of questions (what job is this? what step am I on? what did the page just
 *    announce?) and keep only the answers. A whole-page text dump would swallow the
 *    candidate's own typed cover letter, which is exactly what the field pipeline exists to
 *    classify and hash.
 */

/**
 * Subtrees whose text is user input or non-content. Anything inside one of these is
 * skipped regardless of how it was found — `contenteditable` is the load-bearing entry:
 * rich-text cover-letter editors are div-based, so their text is otherwise reachable by an
 * innocent-looking heading query.
 */
const EXCLUDED_ANCESTORS = [
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
  'script',
  'style',
  'noscript',
  'template',
].join(',');

/** Headings that describe the page or the current form section. */
const HEADING_SELECTOR = 'h1,h2,h3,legend,[role="heading"],[class*="step-title" i],[class*="section-title" i]';

/** Live regions: what the page announced (progress, validation summary, banners). */
const STATUS_SELECTOR = '[role="status"],[role="alert"],[aria-live="polite"],[aria-live="assertive"]';

/** JSON-LD keys we read from a JobPosting. Everything else in the blob is ignored. */
interface LdJobPosting {
  title?: unknown;
  hiringOrganization?: unknown;
  jobLocation?: unknown;
  employmentType?: unknown;
  datePosted?: unknown;
  identifier?: unknown;
}

function isExcluded(el: Element): boolean {
  return el.closest(EXCLUDED_ANCESTORS) !== null;
}

/** Cheap visibility test — no layout read, so this stays safe to call in bulk. */
function isDisplayed(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

/** Budget-aware text accumulator: enforces per-item and whole-capture character caps. */
class TextBudget {
  private used = 0;
  truncated = false;

  constructor(
    private readonly total: number,
    private readonly perItem: number,
  ) {}

  take(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const remaining = this.total - this.used;
    // Below two characters there is no room for content plus its ellipsis.
    if (remaining < 2) {
      this.truncated = true;
      return null;
    }
    // `sanitizeText` appends a one-character ellipsis when it cuts, so the result can be
    // one longer than the limit it was given. Reserve that character up front, otherwise
    // the accumulated total creeps past the configured budget.
    const room = Math.min(this.perItem, remaining) - 1;
    const text = sanitizeText(raw, room);
    if (!text) return null;
    if (text.length > room) this.truncated = true;
    this.used += text.length;
    return text;
  }
}

function metaContent(doc: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const el = doc.querySelector<HTMLMetaElement>(selector);
    const content = el?.getAttribute('content');
    if (content && content.trim()) return content;
  }
  return null;
}

/** Unwraps the shapes schema.org allows for a nested entity: string, object, or array. */
function ldName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = ldName(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Address objects carry the useful part one level down.
    const direct = obj.name ?? obj.value ?? obj['@value'];
    if (typeof direct === 'string') return direct;
    const address = obj.address;
    if (address) {
      if (typeof address === 'string') return address;
      const a = address as Record<string, unknown>;
      const parts = [a.addressLocality, a.addressRegion, a.addressCountry]
        .map((p) => ldName(p))
        .filter((p): p is string => Boolean(p));
      if (parts.length) return parts.join(', ');
    }
  }
  return null;
}

/** Flattens `@graph` / arrays so a JobPosting nested in either shape is still found. */
function flattenLdNodes(parsed: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 3 || !parsed) return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) flattenLdNodes(item, out, depth + 1);
    return;
  }
  if (typeof parsed !== 'object') return;
  const node = parsed as Record<string, unknown>;
  out.push(node);
  if (node['@graph']) flattenLdNodes(node['@graph'], out, depth + 1);
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const t = node['@type'];
  if (typeof t === 'string') return t === type;
  if (Array.isArray(t)) return t.some((x) => x === type);
  return false;
}

/**
 * Reads a schema.org JobPosting from JSON-LD.
 *
 * This is the highest-quality source available: it is the portal's own structured
 * description of the role, so it needs no scraping heuristics and cannot pick up anything
 * the candidate typed.
 */
function extractJobPosting(doc: Document, budget: TextBudget): JobContext | null {
  const blocks = doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
  const nodes: Record<string, unknown>[] = [];

  for (let i = 0; i < blocks.length && i < 12; i++) {
    const raw = blocks[i]!.textContent;
    if (!raw || raw.length > 200_000) continue;
    try {
      flattenLdNodes(JSON.parse(raw), nodes);
    } catch {
      // Malformed JSON-LD is common in the wild and is not our problem to report.
    }
  }

  const posting = nodes.find((n) => hasType(n, 'JobPosting')) as LdJobPosting | undefined;
  if (!posting) return null;

  const job: JobContext = {
    title: budget.take(ldName(posting.title)),
    company: budget.take(ldName(posting.hiringOrganization)),
    location: budget.take(ldName(posting.jobLocation)),
    employment_type: budget.take(ldName(posting.employmentType)),
    date_posted: budget.take(ldName(posting.datePosted)),
    requisition_id: budget.take(ldName(posting.identifier)),
    source: 'json_ld',
  };

  return job.title || job.company ? job : null;
}

/** Fallback job context from Open Graph / meta tags when there is no JSON-LD. */
function extractJobFromMeta(doc: Document, budget: TextBudget): JobContext | null {
  const title = budget.take(metaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']));
  const company = budget.take(
    metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="author"]', 'meta[property="og:brand"]']),
  );
  if (!title && !company) return null;
  return {
    title,
    company,
    location: null,
    employment_type: null,
    date_posted: null,
    requisition_id: null,
    source: 'meta',
  };
}

function extractHeadings(doc: Document, budget: TextBudget, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const nodes = doc.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
  const scanCap = Math.min(nodes.length, getConfig().dom.max_scan_nodes);

  for (let i = 0; i < scanCap && out.length < limit; i++) {
    const el = nodes[i]!;
    if (!isDisplayed(el) || isExcluded(el)) continue;
    const text = budget.take(el.textContent);
    if (!text || text.length < 2) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function extractStatusText(doc: Document, budget: TextBudget, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const nodes = doc.querySelectorAll<HTMLElement>(STATUS_SELECTOR);

  for (let i = 0; i < nodes.length && out.length < limit; i++) {
    const el = nodes[i]!;
    if (!isDisplayed(el) || isExcluded(el)) continue;
    const text = budget.take(el.textContent);
    if (!text || text.length < 2) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Builds the page's content record. Returns `null` when capture is disabled, so callers
 * can treat "switched off" and "nothing found" identically.
 */
export function extractPageContent(doc: Document = document): PageContent | null {
  const cfg = getConfig().content_capture;
  if (!cfg.enabled) return null;

  try {
    const budget = new TextBudget(cfg.max_total_chars, cfg.max_item_chars);

    const h1 = doc.querySelector<HTMLElement>('h1');
    const headline = h1 && !isExcluded(h1) ? budget.take(h1.textContent) : null;

    const summary = cfg.capture_summary
      ? budget.take(
          metaContent(doc, ['meta[name="description"]', 'meta[property="og:description"]']),
        )
      : null;

    const siteName = budget.take(metaContent(doc, ['meta[property="og:site_name"]']));

    let job: JobContext | null = null;
    if (cfg.capture_job_posting) {
      job = extractJobPosting(doc, budget) ?? extractJobFromMeta(doc, budget);
    }

    const sections = cfg.capture_headings ? extractHeadings(doc, budget, cfg.max_headings) : [];
    const statusText = cfg.capture_status ? extractStatusText(doc, budget, cfg.max_status_items) : [];

    const content: PageContent = {
      headline,
      summary,
      site_name: siteName,
      job,
      sections,
      status_text: statusText,
      captured_at: nowIso(),
      truncated: budget.truncated,
    };

    // Nothing worth recording — keep the payload clean rather than storing an empty shell.
    const empty =
      !headline && !summary && !siteName && !job && sections.length === 0 && statusText.length === 0;
    return empty ? null : content;
  } catch (err) {
    log.warn('page content extraction failed', err);
    return null;
  }
}

/**
 * Merges a fresh capture over an older one. SPA steps render after the first capture, so
 * later passes fill gaps; a value we already have is never replaced by a null.
 */
export function mergePageContent(previous: PageContent | null, next: PageContent | null): PageContent | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    headline: next.headline ?? previous.headline,
    summary: next.summary ?? previous.summary,
    site_name: next.site_name ?? previous.site_name,
    job: next.job ?? previous.job,
    sections: next.sections.length ? next.sections : previous.sections,
    status_text: next.status_text.length ? next.status_text : previous.status_text,
    captured_at: next.captured_at,
    truncated: previous.truncated || next.truncated,
  };
}
