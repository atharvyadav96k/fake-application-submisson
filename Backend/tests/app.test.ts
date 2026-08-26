import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import batchFixture from './fixtures/event-batch.json' with { type: 'json' };
import { createApp } from '../src/app.js';
import { resetConfigForTests, type AppConfig } from '../src/config/env.js';
import { configureLogger } from '../src/utils/logger.js';
import { signAuthToken } from '../src/utils/jwt.js';

/**
 * HTTP-surface tests.
 *
 * These run without a database on purpose. Everything asserted here — authentication,
 * scope separation, schema gating, body limits, and the mapping of an unreachable
 * database to a *retryable* 503 — must hold regardless of storage, and the 503 path is
 * exactly the one that decides whether an extension keeps its queued evidence or
 * throws it away.
 */

const INGEST_TOKEN = 'test-ingest-token';
const ADMIN_TOKEN = 'test-admin-token';

let server: Server;
let baseUrl: string;
let config: AppConfig;
let userToken: string;
let adminToken: string;

beforeAll(async () => {
  configureLogger('silent', false);
  // Match the runtime connection setting so unreachable-database errors fail fast
  // instead of buffering until a timeout.
  mongoose.set('bufferCommands', false);

  config = resetConfigForTests({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    INGEST_TOKEN,
    ADMIN_TOKEN,
    JWT_SECRET: 'test-jwt-secret',
    AUTH_DISABLED: 'false',
    SUPPORTED_SCHEMA_VERSIONS: '1.0',
    AI_ENABLED: 'false',
  } as NodeJS.ProcessEnv);

  userToken = signAuthToken(config, { sub: 'user-1', email: 'user@example.com', role: 'user', name: 'Test User' });
  adminToken = signAuthToken(config, { sub: 'admin-1', email: 'admin@example.com', role: 'admin', name: 'Test Admin' });

  server = createApp(config).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

const json = async (res: Response): Promise<any> => res.json();

const asIngest = (init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), Authorization: `Bearer ${userToken}` },
});

const asAdmin = (init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), Authorization: `Bearer ${adminToken}` },
});

describe('health', () => {
  it('serves liveness without a credential', async () => {
    const res = await call('/health/live');
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('ok');
  });

  it('reports not-ready while the database is unreachable', async () => {
    const res = await call('/health/ready');
    expect(res.status).toBe(503);
    expect((await json(res)).database.connected).toBe(false);
  });
});

describe('authentication', () => {
  it('rejects an ingest call with no credential', async () => {
    const res = await call('/v1/activity/events', { method: 'POST', body: JSON.stringify(batchFixture) });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('unauthorized');
  });

  it('rejects a wrong token', async () => {
    const res = await call('/v1/activity/events', {
      method: 'POST',
      body: JSON.stringify(batchFixture),
      headers: { Authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a plain user role on the review API', async () => {
    const res = await call('/v1/sessions', asIngest());
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('forbidden');
  });

  it('allows an admin role on the review API', async () => {
    const res = await call('/v1/sessions', asAdmin());
    // No database is running in this suite; reaching the handler (not 401/403) is what's asserted.
    expect([200, 503]).toContain(res.status);
  });

  it('does not leak whether a session exists to an unauthenticated caller', async () => {
    const res = await call('/v1/sessions/7c3f1a9e-2b6d-4f0a-9d1c-8e5b4a2f6c11');
    expect(res.status).toBe(401);
  });
});

describe('request validation', () => {
  it('rejects an unsupported schema version with 422', async () => {
    const res = await call(
      '/v1/activity/events',
      asIngest({ method: 'POST', body: JSON.stringify({ ...batchFixture, schema_version: '9.9' }) }),
    );
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe('unsupported_schema_version');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await call('/v1/activity/events', asIngest({ method: 'POST', body: '{ not json' }));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('invalid_json');
  });

  it('reports which part of the body failed validation', async () => {
    const events = structuredClone(batchFixture.events);
    events[0]!.event_type = 'not_a_real_event';
    const res = await call(
      '/v1/activity/events',
      asIngest({ method: 'POST', body: JSON.stringify({ ...batchFixture, events }) }),
    );

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details[0].path).toContain('events.0.event_type');
    expect(body.retryable).toBe(false);
  });

  it('rejects a finalize whose path id disagrees with the payload', async () => {
    const res = await call(
      '/v1/activity/sessions/some-other-session/finalize',
      asIngest({ method: 'POST', body: JSON.stringify({ schema_version: '1.0' }) }),
    );
    // Schema validation runs first; either way the request must not be accepted.
    expect([400, 422]).toContain(res.status);
  });

  it('404s an unknown route', async () => {
    const res = await call('/v1/nope');
    expect(res.status).toBe(404);
  });
});

describe('portal API auth gating', () => {
  it('requires a JWT to list clients', async () => {
    const res = await call('/v1/clients');
    expect(res.status).toBe(401);
  });

  it('requires a JWT to list applications', async () => {
    const res = await call('/v1/applications');
    expect(res.status).toBe(401);
  });

  it('refuses a plain user role on user management', async () => {
    const res = await call('/v1/users', asIngest());
    expect(res.status).toBe(403);
  });

  it('allows an admin role on user management', async () => {
    const res = await call('/v1/users', asAdmin());
    expect([200, 503]).toContain(res.status);
  });

  it('refuses a plain user role verifying an application', async () => {
    const res = await call(
      '/v1/applications/some-id/verify',
      asIngest({ method: 'POST', body: JSON.stringify({ trust_score: 80 }) }),
    );
    expect(res.status).toBe(403);
  });

  it('login is reachable without a credential', async () => {
    const res = await call('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nope@example.com', password: 'x' }) });
    expect(res.status).not.toBe(401);
  });

  it('rejects login with a malformed body', async () => {
    const res = await call('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) });
    expect(res.status).toBe(400);
  });
});

describe('storage failure', () => {
  it('answers a valid batch with a retryable 503 when the database is down', async () => {
    const res = await call('/v1/activity/events', asIngest({ method: 'POST', body: JSON.stringify(batchFixture) }));

    // Retryable is the important part: the extension keeps its queue and replays it.
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error.code).toBe('database_unavailable');
    expect(body.retryable).toBe(true);
  });
});

describe('response hygiene', () => {
  it('returns a request id on every response', async () => {
    const res = await call('/health/live');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('echoes a caller-supplied request id for correlation', async () => {
    const res = await call('/health/live', { headers: { 'X-Request-Id': 'trace-abc-123' } });
    expect(res.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('does not advertise the server implementation', async () => {
    const res = await call('/health/live');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
