import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error-handler.js';
import { listIngestLog, replayIngestLogEntry } from '../services/ingest-log.service.js';
import { badRequest, notFound } from '../utils/errors.js';

/**
 * Admin-only view onto the raw ingest log — every `/v1/activity/events` and `/finalize`
 * request, kept regardless of whether it validated. Lets a reviewer see what a rejected
 * payload actually contained and, once the cause is fixed, replay it so the evidence
 * makes it into the archive rather than staying lost.
 */
export function ingestLogRoutes(requireAdmin: RequestHandler): Router {
  const router = Router();

  const ListQuerySchema = z.object({
    status: z.enum(['accepted', 'rejected']).optional(),
    route: z.enum(['events', 'finalize']).optional(),
    session_id: z.string().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get(
    '/',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const query = ListQuerySchema.parse(req.query);
      const result = await listIngestLog(query);
      res.json({ total: result.total, limit: query.limit, offset: query.offset, items: result.items });
    }),
  );

  router.post(
    '/:log_id/replay',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const logId = req.params.log_id;
      if (!logId) throw badRequest('log_id is required.');
      try {
        const result = await replayIngestLogEntry(logId);
        res.status(result.status === 'success' ? 200 : 422).json(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('No ingest log entry')) throw notFound(err.message);
        throw err;
      }
    }),
  );

  return router;
}
