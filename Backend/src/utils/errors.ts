/**
 * Typed HTTP errors.
 *
 * Every error that reaches a client goes through this type, so responses have one shape
 * and internal details never leak by accident.
 */

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    request_id?: string;
  };
}

export class HttpError extends Error {
  // Explicit fields rather than constructor parameter properties: Node's type-stripping
  // (`--experimental-strip-types`, used by `npm run dev`) cannot compile those.
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** True when a client may retry the same request unchanged. */
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, details?: unknown, retryable = false) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }

  toBody(requestId?: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Missing or invalid credentials') =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'Not permitted') => new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

export const payloadTooLarge = (message = 'Payload too large') =>
  new HttpError(413, 'payload_too_large', message);

export const unsupportedSchema = (message: string, details?: unknown) =>
  new HttpError(422, 'unsupported_schema_version', message, details);

export const tooManyRequests = (message = 'Rate limit exceeded') =>
  new HttpError(429, 'rate_limited', message, undefined, true);

export const internal = (message = 'Internal error', details?: unknown) =>
  new HttpError(500, 'internal_error', message, details, true);

export const serviceUnavailable = (message: string, details?: unknown) =>
  new HttpError(503, 'service_unavailable', message, details, true);
