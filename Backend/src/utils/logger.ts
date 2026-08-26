/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line in production so logs are ingestible, and a compact
 * human-readable line in development. It never formats arbitrary payload objects —
 * callers pass explicit, already-safe fields.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let activeLevel: LogLevel = 'info';
let jsonOutput = false;

export function configureLogger(level: LogLevel, json: boolean): void {
  activeLevel = level;
  jsonOutput = json;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[activeLevel]) return;

  if (jsonOutput) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, message, ...fields });
    process.stdout.write(`${line}\n`);
    return;
  }

  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}\n`;
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}
