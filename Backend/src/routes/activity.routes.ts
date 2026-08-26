import { Router, type RequestHandler } from 'express';
import type { GeminiClient } from '../ai/gemini.client.js';
import type { AppConfig } from '../config/env.js';
import { EventBatchSchema, SessionPayloadSchema } from '../contract/schemas.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireSchemaVersion } from '../middleware/schema-version.js';
import { analyseSession } from '../services/analysis.service.js';
import { getCandidateForSession } from '../services/candidate.service.js';
import { extractSessionId, recordIngest } from '../services/ingest-log.service.js';
import { finalizeSession, ingestEventBatch } from '../services/ingest.service.js';
import { badRequest } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('activity-routes');

/**
 * The extension-facing API. These three paths are the contract in DESIGN §2 and must not
 * change shape without a schema-version bump.
 */
export function activityRoutes(config: AppConfig, requireIngest: RequestHandler, ai: GeminiClient): Router {
  const router = Router();
  const schemaGate = requireSchemaVersion(config.ingest.supportedSchemaVersions);

  /**
   * POST /v1/activity/events
   *
   * Responds with the ids the client may drop. Anything omitted stays queued in the
   * browser and is retried — so partial acceptance is expressible, and a failure here
   * never silently loses evidence.
   */
  router.post(
    '/events',
    requireIngest,
    schemaGate,
    asyncHandler(async (req, res) => {
      let batch;
      try {
        batch = EventBatchSchema.parse(req.body);
      } catch (err) {
        await recordIngest({
          route: 'events',
          sessionId: extractSessionId(req.body),
          requestId: req.requestId,
          rawBody: req.body,
          status: 'rejected',
          error: err,
        });
        throw err;
      }

      if (batch.events.length > config.ingest.maxEventsPerBatch) {
        const error = badRequest(
          `Batch carries ${batch.events.length} events; the limit is ${config.ingest.maxEventsPerBatch}.`,
          { max_events_per_batch: config.ingest.maxEventsPerBatch },
        );
        await recordIngest({
          route: 'events',
          sessionId: batch.session_id,
          requestId: req.requestId,
          rawBody: req.body,
          status: 'rejected',
          error,
        });
        throw error;
      }

      const result = await ingestEventBatch(batch);
      await recordIngest({
        route: 'events',
        sessionId: batch.session_id,
        requestId: req.requestId,
        rawBody: req.body,
        status: 'accepted',
      });
      res.status(202).json({
        accepted: result.accepted,
        inserted: result.inserted,
        duplicates: result.duplicates,
        rejected: result.rejected,
      });
    }),
  );

  /**
   * POST /v1/activity/sessions/:session_id/finalize
   *
   * Idempotent: an identical re-send is acknowledged without rewriting the record.
   */
  router.post(
    '/sessions/:session_id/finalize',
    requireIngest,
    schemaGate,
    asyncHandler(async (req, res) => {
      let payload;
      try {
        payload = SessionPayloadSchema.parse(req.body);
      } catch (err) {
        await recordIngest({
          route: 'finalize',
          sessionId: extractSessionId(req.body) ?? req.params.session_id ?? null,
          requestId: req.requestId,
          rawBody: req.body,
          status: 'rejected',
          error: err,
        });
        throw err;
      }

      const pathId = req.params.session_id;

      if (pathId && pathId !== payload.session.session_id) {
        const error = badRequest('session_id in the path does not match the payload.', {
          path: pathId,
          body: payload.session.session_id,
        });
        await recordIngest({
          route: 'finalize',
          sessionId: payload.session.session_id,
          requestId: req.requestId,
          rawBody: req.body,
          status: 'rejected',
          error,
        });
        throw error;
      }

      const result = await finalizeSession(payload);
      await recordIngest({
        route: 'finalize',
        sessionId: result.session_id,
        requestId: req.requestId,
        rawBody: req.body,
        status: 'accepted',
      });
      res.status(200).json({
        received: true,
        session_id: result.session_id,
        duplicate: result.duplicate,
        outcome: result.outcome,
        derived_outcome: result.derived_outcome,
        verification: {
          issue_count: result.verification_issue_count,
          critical_issue_count: result.critical_issue_count,
        },
        stripped: result.stripped,
        events_stored: result.events_stored,
      });

      // A reviewer benefits from a second opinion on every finalized session now — not
      // just flagged ones — since the AI can also catch cases the deterministic outcome
      // itself got wrong (e.g. a confirmed submission on a portal that doesn't match the
      // job posting it started from). The AI stays advisory: it runs *after* the
      // deterministic outcome is already stored, never influences it, and a failure here
      // must never affect the response above — the response has already been sent by the
      // time this runs.
      if (!payload.partial && !result.duplicate && config.ai.enabled) {
        analyseSession(result.session_id, ai).catch((err) => {
          log.warn('automatic analysis of a finalized session failed', {
            session_id: result.session_id,
            derived_outcome: result.derived_outcome,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }),
  );

  /**
   * GET /v1/activity/sessions/:session_id/candidate
   *
   * Reference data for in-browser comparison. This is the only response that can carry
   * candidate data, and it goes no further than the operator's own page context.
   */
  router.get(
    '/sessions/:session_id/candidate',
    requireIngest,
    asyncHandler(async (req, res) => {
      const sessionId = req.params.session_id;
      if (!sessionId) throw badRequest('session_id is required.');
      const record = await getCandidateForSession(sessionId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(record);
    }),
  );

  return router;
}
