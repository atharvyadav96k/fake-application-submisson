import { Router } from 'express';
import type { AppConfig } from '../config/env.js';
import { LoginSchema, SignupSchema } from '../contract/schemas.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { authenticate, signup } from '../services/account.service.js';
import { signAuthToken } from '../utils/jwt.js';
import { unauthorized } from '../utils/errors.js';

/**
 * Login/signup for the frontend and the browser extension alike.
 *
 * Both trade an email/password for the same per-user JWT (`Authorization: Bearer
 * <token>`), carrying `{sub, email, role, name}` — there is no more special-cased
 * "always hand back the shared ingest token" behavior; every client authenticates as a
 * real account. Deliberately the only unauthenticated endpoints outside `/health`.
 */
export function authRoutes(config: AppConfig): Router {
  const router = Router();

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const input = LoginSchema.parse(req.body);
      const account = await authenticate(input.email, input.password);
      if (!account) throw unauthorized('Incorrect email or password.');

      const token = signAuthToken(config, { sub: account.id, email: account.email, role: account.role, name: account.name });
      res.json({ token, role: account.role, email: account.email, name: account.name });
    }),
  );

  router.post(
    '/signup',
    asyncHandler(async (req, res) => {
      const input = SignupSchema.parse(req.body);
      const account = await signup(input.email, input.password, input.name);

      const token = signAuthToken(config, { sub: account.id, email: account.email, role: account.role, name: account.name });
      res.status(201).json({ token, role: account.role, email: account.email, name: account.name });
    }),
  );

  return router;
}
