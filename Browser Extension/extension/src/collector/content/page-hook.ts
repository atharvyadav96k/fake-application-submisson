/**
 * MAIN-world network observer.
 *
 * Runs in the page's own JS context so it can see requests the page makes, without the
 * extension holding the `webRequest` permission (which would expose traffic on every
 * site). It reports METADATA ONLY:
 *
 *   method, URL, status, duration, transport, request body *size*
 *
 * It never reads a request body, a response body, headers, or cookies, and it never
 * modifies a request. Failures are swallowed so a hook error can never break the portal.
 */

(() => {
  const CHANNEL = '__aav_page_hook__';
  const MARK = '__aav_hooked__';

  const w = window as unknown as Record<string, unknown>;
  if (w[MARK]) return;
  w[MARK] = true;

  function post(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ channel: CHANNEL, kind: 'network', payload }, window.location.origin);
    } catch {
      /* never let reporting break the page */
    }
  }

  /** Body size only — the body itself is not inspected. */
  function bodySize(body: unknown): number | null {
    try {
      if (body === null || body === undefined) return null;
      if (typeof body === 'string') return body.length;
      if (body instanceof Blob) return body.size;
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.toString().length;
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) return -1; // unknown size
      return null;
    } catch {
      return null;
    }
  }

  function absolute(url: string): string {
    try {
      return new URL(url, window.location.href).toString();
    } catch {
      return url;
    }
  }

  // ---- fetch --------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
      const started = Date.now();
      let method = 'GET';
      let url = '';
      let size: number | null = null;
      try {
        const [input, init] = args;
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.toString();
        else if (input && typeof input === 'object' && 'url' in input) {
          url = String((input as Request).url);
          method = (input as Request).method || 'GET';
        }
        if (init?.method) method = init.method;
        size = bodySize(init?.body);
      } catch {
        /* fall through with whatever we have */
      }

      const promise = originalFetch.apply(this as typeof globalThis, args);
      promise.then(
        (response) => {
          post({
            method: method.toUpperCase(),
            url: absolute(url),
            status: response.status,
            ok: response.ok,
            duration_ms: Date.now() - started,
            transport: 'fetch',
            request_body_bytes: size,
            started_at: started,
          });
        },
        () => {
          post({
            method: method.toUpperCase(),
            url: absolute(url),
            status: null,
            ok: false,
            duration_ms: Date.now() - started,
            transport: 'fetch',
            request_body_bytes: size,
            started_at: started,
          });
        },
      );
      return promise;
    } as typeof fetch;
  }

  // ---- XMLHttpRequest -----------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function') {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    const state = new WeakMap<XMLHttpRequest, { method: string; url: string; started: number }>();

    XHR.prototype.open = function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        state.set(this, { method: String(method).toUpperCase(), url: String(url), started: 0 });
      } catch {
        /* ignore */
      }
      return (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
    } as typeof XHR.prototype.open;

    XHR.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const entry = state.get(this);
      const size = bodySize(body);
      if (entry) {
        entry.started = Date.now();
        const report = () => {
          post({
            method: entry.method,
            url: absolute(entry.url),
            status: this.status || null,
            ok: this.status >= 200 && this.status < 300,
            duration_ms: Date.now() - entry.started,
            transport: 'xhr',
            request_body_bytes: size,
            started_at: entry.started,
          });
        };
        this.addEventListener('load', report, { once: true });
        this.addEventListener('error', report, { once: true });
        this.addEventListener('abort', report, { once: true });
      }
      return (originalSend as (...a: unknown[]) => void).apply(this, [body]);
    } as typeof XHR.prototype.send;
  }

  // ---- sendBeacon ---------------------------------------------------------
  const originalBeacon = navigator.sendBeacon;
  if (typeof originalBeacon === 'function') {
    navigator.sendBeacon = function patchedBeacon(this: Navigator, url: string | URL, data?: BodyInit | null) {
      const started = Date.now();
      const result = originalBeacon.call(this, url, data ?? null);
      post({
        method: 'POST',
        url: absolute(String(url)),
        status: null,
        ok: result,
        duration_ms: 0,
        transport: 'beacon',
        request_body_bytes: bodySize(data),
        started_at: started,
      });
      return result;
    } as typeof navigator.sendBeacon;
  }
})();
