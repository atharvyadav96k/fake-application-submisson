import { Router } from 'express';
import type { AppConfig } from '../config/env.js';
import { checkDatabase } from '../db/connection.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { SCHEMA_VERSION } from '../contract/vocabulary.js';

/**
 * Liveness and readiness.
 *
 * Unauthenticated on purpose so a load balancer can reach it, and therefore deliberately
 * uninformative: it reports whether dependencies answer, never versions of internals,
 * connection strings, or counts.
 */
export function healthRoutes(config: AppConfig, startedAt: Date): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round((Date.now() - startedAt.getTime()) / 1000) });
  });

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const db = await checkDatabase();
      const ready = db.connected;
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'degraded',
        database: { connected: db.connected, ping_ms: db.ping_ms },
        ai: { enabled: config.ai.enabled, model: config.ai.enabled ? config.ai.model : null },
        schema_version: SCHEMA_VERSION,
        supported_schema_versions: config.ingest.supportedSchemaVersions,
      });
    }),
  );

  return router;
}
