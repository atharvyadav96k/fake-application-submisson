import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { HttpError, notFound } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('error');

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

/**
 * Terminal error handler.
 *
 * Clients get a stable `code` and a safe message; the stack and any driver detail stay
 * in the logs. Infrastructure failures are mapped to 503 with `retryable: true` so the
 * extension keeps its events queued and replays them, rather than treating the failure
 * as a permanent rejection and dropping evidence.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = req.requestId;

  if (err instanceof HttpError) {
    if (err.status >= 500) log.error(err.message, { request_id: requestId, code: err.code });
    res.status(err.status).json({ ...err.toBody(requestId), retryable: err.retryable });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'The request body did not match the expected schema.',
        details: err.issues.slice(0, 25).map((i) => ({ path: i.path.join('.'), message: i.message })),
        request_id: requestId,
      },
      retryable: false,
    });
    return;
  }

  // Body-parser errors: malformed JSON and oversized payloads.
  const asHttp = err as { type?: string; status?: number; message?: string };
  if (asHttp?.type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body exceeds the configured limit.', request_id: requestId },
      retryable: false,
    });
    return;
  }
  if (asHttp?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'invalid_json', message: 'Request body is not valid JSON.', request_id: requestId },
      retryable: false,
    });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      error: { code: 'validation_failed', message: 'Document validation failed.', request_id: requestId },
      retryable: false,
    });
    return;
  }

  // Database unavailable: retryable, so the client keeps its queue rather than dropping it.
  // `MongoNotConnectedError` is what surfaces with bufferCommands disabled — the driver
  // fails the operation immediately instead of queueing it until a timeout.
  if (
    err instanceof mongoose.Error.MongooseServerSelectionError ||
    (err as { name?: string })?.name === 'MongoNotConnectedError' ||
    (err instanceof Error &&
      /buffering timed out|before initial connection is complete|must be connected|topology|ECONNREFUSED|no primary|not connected/i.test(
        err.message,
      ))
  ) {
    log.error('database unavailable', { request_id: requestId, message: (err as Error).message });
    res.status(503).json({
      error: { code: 'database_unavailable', message: 'Storage is temporarily unavailable.', request_id: requestId },
      retryable: true,
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled error', {
    request_id: requestId,
    message,
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });

  res.status(500).json({
    error: { code: 'internal_error', message: 'An unexpected error occurred.', request_id: requestId },
    retryable: true,
  });
}

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  handler: T,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
