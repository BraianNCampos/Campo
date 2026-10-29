import { securityIssues } from './security-check';

export const APP_CONFIG = Symbol('APP_CONFIG');

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  host: string;
  port: number;
  trustProxy: boolean;
  logLevel: LogLevel;
  corsOrigins: string[];
  databaseUrl: string;
  pgPoolMax: number;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** TTL de la caché de usuarios/plantas del guard (ms). 0 = sin caché. */
  authCacheTtlMs: number;
  /** Cada cuánto se revalidan los WebSocket abiertos contra la base (ms). */
  wsRevalidateMs: number;
  bcryptRounds: number;
  adminEmail?: string;
  adminPassword?: string;
  loginRateLimit: number;
  loginRateTtlMs: number;
  wsCoalesceMs: number;
  wsPingIntervalMs: number;
  wsMaxBufferedBytes: number;
  historyMaxPoints: number;
  historyMaxRangeDays: number;
  alarmEngineEnabled: boolean;
  alarmRulesRefreshMs: number;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, def?: string): string {
  const v = env[key]?.trim();
  if (v) return v;
  if (def !== undefined) return def;
  throw new Error(`Variable de entorno requerida: ${key}`);
}

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} debe ser un entero entre ${min} y ${max} (recibido "${raw}")`);
  }
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return def;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new Error(`${key} debe ser booleano (true/false)`);
}

/** Valida y tipa el entorno. Lanza Error con un mensaje claro si algo es inválido. */
export function parseEnv(env: Env): AppConfig {
  const nodeEnv = str(env, 'NODE_ENV', 'development');
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    throw new Error('NODE_ENV debe ser development, production o test');
  }
  const isProduction = nodeEnv === 'production';

  const logLevel = str(env, 'LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL debe ser debug, info, warn o error');
  }

  const jwtSecret = str(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');

  const adminEmail = env['ADMIN_EMAIL']?.trim().toLowerCase() || undefined;
  const adminPassword = env['ADMIN_PASSWORD'] || undefined;
  if (Boolean(adminEmail) !== Boolean(adminPassword)) {
    throw new Error('ADMIN_EMAIL y ADMIN_PASSWORD deben definirse juntas');
  }
  if (adminPassword && adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD debe tener al menos 8 caracteres');
  }

  if (isProduction) {
    const issues = securityIssues({ jwtSecret, adminPassword });
    if (issues.length > 0) {
      throw new Error(`Configuración insegura para producción: ${issues.join('; ')}`);
    }
  }

  const corsRaw = env['CORS_ORIGINS'] ?? 'http://localhost:3000';
  const corsOrigins = corsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (isProduction && corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGINS no puede ser "*" en producción');
  }

  const authCacheTtlMs = int(env, 'AUTH_CACHE_TTL_MS', 30_000, 0, 30_000);

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    isProduction,
    host: str(env, 'HOST', '0.0.0.0'),
    port: int(env, 'PORT', 3001, 1, 65535),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    logLevel: logLevel as LogLevel,
    corsOrigins,
    databaseUrl: isProduction
      ? str(env, 'DATABASE_URL')
      : str(env, 'DATABASE_URL', 'postgres://campo:campo_dev@localhost:5432/campo'),
    pgPoolMax: int(env, 'PG_POOL_MAX', 10, 1, 100),
    redisUrl: isProduction
      ? str(env, 'REDIS_URL')
      : str(env, 'REDIS_URL', 'redis://localhost:6379'),
    jwtSecret,
    jwtExpiresIn: str(env, 'JWT_EXPIRES_IN', '1h'),
    authCacheTtlMs,
    // Por defecto igual al TTL de la caché: un socket revocado se cierra en <= TTL.
    wsRevalidateMs: int(env, 'WS_REVALIDATE_MS', authCacheTtlMs || 10_000, 100, 30_000),
    bcryptRounds: int(env, 'BCRYPT_ROUNDS', 12, 4, 15),
    adminEmail,
    adminPassword,
    loginRateLimit: int(env, 'LOGIN_RATE_LIMIT', 10, 1, 10_000),
    loginRateTtlMs: int(env, 'LOGIN_RATE_TTL_MS', 60_000, 1000, 3_600_000),
    wsCoalesceMs: int(env, 'WS_COALESCE_MS', 100, 10, 5000),
    wsPingIntervalMs: int(env, 'WS_PING_INTERVAL_MS', 25_000, 1000, 300_000),
    wsMaxBufferedBytes: int(env, 'WS_MAX_BUFFERED_BYTES', 262_144, 1024, 64 * 1024 * 1024),
    historyMaxPoints: int(env, 'HISTORY_MAX_POINTS', 5000, 10, 100_000),
    historyMaxRangeDays: int(env, 'HISTORY_MAX_RANGE_DAYS', 366, 1, 3650),
    alarmEngineEnabled: bool(env, 'ALARM_ENGINE_ENABLED', true),
    alarmRulesRefreshMs: int(env, 'ALARM_RULES_REFRESH_MS', 60_000, 1000, 3_600_000),
  };
}
