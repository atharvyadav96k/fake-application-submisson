import { getConfig } from '@/common/config';
import type { ActivityEvent } from '@/models/event';
import { SCHEMA_VERSION } from '@/models/event';
import { uuid } from '@/utils/ids';
import { createLogger } from '@/utils/logger';
import { scrubObject } from '@/collector/utils/redaction';
import { monotonicMs, nowIso } from '@/utils/timestamps';
import { createDriver, KeyedMutex, type StorageDriver } from './local';

const log = createLogger('event-store');

const QUEUE_KEY = 'aav.queue';
const ARCHIVE_KEY = 'aav.archive';
const SEEN_KEY = 'aav.seen';

interface QueueFile {
  events: ActivityEvent[];
  /** event_id -> first-seen epoch ms, for dedupe. */
  seen: Record<string, number>;
  truncated_count: number;
}

/**
 * Durable, append-only event queue.
 *
 * Guarantees:
 * - append-only within a session: events are never mutated after being stored
 * - idempotent on `event_id`, plus a short-window dedupe on `dedupe_key`
 * - survives service-worker termination and browser restart
 * - a forced drop (cap reached) is itself recorded, so loss is never silent
 */
export class EventStore {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly driver: StorageDriver = createDriver('local')) {}

  private async read(): Promise<QueueFile> {
    const file = await this.driver.get<QueueFile>(QUEUE_KEY);
    return file ?? { events: [], seen: {}, truncated_count: 0 };
  }

  private async write(file: QueueFile): Promise<void> {
    await this.driver.set(QUEUE_KEY, file);
  }

  /** Appends events, dropping duplicates. Returns the number actually stored. */
  async append(events: ActivityEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    return this.mutex.run(QUEUE_KEY, async () => {
      const cfg = getConfig().buffering;
      const file = await this.read();
      const now = Date.now();

      // Expire old dedupe entries so the map cannot grow without bound.
      for (const [key, ts] of Object.entries(file.seen)) {
        if (now - ts > Math.max(cfg.dedupe_window_ms, 60_000)) delete file.seen[key];
      }

      let stored = 0;
      for (const raw of events) {
        const event = scrubObject(raw);
        if (file.seen[event.event_id] !== undefined) continue;
        if (event.dedupe_key) {
          const compound = `dk:${event.session_id}:${event.dedupe_key}`;
          const last = file.seen[compound];
          if (last !== undefined && now - last < cfg.dedupe_window_ms) continue;
          file.seen[compound] = now;
        }
        file.seen[event.event_id] = now;
        file.events.push(event);
        stored++;
      }

      // Cap enforcement: drop oldest, and record that we did.
      const overflow = file.events.length - cfg.max_stored_events;
      if (overflow > 0) {
        file.events.splice(0, overflow);
        file.truncated_count += overflow;
        const sessionId = file.events[0]?.session_id ?? events[0]?.session_id ?? 'unknown';
        file.events.push(this.truncationEvent(sessionId, overflow, file.truncated_count));
        log.warn('event queue truncated', overflow);
      }

      await this.write(file);
      return stored;
    });
  }

  private truncationEvent(sessionId: string, dropped: number, total: number): ActivityEvent {
    return {
      schema_version: SCHEMA_VERSION,
      event_id: uuid(),
      session_id: sessionId,
      timestamp: nowIso(),
      monotonic_ms: monotonicMs(),
      event_type: 'buffer_truncated',
      page: { domain: '', path: '', sanitized_url: '', title: '', frame: 'top' },
      metadata: { dropped, total_dropped: total, reason: 'max_stored_events' },
    };
  }

  /** Oldest-first slice for upload. Does not remove them — see `ack`. */
  async peek(limit = getConfig().api.max_batch_size): Promise<ActivityEvent[]> {
    const file = await this.read();
    return file.events.slice(0, limit);
  }

  /** Removes successfully uploaded events and archives them for the final payload. */
  async ack(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const idSet = new Set(eventIds);
    await this.mutex.run(QUEUE_KEY, async () => {
      const file = await this.read();
      const acked = file.events.filter((e) => idSet.has(e.event_id));
      file.events = file.events.filter((e) => !idSet.has(e.event_id));
      await this.write(file);
      await this.archive(acked);
    });
  }

  /**
   * Uploaded events are kept in a bounded archive so the finalize payload can carry the
   * full event list even after the queue has drained.
   */
  private async archive(events: ActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.mutex.run(ARCHIVE_KEY, async () => {
      const existing = (await this.driver.get<ActivityEvent[]>(ARCHIVE_KEY)) ?? [];
      const combined = existing.concat(events);
      const cap = getConfig().buffering.max_stored_events;
      await this.driver.set(ARCHIVE_KEY, combined.slice(Math.max(0, combined.length - cap)));
    });
  }

  async size(): Promise<number> {
    return (await this.read()).events.length;
  }

  /** Queue + archive, oldest first — the complete event list for a session payload. */
  async allForSession(sessionId: string): Promise<ActivityEvent[]> {
    const [file, archive] = await Promise.all([
      this.read(),
      this.driver.get<ActivityEvent[]>(ARCHIVE_KEY),
    ]);
    const merged = [...(archive ?? []), ...file.events].filter((e) => e.session_id === sessionId);
    const seen = new Set<string>();
    const out: ActivityEvent[] = [];
    for (const e of merged) {
      if (seen.has(e.event_id)) continue;
      seen.add(e.event_id);
      out.push(e);
    }
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.monotonic_ms - b.monotonic_ms);
    return out;
  }

  /** Drops everything belonging to a finished, fully uploaded session. */
  async purgeSession(sessionId: string): Promise<void> {
    await this.mutex.run(QUEUE_KEY, async () => {
      const file = await this.read();
      file.events = file.events.filter((e) => e.session_id !== sessionId);
      await this.write(file);
    });
    await this.mutex.run(ARCHIVE_KEY, async () => {
      const archive = (await this.driver.get<ActivityEvent[]>(ARCHIVE_KEY)) ?? [];
      await this.driver.set(
        ARCHIVE_KEY,
        archive.filter((e) => e.session_id !== sessionId),
      );
    });
  }

  async clear(): Promise<void> {
    await this.driver.remove(QUEUE_KEY);
    await this.driver.remove(ARCHIVE_KEY);
    await this.driver.remove(SEEN_KEY);
  }
}
