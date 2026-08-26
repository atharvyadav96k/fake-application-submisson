import dns from 'node:dns';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/connection.js';
import { configureLogger, createLogger } from './utils/logger.js';
dns.setServers(['8.8.8.8', '1.1.1.1']);

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger(config.logLevel, config.isProduction);
  const log = createLogger('server');

  // Fail fast on an unreachable database: a process that starts anyway would accept
  // evidence and 503 every write, which looks to the extension exactly like a service
  // that is up but broken.
  try {
    await connectDatabase(config);
  } catch (err) {
    log.error('cannot reach MongoDB — refusing to start', {
      uri: config.mongo.uri.replace(/\/\/[^@]+@/, '//<credentials>@'),
      db: config.mongo.dbName,
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    log.info('listening', {
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      ai: config.ai.enabled ? config.ai.model : 'disabled',
      auth: config.auth.disabled ? 'DISABLED' : 'bearer',
    });
    if (config.auth.disabled) log.warn('authentication is disabled — development only');
    if (!config.ai.enabled) log.warn('AI analysis disabled: set AI_API_KEY and AI_ENABLED=true to enable');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    const forced = setTimeout(() => {
      log.error('forced exit: connections did not drain in 10s');
      process.exit(1);
    }, 10_000);
    forced.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
    clearTimeout(forced);
    log.info('stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { message: err.message, stack: err.stack?.split('\n').slice(0, 5).join(' | ') });
    void shutdown('uncaughtException');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
