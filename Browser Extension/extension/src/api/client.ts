import { getConfig } from '@/common/config';
import type { ActivityEvent } from '@/models/event';
import { SCHEMA_VERSION } from '@/models/event';
import type { EnvironmentInfo, EventBatchPayload, SessionPayload } from '@/models/payload';
import type { CandidateRecord } from '@/models/session';
import { uuid } from '@/utils/ids';
import { createLogger } from '@/utils/logger';
import { scrubObject } from '@/collector/utils/redaction';
import { nowIso } from '@/utils/timestamps';
import { AuthStore } from '@/storage/auth-store';

const log = createLogger('api');

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  /** True when the failure is worth retrying (network error, 5xx, 429). */
  retryable: boolean;
}

/**
 * Backend client.
 *
 * Everything leaving the extension passes through `scrubObject` first, so even a bug in
 * an upstream component cannot upload a token-shaped value.
 */
export class ApiClient {
  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly authStore: AuthStore = new AuthStore(),
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const cfg = getConfig().api;
    let resolved = path;
    for (const [key, value] of Object.entries(params)) {
      resolved = resolved.replace(`{${key}}`, encodeURIComponent(value));
    }
    return `${cfg.base_url.replace(/\/+$/, '')}${resolved}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Schema-Version': SCHEMA_VERSION,
    };
    const auth = await this.authStore.get();
    if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
    return headers;
  }

  private async request<T>(method: string, url: string, body?: unknown, opts: { scrub?: boolean } = {}): Promise<ApiResult<T>> {
    const { scrub = true } = opts;
    const cfg = getConfig().api;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: await this.headers(),
        body: body === undefined ? undefined : JSON.stringify(scrub ? scrubObject(body) : body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });

      let data: T | null = null;
      try {
        data = (await response.json()) as T;
      } catch {
        data = null;
      }

      if (response.ok) return { ok: true, status: response.status, data, error: null, retryable: false };

      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        status: response.status,
        data,
        error: `HTTP ${response.status}`,
        retryable,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'network error';
      // Aborts and offline errors are always worth retrying.
      return { ok: false, status: 0, data: null, error: message, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendEvents(
    sessionId: string,
    events: ActivityEvent[],
    environment: EnvironmentInfo,
    attempt: number,
  ): Promise<ApiResult<{ accepted: string[] }>> {
    const payload: EventBatchPayload = {
      schema_version: SCHEMA_VERSION,
      session_id: sessionId,
      batch_id: uuid(),
      events,
      environment,
      sent_at: nowIso(),
      attempt,
    };
    return this.request('POST', this.url(getConfig().api.events_path), payload);
  }

  async finalizeSession(payload: SessionPayload): Promise<ApiResult<{ received: boolean }>> {
    return this.request(
      'POST',
      this.url(getConfig().api.finalize_path, { session_id: payload.session.session_id }),
      payload,
    );
  }

  /**
   * Fetches the candidate record used for local comparison.
   *
   * The response is expected to contain hashes for sensitive fields wherever the backend
   * can supply them; plaintext is only used in-page and never re-uploaded.
   */
  async fetchCandidate(sessionId: string): Promise<ApiResult<CandidateRecord>> {
    return this.request('GET', this.url(getConfig().api.candidate_path, { session_id: sessionId }));
  }

  /** The directory the popup's candidate picker lists — email and latest session status only. */
  async listCandidates(): Promise<
    ApiResult<{
      items: {
        candidate_id: string;
        email: string;
        state: string | null;
        outcome: string | null;
        attempt_count: number;
      }[];
    }>
  > {
    return this.request('GET', this.url(getConfig().api.candidates_path));
  }

  /** Picks a candidate by email and gets back a fresh session id, bound to them server-side. */
  async startSession(
    candidateEmail: string,
    operatorId: string | null,
    clientId?: string | null,
  ): Promise<ApiResult<{ session_id: string; candidate_id: string; email: string }>> {
    const body: Record<string, unknown> = {
      candidate_email: candidateEmail,
      operator_id: operatorId,
    };
    if (clientId) body.client_id = clientId;
    return this.request('POST', this.url(getConfig().api.start_session_path), body);
  }

  /**
   * Exchanges operator credentials for a JWT used on every subsequent request.
   *
   * Deliberately bypasses `scrubObject` (`scrub: false`) — that guard exists to stop
   * DOM-observed telemetry from ever carrying a password-shaped value, but it would
   * just as happily destroy a real password being sent to log in on purpose.
   */
  async login(
    email: string,
    password: string,
  ): Promise<ApiResult<{ token: string; role: string; email: string; name: string }>> {
    return this.request('POST', this.url(getConfig().api.login_path), { email, password }, { scrub: false });
  }

  /** The directory of clients an application can be attributed to. */
  async listClients(
    page = 1,
    limit = 100,
  ): Promise<ApiResult<{ items: { id: string; name: string; contact_email: string }[]; total: number }>> {
    const base = getConfig().api.clients_path;
    const separator = base.includes('?') ? '&' : '?';
    return this.request(
      'GET',
      this.url(`${base}${separator}page=${encodeURIComponent(String(page))}&limit=${encodeURIComponent(String(limit))}`),
    );
  }
}

/** Exponential backoff with full jitter, bounded by config. */
export function backoffDelay(attempt: number): number {
  const cfg = getConfig().api;
  const exponential = Math.min(cfg.max_backoff_ms, cfg.base_backoff_ms * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}

export { log as apiLog };
