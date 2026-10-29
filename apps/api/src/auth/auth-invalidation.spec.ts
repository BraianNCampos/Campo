import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import {
  AUTH_INVALIDATE_CHANNEL,
  InMemoryInvalidationBus,
  RedisInvalidationBus,
} from './auth-invalidation';

describe('InMemoryInvalidationBus', () => {
  it('entrega a todos los suscriptores y permite darse de baja', async () => {
    const bus = new InMemoryInvalidationBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((x) => a.push(x));
    const off = bus.subscribe((x) => b.push(x));
    await bus.publish('u1');
    off();
    await bus.publish('u2');
    expect(a).toEqual(['u1', 'u2']);
    expect(b).toEqual(['u1']);
  });
});

describe('RedisInvalidationBus (ioredis-mock)', () => {
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  /** Dos "réplicas" con sus conexiones de comandos y suscripción sobre el mismo servidor en memoria. */
  const replica = async (root: Redis) => {
    const bus = new RedisInvalidationBus(root.duplicate(), root.duplicate());
    await bus.onModuleInit();
    return bus;
  };

  it('usa el canal campo:auth:invalidate y llega a las demás réplicas', async () => {
    expect(AUTH_INVALIDATE_CHANNEL).toBe('campo:auth:invalidate');
    const root = new RedisMock();
    const a = await replica(root);
    const b = await replica(root);
    const seenB: string[] = [];
    b.subscribe((id) => seenB.push(id));

    await a.publish('user-1');
    await wait();
    expect(seenB).toEqual(['user-1']);

    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it('ignora mensajes de otros canales y payloads vacíos o enormes', async () => {
    const root = new RedisMock();
    const a = await replica(root);
    const seen: string[] = [];
    a.subscribe((id) => seen.push(id));
    await root.publish('campo:otro', 'x');
    await root.publish(AUTH_INVALIDATE_CHANNEL, '');
    await root.publish(AUTH_INVALIDATE_CHANNEL, 'x'.repeat(100));
    await wait();
    expect(seen).toEqual([]);
    await a.onModuleDestroy();
  });

  it('si Redis falla al publicar, no lanza (el TTL es la cota dura)', async () => {
    const failing = { publish: () => Promise.reject(new Error('caído')) } as unknown as Redis;
    const bus = new RedisInvalidationBus(failing, {} as Redis);
    await expect(bus.publish('u')).resolves.toBeUndefined();
  });
});
