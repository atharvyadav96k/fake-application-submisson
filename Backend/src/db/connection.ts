import mongoose from 'mongoose';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mongo');

/**
 * Mongoose connection lifecycle.
 *
 * `bufferCommands` is off deliberately: if the database is down we want an immediate,
 * retryable error at the request boundary rather than a request that hangs until the
 * extension's client timeout fires and it re-queues the same batch anyway.
 */
export async function connectDatabase(config: AppConfig): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);
  mongoose.set('autoIndex', config.mongo.autoIndex);

  mongoose.connection.on('connected', () => log.info('connected', { db: config.mongo.dbName }));
  mongoose.connection.on('disconnected', () => log.warn('disconnected'));
  mongoose.connection.on('reconnected', () => log.info('reconnected'));
  mongoose.connection.on('error', (err: unknown) =>
    log.error('connection error', { message: err instanceof Error ? err.message : String(err) }),
  );

  await mongoose.connect(config.mongo.uri, {
    dbName: config.mongo.dbName,
    serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
    maxPoolSize: config.mongo.maxPoolSize,
    autoIndex: config.mongo.autoIndex,
  });

  if (config.mongo.autoIndex) {
    // Surface index build failures at boot rather than on the first conflicting write.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    log.debug('indexes ready', { models: mongoose.modelNames().length });
  }

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close(false);
}

export type DatabaseHealth = {
  connected: boolean;
  /** Mongoose readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
  ready_state: number;
  ping_ms: number | null;
  error: string | null;
};

export async function checkDatabase(): Promise<DatabaseHealth> {
  const readyState = mongoose.connection.readyState;
  if (readyState !== 1 || !mongoose.connection.db) {
    return { connected: false, ready_state: readyState, ping_ms: null, error: 'not connected' };
  }
  const started = Date.now();
  try {
    await mongoose.connection.db.admin().ping();
    return { connected: true, ready_state: readyState, ping_ms: Date.now() - started, error: null };
  } catch (err) {
    return {
      connected: false,
      ready_state: readyState,
      ping_ms: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
