import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { OrderCommand } from '@campo/shared';
import type Redis from 'ioredis';
import { REDIS } from '../redis/tokens';
import { CONTROL_LIMITS } from './control.types';

/** Reloj inyectable (las pruebas lo controlan). */
@Injectable()
export class ControlClock {
  now(): number {
    return Date.now();
  }
}

/** Lo que liga un `confirmId`: usuario, activo y orden exacta (§14.3 punto 1). */
export interface ConfirmPayload {
  userId: string;
  plant: string;
  asset: string;
  command: OrderCommand;
  target?: number;
  expiresAt: number;
}

/**
 * `confirmId` de un solo uso y 60 s. Vive en Redis (varias réplicas de la API ven el mismo): `GETDEL` lo lee y lo
 * borra en una sola operación atómica, así que dos confirmaciones simultáneas nunca ejecutan la orden dos veces.
 */
@Injectable()
export class ConfirmStore {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly clock: ControlClock,
  ) {}

  private key(id: string): string {
    return `campo:control:confirm:${id}`;
  }

  async issue(p: Omit<ConfirmPayload, 'expiresAt'>): Promise<{ id: string; expiresAt: number }> {
    const id = randomUUID();
    const expiresAt = this.clock.now() + CONTROL_LIMITS.confirmTtlMs;
    // El TTL de Redis es sólo limpieza (con margen); la caducidad real se comprueba contra `expiresAt`.
    await this.redis.set(
      this.key(id),
      JSON.stringify({ ...p, expiresAt } satisfies ConfirmPayload),
      'PX',
      CONTROL_LIMITS.confirmTtlMs * 2,
    );
    return { id, expiresAt };
  }

  /**
   * Consume el `confirmId`. Devuelve su contenido sólo si existía, no caducó y coincide EXACTAMENTE con el
   * usuario, activo y orden pedidos; en cualquier otro caso null. Siempre queda gastado (un intento con
   * datos ajenos también lo quema).
   */
  async consume(
    id: string,
    expect: { userId: string; plant: string; asset: string },
  ): Promise<ConfirmPayload | null> {
    const raw = await this.redis.getdel(this.key(id));
    if (!raw) return null;
    let p: ConfirmPayload;
    try {
      p = JSON.parse(raw) as ConfirmPayload;
    } catch {
      return null;
    }
    if (p.expiresAt <= this.clock.now()) return null;
    if (p.userId !== expect.userId || p.plant !== expect.plant || p.asset !== expect.asset)
      return null;
    return p;
  }
}

/** Ventana deslizante por usuario (en Redis: vale con varias réplicas). */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly clock: ControlClock,
  ) {}

  /** Registra un intento; false si en la ventana ya hubo `limit` (no se registra). `scope` separa contadores. */
  async hit(scope: string, userId: string, limit: number): Promise<boolean> {
    const key = `campo:control:rate:${scope}:${userId}`;
    const now = this.clock.now();
    const windowMs = CONTROL_LIMITS.rateWindowMs;
    await this.redis.zremrangebyscore(key, 0, now - windowMs);
    if ((await this.redis.zcard(key)) >= limit) return false;
    await this.redis.zadd(key, now, `${now}:${randomUUID()}`);
    await this.redis.pexpire(key, windowMs);
    return true;
  }
}
