import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS, REDIS_SUB } from '../redis/tokens';

/** Canal por el que las réplicas se avisan de que un usuario cambió. Payload: el id (string). */
export const AUTH_INVALIDATE_CHANNEL = 'campo:auth:invalidate';

/**
 * Cómo se enteran otras réplicas de que un usuario cambió (para invalidar su caché sin esperar al TTL).
 * `publish` es "best effort": el TTL sigue siendo la cota dura.
 */
export abstract class AuthInvalidationBus {
  abstract publish(userId: string): Promise<void>;
  /** Registra un manejador de invalidaciones; devuelve la función para darlo de baja. */
  abstract subscribe(handler: (userId: string) => void): () => void;
}

/** En memoria: un solo proceso o tests (varias "réplicas" pueden compartir la misma instancia). */
@Injectable()
export class InMemoryInvalidationBus extends AuthInvalidationBus {
  private readonly handlers = new Set<(userId: string) => void>();

  publish(userId: string): Promise<void> {
    for (const h of [...this.handlers]) h(userId);
    return Promise.resolve();
  }

  subscribe(handler: (userId: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

/** Redis pub/sub en `campo:auth:invalidate`. Usa la conexión de comandos para publicar y la de suscripción para escuchar. */
@Injectable()
export class RedisInvalidationBus
  extends AuthInvalidationBus
  implements OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(RedisInvalidationBus.name);
  private readonly handlers = new Set<(userId: string) => void>();
  private readonly onMessage = (channel: string, userId: string): void => {
    if (channel !== AUTH_INVALIDATE_CHANNEL || !userId || userId.length > 64) return;
    for (const h of [...this.handlers]) h(userId);
  };

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUB) private readonly sub: Redis,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    this.sub.on('message', this.onMessage);
    await this.sub.subscribe(AUTH_INVALIDATE_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    this.sub.off('message', this.onMessage);
    try {
      await this.sub.unsubscribe(AUTH_INVALIDATE_CHANNEL);
    } catch {
      /* conexión ya cerrada */
    }
  }

  async publish(userId: string): Promise<void> {
    try {
      await this.redis.publish(AUTH_INVALIDATE_CHANNEL, userId);
    } catch (err) {
      this.log.warn({ msg: 'no se pudo publicar la invalidación', error: (err as Error).message });
    }
  }

  subscribe(handler: (userId: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
