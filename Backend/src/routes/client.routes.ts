import { Router, type RequestHandler } from 'express';
import { ClientListQuerySchema, ClientUpsertSchema } from '../contract/schemas.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { createClient, deleteClient, getClient, listClients, updateClient } from '../services/client.service.js';
import { badRequest } from '../utils/errors.js';

/** Client CRUD. Readable and writable by any authenticated role. */
export function clientRoutes(requireJwt: (...roles: ('admin' | 'manager' | 'user')[]) => RequestHandler): Router {
  const router = Router();
  const authed = requireJwt();

  router.get(
    '/',
    authed,
    asyncHandler(async (req, res) => {
      const { page, limit } = ClientListQuerySchema.parse(req.query);
      res.json(await listClients(page, limit));
    }),
  );

  router.post(
    '/',
    authed,
    asyncHandler(async (req, res) => {
      const input = ClientUpsertSchema.parse(req.body);
      res.status(201).json(await createClient(input, req.user!.sub));
    }),
  );

  router.get(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      res.json(await getClient(requireId(req.params.id)));
    }),
  );

  router.put(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      const input = ClientUpsertSchema.parse(req.body);
      res.json(await updateClient(requireId(req.params.id), input));
    }),
  );

  router.delete(
    '/:id',
    authed,
    asyncHandler(async (req, res) => {
      await deleteClient(requireId(req.params.id));
      res.status(204).end();
    }),
  );

  return router;
}

function requireId(value: string | undefined): string {
  if (!value) throw badRequest('id is required.');
  return value;
}
