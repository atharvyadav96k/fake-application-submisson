import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import { forbidden, unauthorized } from '../utils/errors.js';

/**
 * Bearer-token authentication with two scopes.
 *
 * `ingest` is what the extension holds: it may write evidence and read the candidate
 * record for its own session, and nothing else. `admin` is what a reviewer or dashboard
 * holds: it may read stored sessions and trigger analysis. An ingest token compromised
 * on an operator's machine therefore cannot enumerate the archive.
 */
export function createAuth(config: AppConfig) {
  const compare = (candidate: string, expected: string): boolean => {
    if (!expected) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    // Length must be compared separately; timingSafeEqual throws on a length mismatch.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  const extract = (req: Request): string | null => {
    const header = req.header('authorization');
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() ?? null;
  };

  const require = (scope: 'ingest' | 'admin'): RequestHandler => {
    return (req: Request, _res: Response, next: NextFunction) => {
      if (config.auth.disabled) {
        req.scope = scope;
        next();
        return;
      }

      const token = extract(req);
      if (!token) {
        next(unauthorized('An Authorization: Bearer <token> header is required.'));
        return;
      }

      // An admin token is accepted on ingest routes so one operational credential can
      // exercise the whole API; the reverse is never true.
      const isAdmin = compare(token, config.auth.adminToken);
      const isIngest = compare(token, config.auth.ingestToken);

      if (scope === 'admin' && !isAdmin) {
        next(isIngest ? forbidden('This endpoint requires an admin token.') : unauthorized());
        return;
      }
      if (scope === 'ingest' && !isIngest && !isAdmin) {
        next(unauthorized());
        return;
      }

      req.scope = isAdmin ? 'admin' : 'ingest';
      next();
    };
  };

  return { requireIngest: require('ingest'), requireAdmin: require('admin') };
}
