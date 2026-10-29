import { LogLevel as NestLogLevel, LoggerService } from '@nestjs/common';
import type { LogLevel } from '../config/app-config';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Contextos internos de Nest (arranque): ruido a nivel debug. */
const NEST_INTERNALS = new Set([
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'WebSocketsController',
]);
const REDACT = /pass(word)?|secret|token|authorization|hash/i;

function sanitize(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

/** Logger NDJSON a stdout/stderr. Redacta claves sensibles en objetos de contexto. */
export class JsonLogger implements LoggerService {
  constructor(
    private level: LogLevel = 'info',
    private readonly write: (line: string, level: LogLevel) => void = (line, level) => {
      (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    },
  ) {}

  setLogLevels(_levels: NestLogLevel[]): void {
    /* el nivel se fija por LOG_LEVEL */
  }

  log(message: unknown, ...rest: unknown[]) {
    this.emit('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]) {
    const last0 = rest[rest.length - 1];
    if (level === 'info' && typeof last0 === 'string' && NEST_INTERNALS.has(last0)) level = 'debug';
    if (ORDER[level] < ORDER[this.level]) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level };
    const extras = [...rest];
    // Nest pasa el contexto como último argumento string.
    const last = extras[extras.length - 1];
    if (typeof last === 'string' && extras.length > 0) {
      entry.context = last;
      extras.pop();
    }
    if (message !== null && typeof message === 'object' && !(message instanceof Error)) {
      Object.assign(entry, redact(message as Record<string, unknown>));
    } else {
      entry.msg = message instanceof Error ? message.message : String(message);
      if (message instanceof Error) entry.stack = message.stack;
    }
    for (const x of extras) {
      if (typeof x === 'string') entry.trace = x;
      else if (x && typeof x === 'object')
        Object.assign(entry, redact(x as Record<string, unknown>));
    }
    this.write(JSON.stringify(entry), level);
  }
}

export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT.test(k) ? '[redacted]' : sanitize(v);
  }
  return out;
}
