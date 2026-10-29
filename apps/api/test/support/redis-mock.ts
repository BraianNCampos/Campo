import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';

/** Dos conexiones al mismo "servidor" en memoria: comandos y suscriptor. */
export function createRedisMocks(): { redis: Redis; sub: Redis } {
  const redis = new RedisMock();
  const sub = redis.duplicate();
  return { redis, sub };
}
