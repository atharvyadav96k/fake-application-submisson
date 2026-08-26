import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { GeminiClient } from './ai/gemini.client.js';
import type { AppConfig } from './config/env.js';
import { createAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createRequireJwt } from './middleware/require-jwt.js';
import { requestContext } from './middleware/request-context.js';
import { activityRoutes } from './routes/activity.routes.js';
import { applicationRoutes } from './routes/application.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { candidateRoutes } from './routes/candidate.routes.js';
import { clientRoutes } from './routes/client.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { ingestLogRoutes } from './routes/ingest-log.routes.js';
import { sessionRoutes } from './routes/session.routes.js';
import { userRoutes } from './routes/user.routes.js';

/**
 * Builds the Express application.
 *
 * Kept free of side effects — no database connection, no listener — so tests can mount
 * it against whatever infrastructure they choose.
 */
export function createApp(config: AppConfig, deps: { ai?: GeminiClient } = {}): Express {
  const app = express();
  const startedAt = new Date();
  const ai = deps.ai ?? new GeminiClient(config);
  // Static ingest/admin bearer tokens — unchanged, kept for any server-to-server use.
  const { requireIngest, requireAdmin } = createAuth(config);
  // Per-user JWT auth — what the frontend and the (now logged-in) extension use.
  const requireJwt = createRequireJwt(config);

  // Trust one proxy hop so rate-limit keys and logs see the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // The JSON API never renders a response into a browser; the CSP is a defence in depth
  // against a stored payload being served back into a page context.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // The frontend (a browser SPA) needs CORS; the extension's service worker does not
  // when host_permissions cover this origin.
  app.use(
    cors({
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Schema-Version', 'X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.use(requestContext);
  app.use(express.json({ limit: config.ingest.maxBodyBytes, type: ['application/json', 'application/*+json'] }));
  app.use(createRateLimiter(config.rateLimit.windowMs, config.rateLimit.maxRequests));

  app.use('/health', healthRoutes(config, startedAt));

  // Extension evidence-collection engine — unchanged, now gated by per-user JWT instead
  // of the static ingest token so an application can be attributed to the real operator.
  app.use('/v1/activity', activityRoutes(config, requireJwt(), ai));
  app.use('/v1/sessions', sessionRoutes(requireJwt('admin', 'manager'), ai));
  app.use('/v1/candidates', candidateRoutes(requireJwt('admin', 'manager'), requireJwt()));
  app.use('/v1/ingest-log', ingestLogRoutes(requireJwt('admin', 'manager')));

  // New portal surface: auth, clients, applications, user management.
  app.use('/v1/clients', clientRoutes(requireJwt));
  app.use('/v1/applications', applicationRoutes(requireJwt));
  app.use('/v1/users', userRoutes(requireJwt));
  // Deliberately unauthenticated — it exists so a client without a token can get one.
  app.use('/v1/auth', authRoutes(config));

  // Retained but unused by any route above; available for future server-to-server use.
  void requireIngest;
  void requireAdmin;

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
