import { z } from 'zod';

/**
 * Environment loading and validation.
 *
 * The process refuses to start on an invalid configuration rather than failing later at
 * a request boundary. Secrets are read here and never re-exported in whole — callers ask
 * for the specific value they need.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v.toLowerCase() === 'true' || v === '1'));

const int = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min));

const csv = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(8080, 1),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required').default('mongodb://127.0.0.1:27017'),
  MONGODB_DB_NAME: z.string().min(1).default('activity_verification'),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: int(8_000, 100),
  MONGODB_MAX_POOL_SIZE: int(20, 1),
  MONGODB_AUTO_INDEX: bool(true),

  AI_ENABLED: bool(true),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().default('gemini-2.5-flash'),
  AI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  AI_TIMEOUT_MS: int(30_000, 1_000),

  INGEST_TOKEN: z.string().optional().default(''),
  ADMIN_TOKEN: z.string().optional().default(''),
  AUTH_DISABLED: bool(false),

  JWT_SECRET: z.string().optional().default(''),
  JWT_EXPIRES_IN: z.string().default('7d'),

  SUPPORTED_SCHEMA_VERSIONS: csv(),
  MAX_EVENTS_PER_BATCH: int(100, 1),
  MAX_BODY_BYTES: int(8 * 1024 * 1024, 1024),
  RATE_LIMIT_WINDOW_MS: int(60_000, 1_000),
  RATE_LIMIT_MAX_REQUESTS: int(600, 1),

  CORS_ORIGINS: csv(),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  host: string;
  port: number;
  mongo: {
    uri: string;
    dbName: string;
    serverSelectionTimeoutMs: number;
    maxPoolSize: number;
    autoIndex: boolean;
  };
  ai: {
    enabled: boolean;
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
  };
  auth: {
    disabled: boolean;
    ingestToken: string;
    adminToken: string;
    jwtSecret: string;
    jwtExpiresIn: string;
  };
  ingest: {
    supportedSchemaVersions: string[];
    maxEventsPerBatch: number;
    maxBodyBytes: number;
  };
  rateLimit: { windowMs: number; maxRequests: number };
  corsOrigins: string[];
}

function build(raw: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  const config: AppConfig = {
    env: e.NODE_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    host: e.HOST,
    port: e.PORT,
    mongo: {
      uri: e.MONGODB_URI,
      dbName: e.MONGODB_DB_NAME,
      serverSelectionTimeoutMs: e.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: e.MONGODB_MAX_POOL_SIZE,
      autoIndex: e.MONGODB_AUTO_INDEX,
    },
    ai: {
      enabled: e.AI_ENABLED && e.AI_API_KEY.length > 0,
      apiKey: e.AI_API_KEY,
      model: e.AI_MODEL,
      baseUrl: e.AI_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: e.AI_TIMEOUT_MS,
    },
    auth: {
      disabled: e.AUTH_DISABLED,
      ingestToken: e.INGEST_TOKEN,
      adminToken: e.ADMIN_TOKEN,
      jwtSecret: e.JWT_SECRET || (isProduction ? '' : 'dev-jwt-secret-change-me'),
      jwtExpiresIn: e.JWT_EXPIRES_IN,
    },
    ingest: {
      supportedSchemaVersions: e.SUPPORTED_SCHEMA_VERSIONS.length ? e.SUPPORTED_SCHEMA_VERSIONS : ['1.0'],
      maxEventsPerBatch: e.MAX_EVENTS_PER_BATCH,
      maxBodyBytes: e.MAX_BODY_BYTES,
    },
    rateLimit: { windowMs: e.RATE_LIMIT_WINDOW_MS, maxRequests: e.RATE_LIMIT_MAX_REQUESTS },
    corsOrigins: e.CORS_ORIGINS,
  };

  // Refusing to boot unauthenticated in production is a deliberate safety rail: this
  // service receives evidence about real people and must never be world-writable.
  if (isProduction && !config.auth.disabled) {
    if (!config.auth.ingestToken) throw new Error('INGEST_TOKEN must be set in production');
    if (!config.auth.adminToken) throw new Error('ADMIN_TOKEN must be set in production');
    if (!config.auth.jwtSecret) throw new Error('JWT_SECRET must be set in production');
  }
  if (isProduction && config.auth.disabled) {
    throw new Error('AUTH_DISABLED cannot be true when NODE_ENV=production');
  }

  return config;
}

let cached: AppConfig | null = null;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  cached ??= build(raw);
  return cached;
}

/** Test hook: rebuilds config from an explicit environment. */
export function resetConfigForTests(raw: NodeJS.ProcessEnv): AppConfig {
  cached = build(raw);
  return cached;
}
