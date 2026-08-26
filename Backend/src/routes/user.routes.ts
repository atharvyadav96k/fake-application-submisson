import { Router, type RequestHandler } from 'express';
import { ChangePasswordSchema, SetUserActiveSchema, WhitelistAddSchema } from '../contract/schemas.js';
import { asyncHandler } from '../middleware/error-handler.js';
import {
  addToWhitelist,
  changePassword,
  getAccountById,
  listAccounts,
  listWhitelist,
  removeFromWhitelist,
  setUserActive,
} from '../services/account.service.js';
import { badRequest } from '../utils/errors.js';

/** User management (admin-only) and self-service profile/password (any authenticated role). */
export function userRoutes(requireJwt: (...roles: ('admin' | 'manager' | 'user')[]) => RequestHandler): Router {
  const router = Router();
  const admin = requireJwt('admin');
  const authed = requireJwt();

  router.get(
    '/',
    admin,
    asyncHandler(async (_req, res) => {
      res.json({ items: await listAccounts() });
    }),
  );

  router.patch(
    '/:id/status',
    admin,
    asyncHandler(async (req, res) => {
      const id = requireId(req.params.id);
      const input = SetUserActiveSchema.parse(req.body);
      res.json(await setUserActive(id, input.active));
    }),
  );

  router.get(
    '/whitelist',
    admin,
    asyncHandler(async (_req, res) => {
      res.json({ items: await listWhitelist() });
    }),
  );

  router.post(
    '/whitelist',
    admin,
    asyncHandler(async (req, res) => {
      const input = WhitelistAddSchema.parse(req.body);
      res.status(201).json(await addToWhitelist(input.email, input.role, req.user!.sub));
    }),
  );

  router.delete(
    '/whitelist/:email',
    admin,
    asyncHandler(async (req, res) => {
      await removeFromWhitelist(requireId(req.params.email));
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    authed,
    asyncHandler(async (req, res) => {
      res.json(await getAccountById(req.user!.sub));
    }),
  );

  router.patch(
    '/me/password',
    authed,
    asyncHandler(async (req, res) => {
      const input = ChangePasswordSchema.parse(req.body);
      await changePassword(req.user!.sub, input.old_password, input.new_password);
      res.status(204).end();
    }),
  );

  return router;
}

function requireId(value: string | undefined): string {
  if (!value) throw badRequest('id is required.');
  return value;
}
