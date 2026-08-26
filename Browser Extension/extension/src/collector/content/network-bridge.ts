import { getConfig } from '@/common/config';
import { PAGE_HOOK_CHANNEL, type PageHookMessage } from '@/common/messages';
import type { NetworkRequestMeta } from '@/models/event';
import { createLogger } from '@/utils/logger';
import { sanitizeUrl } from '../utils/redaction';

const log = createLogger('network-bridge');

/**
 * Receives metadata from the MAIN-world hook, filters out noise, and classifies whether
 * a request looks like an application submission.
 *
 * Two hard rules:
 *  - only same-origin-ish, non-analytics traffic is considered at all;
 *  - nothing but metadata ever crosses this boundary (the hook has no body access).
 */
export class NetworkBridge {
  private listener: ((e: MessageEvent) => void) | null = null;

  constructor(
    private readonly onRequest: (meta: NetworkRequestMeta) => void,
    private readonly classify: (meta: { method: string; url: string; status: number | null; transport: NetworkRequestMeta['transport'] }) => boolean | null,
    private readonly win: Window = window,
  ) {}

  start(): void {
    if (this.listener) return;
    this.listener = (event: MessageEvent) => {
      // Only accept messages this window posted to itself.
      if (event.source !== this.win) return;
      const data = event.data as PageHookMessage | undefined;
      if (!data || data.channel !== PAGE_HOOK_CHANNEL || data.kind !== 'network') return;
      try {
        const meta = this.toMeta(data.payload);
        if (meta) this.onRequest(meta);
      } catch (err) {
        log.warn('failed to process network message', err);
      }
    };
    this.win.addEventListener('message', this.listener);
  }

  stop(): void {
    if (this.listener) this.win.removeEventListener('message', this.listener);
    this.listener = null;
  }

  private toMeta(payload: PageHookMessage['payload']): NetworkRequestMeta | null {
    const cfg = getConfig().network;
    let url: URL;
    try {
      url = new URL(payload.url, this.win.location.href);
    } catch {
      return null;
    }

    const path = url.pathname.toLowerCase();
    // Ignore telemetry outright — we must not build a picture of unrelated traffic.
    if (cfg.ignored_path_hints.some((hint) => path.includes(hint))) return null;

    const method = payload.method.toUpperCase();
    const sameOrigin = url.origin === this.win.location.origin;

    // Cross-origin GETs (fonts, images, CDN assets) carry no submission evidence.
    if (!sameOrigin && !cfg.submission_methods.includes(method)) return null;
    if (sameOrigin && !cfg.submission_methods.includes(method)) return null;

    const reasons: string[] = [];
    if (cfg.submission_methods.includes(method)) reasons.push(`method_${method.toLowerCase()}`);

    const adapterVerdict = this.classify({
      method,
      url: url.toString(),
      status: payload.status,
      transport: payload.transport,
    });

    let looksLikeSubmission: boolean;
    if (adapterVerdict === true) {
      looksLikeSubmission = true;
      reasons.push('adapter_match');
    } else if (adapterVerdict === false) {
      looksLikeSubmission = false;
      reasons.push('adapter_excluded');
    } else {
      const pathHit = cfg.submission_path_hints.find((hint) => path.includes(hint));
      looksLikeSubmission = pathHit !== undefined;
      if (pathHit) reasons.push(`path_${pathHit}`);
    }

    return {
      method,
      url: sanitizeUrl(url.toString()),
      origin_kind: sameOrigin ? 'same_origin' : 'cross_origin',
      status: payload.status,
      ok: payload.ok,
      duration_ms: payload.duration_ms,
      transport: payload.transport,
      looks_like_submission: looksLikeSubmission,
      reasons,
      request_body_bytes: payload.request_body_bytes,
    };
  }
}
