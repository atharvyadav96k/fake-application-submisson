import { adapterManager } from '../adapters/adapter-manager';
import type { AdapterContext, PortalAdapter } from '../adapters/types';
import { DEFAULT_SCORING, getConfig, type ScoringConfig } from '@/common/config';
import type { NetworkRequestMeta, ValidationErrorMeta } from '@/models/event';
import type { PageRecord } from '@/models/payload';
import type {
  EvidenceItem,
  SignalClass,
  SubmissionAssessment,
  SubmissionSignal,
  SubmissionState,
} from '@/models/submission';
import { createLogger } from '@/utils/logger';
import { sanitizeText } from '../utils/redaction';
import { clamp, round } from '@/utils/text';
import { monotonicMs, nowIso } from '@/utils/timestamps';
import type { EventBuffer } from './event-buffer';
import { controlText, domPath, findSubmitControls, isDisabled, isVisible } from './dom-utils';

/**
 * Many "easy apply" flows never show a toast, modal, or confirmation page — the clicked
 * control's own label just changes in place (e.g. "Apply" -> "Applied"). Distinct from
 * the *original* submit-intent wording ("apply"/"submit") so the pre-click label never
 * matches this itself.
 */
const BUTTON_CONFIRMATION_TEXT = /\b(applied|application\s+sent|request\s+sent|sent\s+successfully|already\s+applied)\b/i;

const log = createLogger('submission');

/**
 * Pure scoring function.
 *
 * Independent signal *classes* are fused with noisy-OR so that several weak,
 * independent observations accumulate — while repeated observations of the same class
 * (three clicks on Apply) cannot inflate the score. Negative signals subtract.
 *
 * Exported separately from the detector so the score is testable and reproducible from
 * a stored evidence array alone.
 */
export function scoreSignals(
  signals: SubmissionSignal[],
  scoring: ScoringConfig = DEFAULT_SCORING,
): SubmissionAssessment {
  const evaluatedAt = nowIso();
  const evidence: EvidenceItem[] = [];
  const negatives: EvidenceItem[] = [];

  // Strongest positive contribution per class.
  const bestByClass = new Map<SignalClass, { weight: number; index: number }>();
  const seenNegativeKinds = new Set<string>();

  signals.forEach((signal) => {
    const weight = scoring.weights[signal.kind] ?? 0;
    const signalClass = scoring.classes[signal.kind] ?? signal.signal_class;
    const item: EvidenceItem = {
      kind: signal.kind,
      signal_class: signalClass,
      timestamp: signal.timestamp,
      weight,
      detail: signal.detail,
      counted: false,
    };

    if (weight < 0 || signalClass === 'negative') {
      // Each distinct negative kind counts once.
      if (!seenNegativeKinds.has(signal.kind)) {
        seenNegativeKinds.add(signal.kind);
        item.counted = true;
      }
      negatives.push(item);
      return;
    }

    evidence.push(item);
    const current = bestByClass.get(signalClass);
    if (!current || weight > current.weight) {
      bestByClass.set(signalClass, { weight, index: evidence.length - 1 });
    }
  });

  for (const { index } of bestByClass.values()) {
    const item = evidence[index];
    if (item) item.counted = true;
  }

  let positive = 0;
  for (const { weight } of bestByClass.values()) {
    positive = 1 - (1 - positive) * (1 - clamp(weight, 0, 1));
  }
  const penalty = negatives.filter((n) => n.counted).reduce((sum, n) => sum + n.weight, 0);
  const score = round(clamp(positive + penalty, 0, 1));

  const kinds = new Set(signals.map((s) => s.kind));
  const appliedClicked = kinds.has('submit_button_clicked');
  const confirmationDetected = [...bestByClass.keys()].includes(scoring.confirmation_required_class);
  const submitDetected =
    kinds.has('form_submit_event') ||
    kinds.has('submission_request') ||
    kinds.has('submission_request_success') ||
    kinds.has('confirmation_navigation') ||
    confirmationDetected;

  const negativeKinds = new Set(negatives.filter((n) => n.counted).map((n) => n.kind));
  const state = deriveState({
    score,
    appliedClicked,
    submitDetected,
    confirmationDetected,
    negativeKinds,
    scoring,
  });

  return {
    applied_clicked: appliedClicked,
    submit_detected: submitDetected,
    confirmation_detected: confirmationDetected,
    state,
    confidence_score: score,
    evidence_kinds: [...kinds],
    evidence,
    negative_evidence: negatives,
    evaluated_at: evaluatedAt,
    notes: buildNotes(
      { score, appliedClicked, submitDetected, confirmationDetected, negativeKinds, scoring },
      state,
    ),
    // Not derived from signals — `SubmissionDetector` fills these in separately and
    // re-applies them across re-scoring, since scoring itself is pure.
    context_excerpt: null,
    clicked_control: null,
  };
}

interface StateInput {
  score: number;
  appliedClicked: boolean;
  submitDetected: boolean;
  confirmationDetected: boolean;
  negativeKinds: Set<string>;
  scoring: ScoringConfig;
}

function deriveState(input: StateInput): SubmissionState {
  const { score, appliedClicked, submitDetected, confirmationDetected, negativeKinds, scoring } = input;

  // Confirmation is necessary but not sufficient: the score must clear the threshold too.
  if (confirmationDetected && score >= scoring.confirm_threshold) return 'confirmed';

  const contradicted =
    negativeKinds.has('validation_error_after_submit') ||
    negativeKinds.has('submission_request_failed') ||
    negativeKinds.has('form_still_present');

  if (appliedClicked && !submitDetected) return contradicted ? 'click_without_submission' : 'clicked_only';
  if (submitDetected && !appliedClicked) return 'submission_without_click';
  if (submitDetected && score >= scoring.submit_threshold) return 'submitted';
  if (submitDetected) return 'clicked_only';
  return 'unknown';
}

function buildNotes(input: StateInput, state: SubmissionState): string[] {
  const notes: string[] = [];
  const { score, appliedClicked, submitDetected, confirmationDetected, negativeKinds, scoring } = input;

  if (state === 'clicked_only') {
    notes.push('A submit control was activated but no independent submission signal followed yet.');
  }
  if (state === 'click_without_submission') {
    notes.push('A submit control was activated and the page then produced contradicting evidence.');
  }
  if (state === 'submission_without_click') {
    notes.push(
      'Submission signals appeared without an observed click — keyboard submit, an SPA action, or a control the heuristics did not recognise are all plausible.',
    );
  }
  if (submitDetected && !confirmationDetected) {
    notes.push('No portal confirmation was observed, so the submission is not treated as confirmed.');
  }
  if (confirmationDetected && score < scoring.confirm_threshold) {
    notes.push(
      `Confirmation-class evidence was present but the fused score (${score}) is below the configured threshold (${scoring.confirm_threshold}).`,
    );
  }
  for (const kind of negativeKinds) notes.push(`Negative evidence recorded: ${kind}.`);
  if (!appliedClicked && !submitDetected) notes.push('No submission evidence of any kind was observed.');
  return notes;
}

export interface SubmissionDetectorDeps {
  buffer: EventBuffer;
  adapter: () => PortalAdapter;
  onAssessment: (assessment: SubmissionAssessment) => void;
  onSubmitAttempt: () => void;
  scoring?: ScoringConfig;
}

/**
 * Collects submission signals from four independent sources (DOM intent, DOM submit,
 * network, navigation/confirmation) and maintains the current assessment.
 */
export class SubmissionDetector {
  private readonly signals: SubmissionSignal[] = [];
  private assessment: SubmissionAssessment;
  private lastClickAt: number | null = null;
  private lastSubmitEventAt: number | null = null;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private trackedFormSnapshot: { forms: number; submitControls: number } | null = null;
  private readonly detachers: (() => void)[] = [];
  /** The control an Apply/Submit click landed on, and what it said just before the click. */
  private clickedControl: HTMLElement | null = null;
  private clickedControlText: string | null = null;
  private clickedControlInfo: { text: string | null; tag: string | null; dom_path: string | null } | null = null;
  private buttonConfirmationSeen = false;
  /** Sanitized text captured once, if a submit was seen but never confirmed. */
  private contextExcerpt: string | null = null;

  constructor(
    private readonly deps: SubmissionDetectorDeps,
    private readonly doc: Document = document,
  ) {
    this.assessment = scoreSignals([], this.scoring());
  }

  private scoring(): ScoringConfig {
    return this.deps.scoring ?? DEFAULT_SCORING;
  }

  private ctx(): AdapterContext {
    return adapterManager.contextFor(this.doc);
  }

  start(): void {
    const on = <K extends keyof DocumentEventMap>(type: K, handler: (e: DocumentEventMap[K]) => void) => {
      const wrapped = (e: Event) => {
        try {
          handler(e as DocumentEventMap[K]);
        } catch (err) {
          log.warn(`submission handler ${type} failed`, err);
        }
      };
      this.doc.addEventListener(type, wrapped, { capture: true, passive: true });
      this.detachers.push(() => this.doc.removeEventListener(type, wrapped, { capture: true }));
    };

    on('click', (e) => this.onDomEvent(e));
    on('submit', (e) => this.onDomEvent(e));
    // Keyboard submit (Enter in a single-input form) never produces a click.
    on('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('form') === null) return;
      if (target instanceof HTMLTextAreaElement) return;
      this.record({
        kind: 'submit_button_clicked',
        signal_class: 'dom_intent',
        timestamp: nowIso(),
        monotonic_ms: monotonicMs(),
        detail: 'Enter pressed inside a form (implicit submission intent)',
      });
    });

    this.snapshotForms();
  }

  stop(): void {
    for (const off of this.detachers) off();
    this.detachers.length = 0;
    if (this.clickTimer !== null) clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }

  // ---- signal sources -----------------------------------------------------

  /** Signal A: DOM submit intent / native form submission. */
  onDomEvent(event: Event): void {
    const adapter = this.deps.adapter();
    const signal = adapterManager.safeCall(
      adapter,
      'detectSubmission',
      (a) => a.detectSubmission(event, this.ctx()),
      null,
    );
    if (!signal) return;

    if (signal.kind === 'submit_button_clicked') {
      this.lastClickAt = monotonicMs();
      this.armClickWatchdog();
      this.captureClickedControl(event);
      this.deps.buffer.emit('submit_button_click', {
        metadata: { detail: signal.detail, ...(signal.context ?? {}) },
        dedupe_key: 'submit_click',
      });
      this.deps.onSubmitAttempt();
    } else if (signal.kind === 'form_submit_event') {
      this.lastSubmitEventAt = monotonicMs();
      this.deps.buffer.emit('form_submit', {
        metadata: { detail: signal.detail, ...(signal.context ?? {}) },
        dedupe_key: 'form_submit',
      });
      this.deps.onSubmitAttempt();
    }

    this.record(signal);
  }

  /**
   * Signal B: network activity.
   *
   * A request only counts when the adapter/heuristics call it submission-shaped, OR
   * when it is temporally correlated with an observed submit intent — a POST fired ten
   * minutes after a click is not evidence of that click.
   */
  onNetworkRequest(meta: NetworkRequestMeta): void {
    const cfg = getConfig().session;
    const now = monotonicMs();
    const correlated =
      (this.lastClickAt !== null && now - this.lastClickAt <= cfg.submit_correlation_window_ms) ||
      (this.lastSubmitEventAt !== null && now - this.lastSubmitEventAt <= cfg.submit_correlation_window_ms);

    if (!meta.looks_like_submission && !correlated) return;

    const reasons = [...meta.reasons];
    if (correlated) reasons.push('correlated_with_submit_intent');

    this.deps.buffer.emit('network_request', {
      metadata: { ...meta, reasons },
      dedupe_key: `net:${meta.method}:${meta.url}:${meta.status ?? 'pending'}`,
    });

    const base = {
      timestamp: nowIso(),
      monotonic_ms: now,
      context: {
        method: meta.method,
        url: meta.url,
        status: meta.status,
        transport: meta.transport,
        reasons,
      },
    };

    if (meta.status !== null && meta.status >= 200 && meta.status < 300) {
      this.record({
        ...base,
        kind: 'submission_request_success',
        signal_class: 'network',
        detail: `${meta.method} ${meta.url} responded ${meta.status}`,
      });
    } else if (meta.status !== null && meta.status >= 400) {
      this.record({
        ...base,
        kind: 'submission_request_failed',
        signal_class: 'negative',
        detail: `${meta.method} ${meta.url} responded ${meta.status}`,
      });
    } else {
      this.record({
        ...base,
        kind: 'submission_request',
        signal_class: 'network',
        detail: `${meta.method} ${meta.url} (no status observed)`,
      });
    }
  }

  /** Signal C: navigation to a confirmation route. */
  onNavigation(page: PageRecord): void {
    if (page.page_type !== 'confirmation') return;
    this.deps.buffer.emit('navigation_confirmation', {
      metadata: { path: page.path, page_type: page.page_type, entry_point: page.entry_point },
      dedupe_key: `nav_confirm:${page.path}`,
    });
    this.record({
      kind: 'confirmation_navigation',
      signal_class: 'navigation',
      timestamp: nowIso(),
      monotonic_ms: monotonicMs(),
      detail: `navigated to a confirmation page (${page.path})`,
      context: { page_id: page.page_id },
    });
  }

  /** Signal D: DOM confirmation — text, toast, modal, a portal-specific rule, or the
   * clicked control's own label changing (many "easy apply" flows show nothing else). */
  checkConfirmation(): boolean {
    const adapter = this.deps.adapter();
    const confirmation =
      adapterManager.safeCall(adapter, 'detectConfirmation', (a) => a.detectConfirmation(this.ctx()), null) ??
      this.detectButtonStateConfirmation();
    if (!confirmation) return false;

    this.deps.buffer.emit('dom_confirmation', {
      metadata: {
        matcher: confirmation.kind,
        excerpt: confirmation.excerpt ?? '',
        source: confirmation.kind === 'adapter_confirmation' ? 'adapter' : 'text',
        selector: confirmation.selector ?? null,
        detail: confirmation.detail,
      },
      dedupe_key: `confirm:${confirmation.kind}:${confirmation.selector ?? ''}`,
    });

    this.record({
      kind: confirmation.kind,
      signal_class: 'confirmation',
      timestamp: nowIso(),
      monotonic_ms: monotonicMs(),
      detail: confirmation.detail,
      context: { selector: confirmation.selector ?? null, excerpt: confirmation.excerpt ?? null },
    });
    return true;
  }

  /**
   * Diagnostic only, not scoring evidence: if a submit was detected but nothing ever
   * confirmed it, capture a sanitized text snapshot of the area around the clicked
   * control plus any status/alert regions on the page — so a reviewer looking at a
   * `flagged` session later has something to look at beyond "unconfirmed", without a
   * screenshot or any raw field value. Fires at most once per session, and only once
   * confirmation looks unlikely to still arrive (called after the page has had time to
   * settle) — not immediately on click, so it does not snapshot a transient "loading" state.
   */
  captureContext(): void {
    if (this.contextExcerpt !== null) return;
    if (!this.assessment.submit_detected || this.assessment.confirmation_detected) return;

    const parts: string[] = [];
    if (this.clickedControl?.isConnected) {
      const area =
        this.clickedControl.closest('form,[role="form"],section,article') ?? this.clickedControl.parentElement;
      const text = area?.textContent?.trim();
      if (text) parts.push(text);
    }

    let statusNodesSeen = 0;
    for (const node of this.doc.querySelectorAll<HTMLElement>('[role="status"],[role="alert"],[aria-live]')) {
      if (statusNodesSeen >= 4) break;
      const text = node.textContent?.trim();
      if (!text) continue;
      parts.push(text);
      statusNodesSeen++;
    }

    if (parts.length === 0) return;

    this.contextExcerpt = sanitizeText(parts.join(' | '), 300);
    this.assessment = { ...this.assessment, context_excerpt: this.contextExcerpt };
    this.deps.buffer.emit('submission_evaluated', {
      metadata: { context_excerpt: this.contextExcerpt, note: 'unconfirmed-submission context snapshot' },
    });
    this.deps.onAssessment(this.assessment);
  }

  /** Negative evidence: validation errors surfacing shortly after a submit attempt. */
  reportValidationErrors(meta: ValidationErrorMeta): void {
    const cfg = getConfig().session;
    const now = monotonicMs();
    const recentIntent =
      (this.lastClickAt !== null && now - this.lastClickAt <= cfg.validation_window_ms) ||
      (this.lastSubmitEventAt !== null && now - this.lastSubmitEventAt <= cfg.validation_window_ms);

    this.deps.buffer.emit('validation_error', {
      metadata: { ...meta, after_submit_attempt: recentIntent },
      dedupe_key: `validation:${meta.count}:${meta.fields.join(',')}`,
    });

    if (!recentIntent) return;
    this.record({
      kind: 'validation_error_after_submit',
      signal_class: 'negative',
      timestamp: nowIso(),
      monotonic_ms: now,
      detail: `${meta.count} validation error(s) appeared after a submit attempt`,
      context: { fields: meta.fields, excerpt: meta.excerpt },
    });
  }

  /** The form vanishing or being disabled after a submit attempt is weak positive evidence. */
  checkFormLifecycle(): void {
    const before = this.trackedFormSnapshot;
    const current = this.snapshotForms();
    if (!before) return;
    if (this.lastClickAt === null && this.lastSubmitEventAt === null) return;

    if (before.forms > 0 && current.forms === 0) {
      this.deps.buffer.emit('form_removed', {
        metadata: { previous_form_count: before.forms },
        dedupe_key: 'form_removed',
      });
      this.record({
        kind: 'form_removed',
        signal_class: 'dom_submit',
        timestamp: nowIso(),
        monotonic_ms: monotonicMs(),
        detail: 'the application form was removed from the DOM after a submit attempt',
      });
      return;
    }

    if (before.submitControls > 0 && current.submitControls === 0) {
      this.deps.buffer.emit('form_disabled', {
        metadata: { previous_submit_controls: before.submitControls },
        dedupe_key: 'form_disabled',
      });
      this.record({
        kind: 'form_disabled',
        signal_class: 'dom_submit',
        timestamp: nowIso(),
        monotonic_ms: monotonicMs(),
        detail: 'submit controls became unavailable after a submit attempt',
      });
    }
  }

  /** Remembers the clicked control and its pre-click label, so a later change is detectable. */
  private captureClickedControl(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const control = target.closest('button,[role="button"],input[type="submit"],a');
    if (!(control instanceof HTMLElement)) return;
    this.clickedControl = control;
    this.clickedControlText = controlText(control);
    this.clickedControlInfo = {
      text: this.clickedControlText || null,
      tag: control.tagName.toLowerCase(),
      dom_path: domPath(control),
    };
    this.buttonConfirmationSeen = false;
  }

  /**
   * Fallback confirmation source for "easy apply" flows: no toast, no modal, no
   * navigation — the button that was clicked just now says something like "Applied"
   * instead of "Apply". Fires at most once per click.
   */
  private detectButtonStateConfirmation(): {
    kind: 'application_status_changed';
    detail: string;
    excerpt: string;
    selector?: string;
  } | null {
    if (!this.clickedControl || this.buttonConfirmationSeen) return null;
    if (!this.clickedControl.isConnected) return null;

    const currentText = controlText(this.clickedControl);
    if (!currentText || currentText === this.clickedControlText) return null;
    if (!BUTTON_CONFIRMATION_TEXT.test(currentText)) return null;

    this.buttonConfirmationSeen = true;
    return {
      kind: 'application_status_changed',
      detail: `the clicked control's own label changed from "${this.clickedControlText ?? ''}" to "${currentText}"`,
      excerpt: currentText,
    };
  }

  private snapshotForms(): { forms: number; submitControls: number } {
    const forms = this.doc.querySelectorAll('form').length;
    const submitControls = findSubmitControls(this.doc).filter((el) => !isDisabled(el)).length;
    const snapshot = { forms, submitControls };
    this.trackedFormSnapshot = snapshot;
    return snapshot;
  }

  /**
   * If a click produces nothing within the correlation window, that silence is itself
   * evidence — recorded as a negative signal rather than left implicit.
   */
  private armClickWatchdog(): void {
    if (this.clickTimer !== null) clearTimeout(this.clickTimer);
    const window = getConfig().session.submit_correlation_window_ms;
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      const current = this.assessment;
      if (current.submit_detected) return;
      if (this.doc.querySelector('form') === null) return;
      this.record({
        kind: 'form_still_present',
        signal_class: 'negative',
        timestamp: nowIso(),
        monotonic_ms: monotonicMs(),
        detail: `no submission signal followed the click within ${window}ms and the form is still displayed`,
      });
    }, window);
  }

  // ---- assessment ---------------------------------------------------------

  record(signal: SubmissionSignal): SubmissionAssessment {
    this.signals.push(signal);
    return this.evaluate();
  }

  evaluate(): SubmissionAssessment {
    const previous = this.assessment;
    this.assessment = scoreSignals(this.signals, this.scoring());
    this.assessment.context_excerpt = this.contextExcerpt;
    this.assessment.clicked_control = this.clickedControlInfo;

    const changed =
      previous.state !== this.assessment.state ||
      previous.confidence_score !== this.assessment.confidence_score;

    if (changed) {
      this.deps.buffer.emit('submission_evaluated', {
        metadata: {
          state: this.assessment.state,
          confidence_score: this.assessment.confidence_score,
          evidence: this.assessment.evidence.map((e) => ({ kind: e.kind, weight: e.weight, counted: e.counted })),
          negative_evidence: this.assessment.negative_evidence.map((e) => ({ kind: e.kind, weight: e.weight })),
          notes: this.assessment.notes,
        },
      });
      this.deps.onAssessment(this.assessment);
      log.debug('assessment', this.assessment.state, this.assessment.confidence_score);
    }
    return this.assessment;
  }

  current(): SubmissionAssessment {
    return this.assessment;
  }

  allSignals(): readonly SubmissionSignal[] {
    return this.signals;
  }

  /** Age of the most recent submit intent, or null when none was observed. */
  msSinceSubmitIntent(): number | null {
    const at = Math.max(this.lastClickAt ?? -1, this.lastSubmitEventAt ?? -1);
    if (at < 0) return null;
    return monotonicMs() - at;
  }
}

/** Scans for visible validation errors. Bounded, and returns canonical names only. */
export function collectValidationErrors(doc: Document = document): ValidationErrorMeta | null {
  const selectors = getConfig().confirmation.error_selectors;
  const seen = new Set<Element>();
  let excerpt: string | null = null;

  for (const selector of selectors) {
    let nodes: NodeListOf<HTMLElement>;
    try {
      nodes = doc.querySelectorAll<HTMLElement>(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (seen.has(node)) continue;
      // A hidden node matching an "error" class is a template, not a rendered error —
      // React error-boundary fallbacks and similar hold real, non-empty text in the DOM
      // at all times, just never shown. A real observed session had this fire on a
      // GitHub tab the candidate opened mid-application (to copy their profile URL):
      // GitHub's own always-present, hidden error-boundary text ("Uh oh! There was an
      // error while loading...") was picked up as validation-error evidence against the
      // job application entirely unrelated to it.
      if (!isVisible(node)) continue;
      let text = (node.textContent ?? '').trim();
      // `aria-invalid="true"` sits on the control itself (an <input> has no rendered
      // text of its own), and plenty of libraries (MUI, React Hook Form, Formik) set it
      // the moment a required field is empty, whether or not anything is shown to the
      // user — that flag alone was firing false validation-error evidence on ordinary,
      // successful submissions. What actually tells the user something is wrong is the
      // linked accessible description, so look there instead of trusting the flag blind.
      if (!text && node.getAttribute('aria-invalid') === 'true') text = describedByText(node, doc);
      // An empty error container is a template, not a rendered error.
      if (!text) continue;
      seen.add(node);
      if (!excerpt) excerpt = sanitizeText(text);
      if (seen.size > 50) break;
    }
  }

  if (seen.size === 0) return null;
  return { count: seen.size, fields: [], excerpt };
}

/** Resolves the text of the element(s) an `aria-invalid` control points to via
 *  `aria-describedby` — the accessible name for whatever message is actually shown. */
function describedByText(node: Element, doc: Document): string {
  const ids = (node.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const text = (doc.getElementById(id)?.textContent ?? '').trim();
    if (text) return text;
  }
  return '';
}
