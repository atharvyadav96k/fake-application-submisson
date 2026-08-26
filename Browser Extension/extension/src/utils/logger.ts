import { getConfig } from '@/common/config';
import { redactInlineSecrets } from '@/collector/utils/redaction';


type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, args: unknown[]): void {
  const cfg = getConfig();
  if (!cfg.debug && level === 'debug') return;
  const safe = args.map((a) => (typeof a === 'string' ? redactInlineSecrets(a) : a));
  const fn = level === 'debug' ? console.debug : console[level];
  fn.call(console, `[aav:${scope}]`, ...safe);
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', scope, args),
    info: (...args: unknown[]) => emit('info', scope, args),
    warn: (...args: unknown[]) => emit('warn', scope, args),
    error: (...args: unknown[]) => emit('error', scope, args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
