import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { Public } from '../auth/decorators';
import { PG_POOL } from '../database/tokens';
import { REDIS } from '../redis/tokens';

type Status = 'up' | 'down';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

@Controller()
export class HealthController {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** Liveness: el proceso responde. */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /** Readiness: Redis y Postgres responden. 503 si alguno falla. */
  @Public()
  @Get('ready')
  async ready() {
    const check = async (fn: () => Promise<unknown>): Promise<Status> => {
      try {
        await withTimeout(fn(), 2000);
        return 'up';
      } catch {
        return 'down';
      }
    };
    const [redis, db] = await Promise.all([
      check(() => this.redis.ping()),
      check(() => this.pool.query('SELECT 1')),
    ]);
    const body = { status: redis === 'up' && db === 'up' ? 'ready' : 'unavailable', redis, db };
    if (body.status !== 'ready') throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
