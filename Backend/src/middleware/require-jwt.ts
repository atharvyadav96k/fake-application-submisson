import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import { verifyAuthToken, type AuthTokenClaims } from '../utils/jwt.js';
import { forbidden, unauthorized } from '../utils/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The authenticated portal account, once `requireJwt` has run. */
      user?: AuthTokenClaims;
    }
  }
}

function extract(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Per-user JWT authentication for the frontend and extension.
 *
 * Distinct from `middleware/auth.ts`'s static ingest/admin bearer tokens, which remain
 * available unchanged for any server-to-server use. Pass one or more roles to restrict
 * the route further than "any authenticated account".
 */
export function createRequireJwt(config: AppConfig) {
  return function requireJwt(...allowedRoles: AuthTokenClaims['role'][]): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
      const token = extract(req);
      if (!token) {
        next(unauthorized('An Authorization: Bearer <token> header is required.'));
        return;
      }
      const claims = verifyAuthToken(config, token);
      if (!claims) {
        next(unauthorized('Invalid or expired token.'));
        return;
      }
      if (allowedRoles.length > 0 && !allowedRoles.includes(claims.role)) {
        next(forbidden(`This endpoint requires role: ${allowedRoles.join(' or ')}.`));
        return;
      }
      req.user = claims;
      next();
    };
  };
}
