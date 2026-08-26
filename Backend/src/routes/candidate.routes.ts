import { Router, type RequestHandler } from 'express';
import { CandidateUpsertSchema, SessionBindingSchema, StartSessionSchema } from '../contract/schemas.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { bindSession, listCandidates, startSessionForEmail, upsertCandidate } from '../services/candidate.service.js';

/**
 * Candidate reference data, written by the ATS.
 *
 * `GET /` and `POST /start` are any-authenticated-role: the extension's logged-in user
 * picks a candidate by email and starts a session directly. Writing candidates and
 * arbitrary binding require `admin`/`manager`.
 */
export function candidateRoutes(requireAdmin: RequestHandler, requireAuthenticated: RequestHandler): Router {
  const router = Router();

  router.get(
    '/',
    requireAuthenticated,
    asyncHandler(async (_req, res) => {
      res.json({ items: await listCandidates() });
    }),
  );

  router.put(
    '/',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const input = CandidateUpsertSchema.parse(req.body);
      const record = await upsertCandidate(input);
      res.status(200).json(record);
    }),
  );

  /** Binds a session to a candidate before the extension starts observing it. */
  router.post(
    '/bind',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const input = SessionBindingSchema.parse(req.body);
      res.status(201).json(await bindSession(input));
    }),
  );

  /** Pick a candidate by email, get back a session id — from the frontend or the extension. */
  router.post(
    '/start',
    requireAuthenticated,
    asyncHandler(async (req, res) => {
      const input = StartSessionSchema.parse(req.body);
      res.status(201).json(await startSessionForEmail(input, { id: req.user!.sub }));
    }),
  );

  return router;
}
