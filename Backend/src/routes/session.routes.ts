import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { GeminiClient } from '../ai/gemini.client.js';
import { SESSION_OUTCOMES, SESSION_STATES } from '../contract/vocabulary.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { analyseSession, listAnalyses } from '../services/analysis.service.js';
import {
  getSession,
  getSessionEvents,
  getSessionStatistics,
  listSessions,
} from '../services/session.service.js';
import { badRequest } from '../utils/errors.js';

/** Review API. Admin scope only — this is the read side of the whole archive. */
export function sessionRoutes(requireAdmin: RequestHandler, ai: GeminiClient): Router {
  const router = Router();

  const dateParam = z
    .string()
    .datetime()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined));

  const ListQuerySchema = z.object({
    outcome: z.enum(SESSION_OUTCOMES).optional(),
    state: z.enum(SESSION_STATES).optional(),
    portal_domain: z.string().max(255).optional(),
    candidate_id: z.string().max(128).optional(),
    operator_id: z.string().max(128).optional(),
    finalized: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    min_severity: z.enum(['info', 'warning', 'critical']).optional(),
    from: dateParam,
    to: dateParam,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get(
    '/',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const query = ListQuerySchema.parse(req.query);
      const result = await listSessions(query);
      res.json({
        total: result.total,
        limit: query.limit,
        offset: query.offset,
        items: result.items,
      });
    }),
  );

  router.get(
    '/statistics',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { from, to } = z.object({ from: dateParam, to: dateParam }).parse(req.query);
      res.json(await getSessionStatistics(from, to));
    }),
  );

  router.get(
    '/:session_id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = requireSessionId(req.params.session_id);
      res.json(await getSession(id));
    }),
  );

  const EventQuerySchema = z.object({
    event_type: z.string().max(64).optional(),
    from: dateParam,
    to: dateParam,
    limit: z.coerce.number().int().min(1).max(1_000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get(
    '/:session_id/events',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = requireSessionId(req.params.session_id);
      const query = EventQuerySchema.parse(req.query);
      const result = await getSessionEvents(id, query);
      res.json({ total: result.total, limit: query.limit, offset: query.offset, items: result.items });
    }),
  );

  /**
   * POST /v1/sessions/:id/analyze
   *
   * Runs the AI analysis. Results are cached against a fingerprint of the exact model
   * input, so repeated calls on an unchanged session cost nothing; `?force=true`
   * re-runs deliberately.
   */
  router.post(
    '/:session_id/analyze',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = requireSessionId(req.params.session_id);
      const force = req.query.force === 'true';
      const result = await analyseSession(id, ai, { force });
      res.status(result.cached ? 200 : 201).json(result);
    }),
  );

  router.get(
    '/:session_id/analyses',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = requireSessionId(req.params.session_id);
      const limit = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit ?? 20);
      res.json({ items: await listAnalyses(id, limit) });
    }),
  );

  return router;
}

function requireSessionId(value: string | undefined): string {
  if (!value) throw badRequest('session_id is required.');
  return value;
}
