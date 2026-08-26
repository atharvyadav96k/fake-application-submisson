import { adapterManager } from '../adapters/adapter-manager';
import type { PortalAdapter } from '../adapters/types';
import { getConfig, setConfig } from '@/common/config';
import type { BackgroundToContent, ContentToBackground } from '@/common/messages';
import type { ActivityEvent } from '@/models/event';
import type { CandidateRecord, Session } from '@/models/session';
import { createLogger } from '@/utils/logger';
import { whenIdle } from '@/utils/text';
import { nowIso } from '@/utils/timestamps';
import { EventBuffer } from './event-buffer';
import { FieldTracker } from './field-tracker';
import { FormTracker, type DomChangeSummary } from './form-tracker';
import { hideCaptureIndicator, showCaptureIndicator } from './indicator';
import { NetworkBridge } from './network-bridge';
import { PageDetector, type PageTransition } from './page-detector';
import { collectValidationErrors, SubmissionDetector } from './submission-detector';

const log = createLogger('observer');

/**
 * Content-script orchestrator: owns lifecycle, wires the trackers together, and is the
 * only component that talks to the background service worker.
 */
export class Observer {
  private session: Session | null = null;
  private candidate: CandidateRecord | null = null;
  private adapter: PortalAdapter;

  private readonly buffer: EventBuffer;
  private readonly pageDetector: PageDetector;
  private readonly fieldTracker: FieldTracker;
  private readonly formTracker: FormTracker;
  private readonly submissionDetector: SubmissionDetector;
  private readonly networkBridge: NetworkBridge;

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Same-tab iframes (ad/tracking pixels, third-party widgets) are never the address bar
   *  the candidate is actually on — ambient DOM scanning stays top-frame-only so an
   *  unrelated iframe's markup can never inject false confirmation or validation-error
   *  evidence into the shared session. Field-tracking and click/submit detection still
   *  run in iframes, for the (rarer) case of a portal that genuinely embeds its form. */
  private readonly isTopFrame: boolean;

  constructor(
    private readonly win: Window = window,
    private readonly send: (message: ContentToBackground) => Promise<unknown> = defaultSend,
  ) {
    const doc = win.document;
    this.isTopFrame = win.top === win.self;
    this.adapter = adapterManager.select(new URL(win.location.href));

    this.buffer = new EventBuffer(
      () => this.session?.session_id ?? null,
      () => this.pageDetector.context(),
      (events) => this.dispatchEvents(events),
    );

    this.pageDetector = new PageDetector(win);

    this.fieldTracker = new FieldTracker(
      {
        buffer: this.buffer,
        adapter: () => this.adapter,
        candidate: () => this.candidate,
        salt: () => this.session?.hash_salt ?? '',
        onFirstFill: (at) => this.onFirstFill(at),
        onSnapshot: (fields) => {
          if (!this.session) return;
          void this.send({ type: 'FIELD_SNAPSHOT', session_id: this.session.session_id, fields });
        },
      },
      doc,
    );

    this.submissionDetector = new SubmissionDetector(
      {
        buffer: this.buffer,
        adapter: () => this.adapter,
        onAssessment: (assessment) => {
          if (!this.session) return;
          void this.send({ type: 'SUBMISSION_UPDATE', session_id: this.session.session_id, assessment });
        },
        onSubmitAttempt: () => {
          this.fieldTracker.markSkipped('submit_attempt');
          this.fieldTracker.forceSnapshot();
          // Give the page a beat to render errors or a confirmation, then look.
          setTimeout(() => this.inspectOutcome(), 400);
          setTimeout(() => this.inspectOutcome(), 1500);
          // By 3s, if nothing confirmed it, capture a diagnostic snapshot for reviewers —
          // later than the confirmation checks so it doesn't grab a transient "loading" state.
          setTimeout(() => this.submissionDetector.captureContext(), 3000);
        },
      },
      doc,
    );

    this.formTracker = new FormTracker((summary) => this.onDomChange(summary), doc);

    this.networkBridge = new NetworkBridge(
      (meta) => this.submissionDetector.onNetworkRequest(meta),
      (meta) =>
        adapterManager.safeCall<'classifyNetwork', boolean | null>(
          this.adapter,
          'classifyNetwork',
          (a) => a.classifyNetwork?.(meta, adapterManager.contextFor(doc)) ?? null,
          null,
        ),
      win,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;

    const context = (await this.send({ type: 'REQUEST_CONTEXT', url: this.win.location.href })) as
      | BackgroundToContent
      | undefined;

    if (!context || context.type !== 'CONTEXT' || !context.session) {
      log.debug('no active session; observer stays idle');
      return;
    }
    if (context.config_override) setConfig(context.config_override as never);

    this.session = context.session;
    this.candidate = context.candidate;

    if (!this.isAllowedOrigin()) {
      log.warn('origin is not in the configured allow-list; not collecting');
      return;
    }
    if (this.session.state !== 'active') {
      log.debug('session is not active; observer stays idle');
      return;
    }

    this.running = true;
    showCaptureIndicator(this.win.document);

    // Network bridge first, so a submission triggered during startup is not missed.
    this.networkBridge.start();

    const initial = this.pageDetector.start((t) => this.onPageTransition(t));
    this.adapter = initial.adapter;

    this.buffer.emit('session_resumed', {
      metadata: {
        adapter: this.adapter.name,
        adapter_kind: this.adapter.kind,
        page_type: initial.page_type,
      },
    });
    this.emitPageView(initial);

    this.fieldTracker.start();
    this.submissionDetector.start();
    if (this.isTopFrame) this.formTracker.start();

    // A confirmation page reached by a full top-level navigation (not an in-page SPA
    // route change) gets a brand-new Observer with no memory of any earlier submit
    // attempt — nothing would ever call checkConfirmation() on it otherwise. Check the
    // page we just landed on immediately, in case it already *is* the confirmation.
    // Iframe-only: never let a same-tab third-party iframe (ads, trackers) declare the
    // session confirmed off its own unrelated markup.
    if (this.isTopFrame) this.submissionDetector.checkConfirmation();

    // Slow reconciliation loop: catches programmatic fills and detached controls
    // without any continuous DOM scanning.
    this.reconcileTimer = setInterval(() => {
      whenIdle(() => {
        this.fieldTracker.reconcileValues();
        this.fieldTracker.reconcileDetached();
        if (this.isTopFrame) {
          this.submissionDetector.checkFormLifecycle();
          this.submissionDetector.checkConfirmation();
          this.submissionDetector.captureContext();
        }
      });
    }, 4000);

    this.installLifecycleHooks();
    void this.send({
      type: 'CONTENT_READY',
      url: this.win.location.href,
      adapter_name: this.adapter.name,
      adapter_kind: this.adapter.kind,
    });
    log.info('observer running with adapter', this.adapter.name);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    hideCaptureIndicator(this.win.document);
    this.formTracker.flushNow();
    this.fieldTracker.markSkipped('session_end');
    this.fieldTracker.forceSnapshot();
    this.pushPageSnapshot();
    this.fieldTracker.stop();
    this.submissionDetector.stop();
    this.formTracker.stop();
    this.pageDetector.stop();
    this.networkBridge.stop();
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.buffer.dispose();
  }

  private isAllowedOrigin(): boolean {
    const allowed = getConfig().allowed_origins;
    if (allowed.length === 0) return true;
    return allowed.some((origin) => this.win.location.origin === origin);
  }

  private installLifecycleHooks(): void {
    const onHide = () => {
      this.formTracker.flushNow();
      this.fieldTracker.forceSnapshot();
      this.pushPageSnapshot();
      this.buffer.flushSync();
    };
    this.win.addEventListener('pagehide', onHide);
    this.win.addEventListener('beforeunload', onHide);
    this.win.document.addEventListener('visibilitychange', () => {
      if (this.win.document.visibilityState === 'hidden') onHide();
    });
  }

  // ---- wiring -------------------------------------------------------------

  private onPageTransition(transition: PageTransition): void {
    this.adapter = transition.adapter;
    adapterManager.safeCall(
      this.adapter,
      'onNavigate',
      (a) => a.onNavigate?.(adapterManager.contextFor(this.win.document)),
      undefined,
    );

    this.buffer.emit('page_transition', {
      metadata: {
        kind: transition.kind,
        path_changed: transition.path_changed,
        from_path: transition.from?.path ?? null,
        to_path: transition.to.path,
        page_type: transition.page_type,
        adapter: this.adapter.name,
      },
    });
    this.emitPageView(transition);

    // A route change in an SPA re-renders the form: re-scan and re-evaluate.
    whenIdle(() => {
      this.fieldTracker.scan(this.win.document);
      this.fieldTracker.reconcileDetached();
      this.submissionDetector.onNavigation(transition.to);
      this.inspectOutcome();
    });
    this.pushPageSnapshot();
  }

  private emitPageView(transition: PageTransition): void {
    this.buffer.emit('page_view', {
      metadata: {
        page_id: transition.to.page_id,
        page_type: transition.page_type,
        entry_point: transition.to.entry_point,
        referrer: transition.to.referrer,
        adapter: this.adapter.name,
        adapter_kind: this.adapter.kind,
        title: transition.to.title,
      },
      dedupe_key: `page_view:${transition.to.page_id}`,
    });

    if (transition.page_type === 'candidate_record') {
      this.buffer.emit('candidate_record_opened', {
        metadata: { path: transition.to.path, source: 'page_type' },
        dedupe_key: 'candidate_record_opened',
      });
    }
  }

  private onDomChange(summary: DomChangeSummary): void {
    whenIdle(() => {
      for (const root of summary.addedRoots) this.fieldTracker.scan(root);
      if (summary.removedControls) {
        this.fieldTracker.reconcileDetached();
        this.submissionDetector.checkFormLifecycle();
      }
      if (summary.formStructureChanged) this.submissionDetector.checkFormLifecycle();
      if (summary.possibleConfirmation || summary.possibleValidationError || summary.formStructureChanged) {
        this.inspectOutcome();
      }
    });
  }

  /** Looks for confirmation and validation evidence in the current DOM. Top-frame-only:
   *  a same-tab iframe's own markup (an ad, a tracker, a chat widget) is never evidence
   *  about the application the candidate is actually filling. */
  private inspectOutcome(): void {
    if (!this.running || !this.isTopFrame) return;
    this.submissionDetector.checkConfirmation();
    const errors = collectValidationErrors(this.win.document);
    if (errors) this.submissionDetector.reportValidationErrors(errors);
  }

  private onFirstFill(at: string): void {
    if (!this.session) return;
    if (this.session.timestamps.first_field_fill_at) return;
    this.session.timestamps.first_field_fill_at = at;
    this.session.timestamps.first_fill = at;
    this.buffer.emit('field_fill', {
      metadata: { note: 'first fill of the session', at },
      dedupe_key: 'first_fill',
    });
  }

  private pushPageSnapshot(): void {
    if (!this.session) return;
    void this.send({ type: 'PAGE_SNAPSHOT', session_id: this.session.session_id, pages: this.pageDetector.allPages() });
  }

  private async dispatchEvents(events: ActivityEvent[]): Promise<void> {
    if (!this.session) return;
    await this.send({ type: 'EVENT_BATCH', session_id: this.session.session_id, events });
  }

  /** Handles pause/resume/flush pushed from the background. */
  handleBackgroundMessage(message: BackgroundToContent): void {
    switch (message.type) {
      case 'SESSION_PAUSED':
        this.buffer.emit('session_paused', { metadata: { at: nowIso() } });
        this.stop();
        break;
      case 'SESSION_RESUMED':
        void this.start();
        break;
      case 'FLUSH_NOW':
        this.formTracker.flushNow();
        void this.buffer.flush();
        break;
      default:
        break;
    }
  }

  // Exposed for tests and for the popup's live view.
  debugState() {
    return {
      running: this.running,
      adapter: this.adapter.name,
      fields: this.fieldTracker.stats(),
      submission: this.submissionDetector.current(),
      pages: this.pageDetector.allPages().length,
      pending_events: this.buffer.pendingCount(),
    };
  }
}

async function defaultSend(message: ContentToBackground): Promise<unknown> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return undefined;
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    // The service worker may be asleep or the extension reloading; events stay buffered.
    log.debug('sendMessage failed', err);
    throw err;
  }
}
