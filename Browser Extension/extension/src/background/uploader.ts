import { ApiClient, backoffDelay } from '@/api/client';
import { getConfig } from '@/common/config';
import type { EventStore } from '@/storage/event-store';
import type { SessionStore } from '@/storage/session-store';
import { createLogger } from '@/utils/logger';
import { nowIso } from '@/utils/timestamps';
import { collectEnvironment } from './environment';
import { buildSessionPayload } from './payload-builder';

const log = createLogger('uploader');

export interface UploaderState {
  attempt: number;
  next_attempt_at: number | null;
  last_upload_at: string | null;
  last_error: string | null;
  in_flight: boolean;
}

/**
 * Drains the durable event queue to the backend.
 *
 * Failure policy: nothing is removed from the queue until the backend acknowledges it.
 * Retries use exponential backoff with jitter and survive service-worker restarts
 * because both the queue and the backoff state are persisted.
 */
export class Uploader {
  private state: UploaderState = {
    attempt: 0,
    next_attempt_at: null,
    last_upload_at: null,
    last_error: null,
    in_flight: false,
  };

  constructor(
    private readonly api: ApiClient,
    private readonly events: EventStore,
    private readonly sessions: SessionStore,
  ) {}

  getState(): UploaderState {
    return { ...this.state };
  }

  /** Uploads at most one batch. Returns true when something was uploaded. */
  async flush(force = false): Promise<boolean> {
    if (this.state.in_flight) return false;
    if (!force && this.state.next_attempt_at !== null && Date.now() < this.state.next_attempt_at) {
      return false;
    }

    const session = await this.sessions.get();
    if (!session) return false;

    const batch = await this.events.peek(getConfig().api.max_batch_size);
    if (batch.length === 0) {
      this.state.attempt = 0;
      this.state.next_attempt_at = null;
      return false;
    }

    this.state.in_flight = true;
    try {
      const attempt = this.state.attempt + 1;
      const result = await this.api.sendEvents(session.session_id, batch, collectEnvironment(), attempt);

      if (result.ok) {
        // Trust the server's accepted list when present; otherwise assume the whole batch.
        const accepted = result.data?.accepted?.length ? result.data.accepted : batch.map((e) => e.event_id);
        await this.events.ack(accepted);
        this.state.attempt = 0;
        this.state.next_attempt_at = null;
        this.state.last_upload_at = nowIso();
        this.state.last_error = null;
        log.debug('uploaded', accepted.length, 'events');
        return true;
      }

      this.state.last_error = result.error;
      if (result.retryable) {
        this.state.attempt = attempt;
        this.state.next_attempt_at = Date.now() + backoffDelay(attempt);
        log.warn('upload failed, will retry', result.error);
      } else {
        // A 4xx means the backend rejected the shape, not the network. Retrying the
        // same payload forever would block the queue, so drop this batch — but record
        // that we did, because silent loss is worse than visible loss.
        log.error('upload rejected, dropping batch', result.status, result.error);
        await this.events.ack(batch.map((e) => e.event_id));
        this.state.attempt = 0;
        this.state.next_attempt_at = null;
      }
      return false;
    } finally {
      this.state.in_flight = false;
    }
  }

  /** Drains the queue, bounded by `maxBatches` so a flush cannot run unbounded. */
  async drain(maxBatches = 20): Promise<number> {
    let uploaded = 0;
    for (let i = 0; i < maxBatches; i++) {
      const sent = await this.flush(i === 0);
      if (!sent) break;
      uploaded++;
    }
    return uploaded;
  }

  /**
   * Sends the complete session payload. The queue is drained first so the payload's
   * event list and the streamed events agree.
   */
  async finalize(): Promise<boolean> {
    await this.drain();
    const payload = await buildSessionPayload(this.sessions, this.events, { partial: false });
    if (!payload) return false;

    const result = await this.api.finalizeSession(payload);
    if (result.ok) {
      log.info('session finalized', payload.session.session_id, payload.session.outcome);
      await this.events.purgeSession(payload.session.session_id);
      this.state.last_upload_at = nowIso();
      this.state.last_error = null;
      return true;
    }

    this.state.last_error = result.error;
    log.warn('finalize failed; session data is retained for retry', result.error);
    return false;
  }
}
