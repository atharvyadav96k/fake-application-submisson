import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tooManyRequests } from '../utils/errors.js';

/**
 * Fixed-window, in-memory rate limiter.
 *
 * Deliberately simple and per-instance: it exists to stop a looping client from
 * saturating this process, not to enforce a fleet-wide quota. Behind more than one
 * instance, put a shared limiter at the edge.
 *
 * Buckets are keyed by token when present, so several operators behind one NAT are not
 * limited as a single client.
 */
export function createRateLimiter(windowMs: number, maxRequests: number): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  // Bounded sweep: without it the map grows with every distinct key ever seen.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs).unref();
  void sweep;

  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header('authorization') ?? '';
    const key = auth ? `t:${auth.slice(-24)}` : `ip:${req.ip ?? 'unknown'}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, maxRequests - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      next(tooManyRequests());
      return;
    }

    next();
  };
}
