import { getConfig } from '@/common/config';
import { createLogger } from '@/utils/logger';
import { debounce } from '@/utils/text';
import { formControlSelector, isFormControl } from './dom-utils';

const log = createLogger('form-tracker');

export interface DomChangeSummary {
  /** Roots under which new form controls appeared. */
  addedRoots: ParentNode[];
  /** True when a tracked control left the document. */
  removedControls: boolean;
  /** True when a <form> element was added or removed. */
  formStructureChanged: boolean;
  /** True when a node that could be a toast/alert/confirmation appeared. */
  possibleConfirmation: boolean;
  /** True when a node that looks like a validation error appeared. */
  possibleValidationError: boolean;
}

/**
 * Watches the DOM for dynamically rendered forms and confirmation UI.
 *
 * Performance rules that matter on large React/Angular apps:
 *  - a single observer on `document.documentElement`, never one per form;
 *  - `attributes: false` — attribute churn is the dominant mutation source and we do
 *    not need it (state changes reach us through DOM events instead);
 *  - callbacks are debounced and the per-batch node budget is capped, so a render storm
 *    costs a bounded amount of work rather than being proportional to node count;
 *  - the summary is computed from the mutation records themselves — we never re-query
 *    the whole document on every batch.
 */
export class FormTracker {
  private observer: MutationObserver | null = null;
  private readonly flush: ReturnType<typeof debounce<[]>>;
  private pending: MutationRecord[] = [];

  constructor(
    private readonly onChange: (summary: DomChangeSummary) => void,
    private readonly doc: Document = document,
  ) {
    this.flush = debounce(() => this.process(), getConfig().dom.mutation_debounce_ms);
  }

  start(): void {
    if (this.observer) return;
    const root = this.doc.documentElement ?? this.doc.body;
    if (!root) return;

    this.observer = new MutationObserver((records) => {
      // Cap retained records; a huge batch tells us "lots changed", and re-scanning the
      // changed subtrees beyond the cap would not add information worth the cost.
      const budget = getConfig().dom.max_scan_nodes;
      if (this.pending.length < budget) {
        this.pending.push(...records.slice(0, budget - this.pending.length));
      }
      this.flush();
    });

    this.observer.observe(root, { childList: true, subtree: true, attributes: false, characterData: false });
    log.debug('mutation observer attached');
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.flush.cancel();
    this.pending = [];
  }

  /** Force processing of anything pending (used before taking a final snapshot). */
  flushNow(): void {
    this.flush.flush();
  }

  private process(): void {
    const records = this.pending;
    this.pending = [];
    if (records.length === 0) return;

    const summary: DomChangeSummary = {
      addedRoots: [],
      removedControls: false,
      formStructureChanged: false,
      possibleConfirmation: false,
      possibleValidationError: false,
    };

    const selector = formControlSelector();
    const seenRoots = new Set<ParentNode>();

    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName === 'FORM') summary.formStructureChanged = true;
        if (looksLikeStatusNode(node)) summary.possibleConfirmation = true;
        if (looksLikeErrorNode(node)) summary.possibleValidationError = true;

        if (isFormControl(node)) {
          const parent = node.parentNode ?? node.ownerDocument;
          if (parent && !seenRoots.has(parent)) {
            seenRoots.add(parent);
            summary.addedRoots.push(parent);
          }
          continue;
        }
        // Only descend when the subtree actually contains controls.
        if (node.querySelector(selector) !== null && !seenRoots.has(node)) {
          seenRoots.add(node);
          summary.addedRoots.push(node);
        } else if (node.querySelector('form,[role="status"],[role="alert"]') !== null) {
          summary.formStructureChanged = true;
          summary.possibleConfirmation = true;
        }
      }

      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName === 'FORM') {
          summary.formStructureChanged = true;
          summary.removedControls = true;
        } else if (isFormControl(node) || node.querySelector(selector) !== null) {
          summary.removedControls = true;
        }
      }
    }

    if (
      summary.addedRoots.length === 0 &&
      !summary.removedControls &&
      !summary.formStructureChanged &&
      !summary.possibleConfirmation &&
      !summary.possibleValidationError
    ) {
      return;
    }

    try {
      this.onChange(summary);
    } catch (err) {
      log.warn('onChange failed', err);
    }
  }
}

const STATUS_HINT = /(toast|alert|notification|snackbar|confirm|success|modal|dialog|banner)/i;
const ERROR_HINT = /(error|invalid|required|validation)/i;

/** Validation UI appearing after a submit attempt is negative evidence, so it must
 *  wake the detector just as confirmation UI does. */
function looksLikeErrorNode(el: Element): boolean {
  if (el.getAttribute('aria-invalid') === 'true') return true;
  const cls = el.getAttribute('class');
  if (cls && ERROR_HINT.test(cls)) return true;
  const testId = el.getAttribute('data-testid');
  if (testId && ERROR_HINT.test(testId)) return true;
  return el.querySelector('[aria-invalid="true"]') !== null;
}

function looksLikeStatusNode(el: Element): boolean {
  const role = el.getAttribute('role');
  if (role === 'status' || role === 'alert' || role === 'alertdialog' || role === 'dialog') return true;
  const cls = el.getAttribute('class');
  if (cls && STATUS_HINT.test(cls)) return true;
  const testId = el.getAttribute('data-testid');
  return testId !== null && STATUS_HINT.test(testId);
}
