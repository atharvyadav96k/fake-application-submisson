import { Router, type RequestHandler } from 'express';
import { ApplicationListQuerySchema, ManualApplicationSchema, VerifyApplicationSchema } from '../contract/schemas.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { createManualApplication, listApplications, verifyApplication } from '../services/application.service.js';
import { badRequest } from '../utils/errors.js';

/**
 * "Applications" as the frontend sees them — a view over `Session` (see
 * `application.service.ts`) plus the manual-log/verify workflow that has no analog in
 * the extension's automatic observation flow.
 */
export function applicationRoutes(requireJwt: (...roles: ('admin' | 'manager' | 'user')[]) => RequestHandler): Router {
  const router = Router();

  router.get(
    '/',
    requireJwt(),
    asyncHandler(async (req, res) => {
      const { page, limit } = ApplicationListQuerySchema.parse(req.query);
      res.json(await listApplications({ id: req.user!.sub, role: req.user!.role }, page, limit));
    }),
  );

  router.post(
    '/manual',
    requireJwt(),
    asyncHandler(async (req, res) => {
      const input = ManualApplicationSchema.parse(req.body);
      res.status(201).json(await createManualApplication(input, { id: req.user!.sub }));
    }),
  );

  router.post(
    '/:id/verify',
    requireJwt('admin', 'manager'),
    asyncHandler(async (req, res) => {
      const id = requireId(req.params.id);
      const input = VerifyApplicationSchema.parse(req.body);
      res.json(await verifyApplication(id, input.trust_score, { id: req.user!.sub }));
    }),
  );

  return router;
}

function requireId(value: string | undefined): string {
  if (!value) throw badRequest('id is required.');
  return value;
}
