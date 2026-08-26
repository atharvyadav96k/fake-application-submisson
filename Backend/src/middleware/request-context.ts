import type { NextFunction, Request, Response } from 'express';
import { uuid } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      /** Which credential class authenticated this request. */
      scope?: 'ingest' | 'admin';
    }
  }
}

/**
 * Assigns a request id and logs one line per completed request.
 *
 * Only the path template and status are logged — never query strings or bodies, which on
 * this service can carry session identifiers.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 128 ? incoming : uuid();
  res.setHeader('X-Request-Id', req.requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const fields = {
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
    };
    if (res.statusCode >= 500) log.error('request failed', fields);
    else if (res.statusCode >= 400) log.warn('request rejected', fields);
    else log.info('request', fields);
  });

  next();
}
