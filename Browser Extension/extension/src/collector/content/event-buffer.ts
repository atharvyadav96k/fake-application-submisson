import { getConfig } from '@/common/config';
import type { ActivityEvent, EventFieldContext, EventPageContext, EventType } from '@/models/event';
import { SCHEMA_VERSION } from '@/models/event';
import { uuid } from '@/utils/ids';
import { createLogger } from '@/utils/logger';
import { scrubObject } from '../utils/redaction';
import { debounce } from '@/utils/text';
import { monotonicMs, nowIso } from '@/utils/timestamps';

const log = createLogger('event-buffer');

export interface EmitOptions {
  field?: EventFieldContext;
  metadata?: Record<string, unknown>;
  dedupe_key?: string;
}

export type EventSink = (events: ActivityEvent[]) => void | Promise<void>;

/**
 * In-page event buffer.
 *
 * Batches by time and count, dedupes within a short window, and flushes on page hide so
 * a tab close cannot lose the tail of a session. Events are immutable once created.
 */
export class EventBuffer {
  private queue: ActivityEvent[] = [];
  private readonly recentDedupe = new Map<string, number>();
  private flushing = false;
  private disposed = false;
  private readonly scheduleFlush: ReturnType<typeof debounce<[]>>;

  constructor(
    private readonly sessionId: () => string | null,
    private readonly pageContext: () => EventPageContext,
    private readonly sink: EventSink,
  ) {
    this.scheduleFlush = debounce(() => void this.flush(), getConfig().buffering.flush_interval_ms);
  }

  emit(type: EventType, options: EmitOptions = {}): ActivityEvent | null {
    if (this.disposed) return null;
    const sessionId = this.sessionId();
    if (!sessionId) return null;

    // The backend caps `dedupe_key` at 256 chars; a few call sites build theirs from a
    // full network request URL (`net:${method}:${url}:${status}`), which routinely blows
    // past that on real portals (query strings, tracking params). An oversized key used to
    // fail the whole batch/finalize's schema validation — silently dropping every event in
    // it, including the ones the operator actually cared about — so it's truncated here,
    // once, for every call site, rather than capping each dedupe_key string individually.
    const dedupeKey = options.dedupe_key ? options.dedupe_key.slice(0, 200) : undefined;

    if (dedupeKey) {
      const now = Date.now();
      const last = this.recentDedupe.get(dedupeKey);
      if (last !== undefined && now - last < getConfig().buffering.dedupe_window_ms) return null;
      this.recentDedupe.set(dedupeKey, now);
      if (this.recentDedupe.size > 500) this.pruneDedupe(now);
    }

    const event: ActivityEvent = {
      schema_version: SCHEMA_VERSION,
      event_id: uuid(),
      session_id: sessionId,
      timestamp: nowIso(),
      monotonic_ms: monotonicMs(),
      event_type: type,
      page: this.pageContext(),
      ...(options.field ? { field: options.field } : {}),
      metadata: scrubObject(options.metadata ?? {}),
      ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
    };

    this.queue.push(event);
    if (this.queue.length >= getConfig().buffering.flush_max_events) void this.flush();
    else this.scheduleFlush();
    return event;
  }

  private pruneDedupe(now: number): void {
    const window = getConfig().buffering.dedupe_window_ms;
    for (const [key, ts] of this.recentDedupe) {
      if (now - ts > window) this.recentDedupe.delete(key);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.sink(batch);
    } catch (err) {
      // Put the batch back at the front so ordering is preserved for the retry.
      this.queue = batch.concat(this.queue);
      log.warn('flush failed, retaining events', err);
    } finally {
      this.flushing = false;
    }
  }

  /** Synchronous best-effort flush for `pagehide`/`visibilitychange`. */
  flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      void this.sink(batch);
    } catch (err) {
      log.warn('sync flush failed', err);
    }
  }

  pendingCount(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.scheduleFlush.cancel();
    this.flushSync();
    this.disposed = true;
  }
}
