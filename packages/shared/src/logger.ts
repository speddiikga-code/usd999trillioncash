/**
 * Minimal structured logger. JSON lines in production (ship to any log pipeline),
 * compact human-readable lines in development. Sensitive keys are redacted recursively.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(secret|password|passwd|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|signature)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  bindings?: Record<string, unknown>;
  sink?: (line: string, level: LogLevel) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? ((process.env.LOG_LEVEL as LogLevel) || 'info');
  const format = opts.format ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
  const bindings = opts.bindings ?? {};
  const sink =
    opts.sink ??
    ((line: string, lvl: LogLevel) => {
      if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });

  function log(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const rec = redact({ ...bindings, ...(fields ?? {}) }) as Record<string, unknown>;
    if (format === 'json') {
      sink(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...rec }), lvl);
    } else {
      const t = new Date().toISOString().slice(11, 23);
      const svc = rec.service ? `[${String(rec.service)}]` : '';
      delete rec.service;
      const extra = Object.keys(rec).length ? ' ' + JSON.stringify(rec) : '';
      sink(`${t} ${lvl.toUpperCase().padEnd(5)} ${svc} ${msg}${extra}`, lvl);
    }
  }

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (b) => createLogger({ level, format, sink, bindings: { ...bindings, ...b } }),
  };
}

/** Silent logger for tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
