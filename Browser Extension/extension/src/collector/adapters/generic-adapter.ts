import { getConfig } from '@/common/config';
import type { CanonicalField, IdentificationSignal } from '@/models/field';
import type { SubmissionSignal } from '@/models/submission';
import {
  collectHints,
  controlText,
  findRepeaterIndex,
  isVisible,
  looksLikeSubmitControl,
} from '../content/dom-utils';
import { sanitizeText } from '../utils/redaction';
import { monotonicMs, nowIso } from '@/utils/timestamps';
import { clamp, normalizeLabel, tokenize } from '@/utils/text';
import type {
  AdapterContext,
  CanonicalMapping,
  ConfirmationSignal,
  FieldDefinition,
  NetworkMetaForAdapter,
  PageType,
  PortalAdapter,
} from './types';
import { AUTOCOMPLETE_MAP, COMMONLY_EXPECTED_FIELDS, INPUT_TYPE_HINTS, VOCABULARY } from './vocabulary';


interface SignalHit {
  canonical: CanonicalField;
  score: number;
  signal: IdentificationSignal;
  group?: string;
}

const SOURCE_WEIGHTS: { key: keyof ReturnType<typeof collectHints>; signal: IdentificationSignal; weight: number }[] = [
  { key: 'label', signal: 'label', weight: 0.9 },
  { key: 'ariaLabel', signal: 'aria_label', weight: 0.85 },
  { key: 'name', signal: 'name', weight: 0.7 },
  { key: 'id', signal: 'id', weight: 0.6 },
  { key: 'placeholder', signal: 'placeholder', weight: 0.55 },
    // data-testid / data-field are deliberate authoring hints, not incidental markup.
  { key: 'dataAttrs', signal: 'dom_structure', weight: 0.62 },
  { key: 'surrounding', signal: 'surrounding_text', weight: 0.35 },
];

function phraseScore(haystack: string, tokensOf: string[], phrase: string): number {
  const normalized = normalizeLabel(phrase);
  if (!normalized) return 0;
  if (haystack === normalized) return 1;
  if (haystack.includes(normalized)) return 0.9;
  const needed = tokenize(normalized);
  if (needed.length > 0 && needed.every((t) => tokensOf.includes(t))) {
    return needed.length > 1 ? 0.8 : 0.65;
  }
  return 0;
}

function scoreHint(text: string, source: IdentificationSignal, sourceWeight: number): SignalHit[] {
  const haystack = normalizeLabel(text);
  if (!haystack) return [];
  const toks = tokenize(haystack);
  const hits: SignalHit[] = [];

  for (const rule of VOCABULARY) {
    if (rule.negative?.some((neg) => haystack.includes(normalizeLabel(neg)))) continue;
    let best = 0;
    for (const phrase of rule.phrases) best = Math.max(best, phraseScore(haystack, toks, phrase));
    if (best === 0) continue;
    hits.push({
      canonical: rule.canonical,
      score: best * sourceWeight * (rule.weight ?? 1),
      signal: source,
      group: rule.group,
    });
  }
  return hits;
}

export class GenericAdapter implements PortalAdapter {
  readonly name = 'generic';
  readonly kind = 'generic' as const;
  readonly priority = 0;

  matches(): boolean {
    return true;
  }

  identifyPage(ctx: AdapterContext): PageType {
    const path = ctx.url.pathname.toLowerCase();
    const doc = ctx.document;
    const title = normalizeLabel(doc.title);

    if (this.detectConfirmation(ctx)) return 'confirmation';
    if (/\/(confirm|confirmation|thank[-_]?you|success|submitted)\b/.test(path)) return 'confirmation';
    if (/\/(login|signin|sign-in|auth)\b/.test(path)) return 'login';
    if (/\/(candidate|profile|applicant)s?\//.test(path)) return 'candidate_record';

    const hasForm = doc.querySelector('form, [role="form"]') !== null;
    const controlCount = doc.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
    const applyish = /\/(apply|application|job-application)/.test(path) || /\bapply\b/.test(title);

    if (hasForm && controlCount >= 3 && applyish) {
      const stepIndicator = doc.querySelector('[class*="step" i],[aria-label*="step" i],[role="progressbar"]');
      return stepIndicator ? 'application_step' : 'application_form';
    }
    if (hasForm && controlCount >= 5) return 'application_form';
    if (/\/(job|jobs|careers|vacancy|position)s?\b/.test(path)) return 'job_listing';
    if (/\/(dashboard|home|portal)\b/.test(path)) return 'dashboard';
    return 'unknown';
  }

  getCandidateFields(): FieldDefinition[] {
    return COMMONLY_EXPECTED_FIELDS.map((canonical_field) => ({ canonical_field, selector: '' }));
  }

  mapField(element: HTMLElement, _ctx?: AdapterContext): CanonicalMapping | null {
    const hints = collectHints(element);
    const signals = new Set<IdentificationSignal>();
    const scores = new Map<CanonicalField, number>();
    let groupFromVocab: string | undefined;
    const acToken = (hints.autocomplete ?? '').toLowerCase().split(/\s+/).pop() ?? '';
    const acField = AUTOCOMPLETE_MAP[acToken];
    if (acField) {
      scores.set(acField, (scores.get(acField) ?? 0) + 1.1);
      signals.add('autocomplete');
    }

    for (const src of SOURCE_WEIGHTS) {
      const raw = hints[src.key];
      if (!raw) continue;
      for (const hit of scoreHint(raw, src.signal, src.weight)) {
        scores.set(hit.canonical, (scores.get(hit.canonical) ?? 0) + hit.score);
        signals.add(hit.signal);
        if (hit.group) groupFromVocab = hit.group;
      }
    }

    const typeHint = hints.type ? INPUT_TYPE_HINTS[hints.type] : undefined;
    if (typeHint) {
      scores.set(typeHint, (scores.get(typeHint) ?? 0) + 0.45);
      signals.add('input_type');
    }

    if (scores.size === 0) return null;

    let bestField: CanonicalField = 'unknown';
    let bestScore = 0;
    let runnerUp = 0;
    for (const [field, score] of scores) {
      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        bestField = field;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }

    const margin = bestScore > 0 ? (bestScore - runnerUp) / bestScore : 0;
    const confidence = clamp(bestScore * (0.65 + 0.35 * margin), 0, 1);

    if (confidence < getConfig().dom.field_match_min_confidence) {
      return {
        canonical_field: 'unknown',
        confidence,
        signals: [...signals],
        group_key: groupFromVocab ?? null,
      };
    }

    const repeater = findRepeaterIndex(element);
    if (repeater) signals.add('dom_structure');

    return {
      canonical_field: bestField,
      confidence,
      signals: [...signals],
      group_key: repeater?.group_key ?? groupFromVocab ?? null,
      ...(repeater ? { instance_index: repeater.instance_index } : {}),
    };
  }

  isSubmitControl(element: HTMLElement, _ctx?: AdapterContext): boolean {
    return looksLikeSubmitControl(element);
  }

  resolveGroup(element: HTMLElement, _ctx?: AdapterContext) {
    return findRepeaterIndex(element);
  }

  detectSubmission(event: Event, _ctx?: AdapterContext): SubmissionSignal | null {
    const target = event.target;
    if (!(target instanceof HTMLElement) && !(target instanceof Document)) return null;

    if (event.type === 'submit') {
      const form = event.target as HTMLElement;
      return {
        kind: 'form_submit_event',
        signal_class: 'dom_submit',
        timestamp: nowIso(),
        monotonic_ms: monotonicMs(),
        detail: 'native form submit event observed',
        context: { form_id: form instanceof HTMLElement ? form.getAttribute('id') : null },
      };
    }

    if (event.type === 'click' && target instanceof HTMLElement) {
      const control = target.closest<HTMLElement>('button,[role="button"],input[type="submit"],a');
      if (!control || !looksLikeSubmitControl(control)) return null;
      return {
        kind: 'submit_button_clicked',
        signal_class: 'dom_intent',
        timestamp: nowIso(),
        monotonic_ms: monotonicMs(),
        detail: `submit-like control clicked: "${controlText(control)}"`,
        context: { control_tag: control.tagName.toLowerCase(), visible: isVisible(control) },
      };
    }

    return null;
  }

  detectConfirmation(ctx: AdapterContext): ConfirmationSignal | null {
    const cfg = getConfig().confirmation;
    const doc = ctx.document;

    const titleText = sanitizeText(doc.title ?? '');
    const titleMatch = matchPhrase(titleText);
    if (titleMatch) {
      return {
        kind: 'confirmation_text',
        detail: `confirmation phrase "${titleMatch}" in page title`,
        excerpt: titleText,
        selector: 'title',
      };
    }

    for (const selector of cfg.success_selectors) {
      let nodes: NodeListOf<HTMLElement>;
      try {
        nodes = doc.querySelectorAll<HTMLElement>(selector);
      } catch {
        continue; // selector unsupported in this engine
      }
      for (const node of nodes) {
        const text = sanitizeText(node.textContent ?? '');
        if (!text) continue;
        const matched = matchPhrase(text);
        if (matched) {
          return {
            kind: selector.includes('toast') || selector.includes('status') ? 'success_toast' : 'confirmation_modal',
            detail: `confirmation phrase "${matched}" in ${selector}`,
            excerpt: text,
            selector,
          };
        }
      }
    }

    const headings = doc.querySelectorAll<HTMLElement>('h1,h2,h3,[role="heading"],[class*="confirm" i],[class*="success" i]');
    let inspected = 0;
    for (const node of headings) {
      if (inspected++ > 40) break;
      const text = sanitizeText(node.textContent ?? '');
      const matched = matchPhrase(text);
      if (matched) {
        return {
          kind: 'confirmation_text',
          detail: `confirmation phrase "${matched}" in <${node.tagName.toLowerCase()}>`,
          excerpt: text,
          selector: node.tagName.toLowerCase(),
        };
      }
    }

    return null;
  }

  classifyNetwork(meta: NetworkMetaForAdapter, _ctx?: AdapterContext): boolean | null {
    const cfg = getConfig().network;
    let url: URL;
    try {
      url = new URL(meta.url);
    } catch {
      return null;
    }
    const path = url.pathname.toLowerCase();
    if (cfg.ignored_path_hints.some((h) => path.includes(h))) return false;
    if (!cfg.submission_methods.includes(meta.method.toUpperCase())) return false;
    if (cfg.submission_path_hints.some((h) => path.includes(h))) return true;
    return null; // defer to correlation with click/submit timing
  }
}

const phraseCache = new Map<string, RegExp>();

function matchPhrase(text: string): string | null {
  if (!text) return null;
  for (const { key, pattern } of getConfig().confirmation.phrases) {
    let re = phraseCache.get(pattern);
    if (!re) {
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        continue;
      }
      phraseCache.set(pattern, re);
    }
    if (re.test(text)) return key;
  }
  return null;
}

export { matchPhrase };
export const genericAdapter = new GenericAdapter();
