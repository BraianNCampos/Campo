import type { Redis } from 'ioredis';
import type { BusMessage } from './realtime-bus';
import { RealtimeBus } from './realtime-bus';
import { createRedisMocks } from '../../test/support/redis-mock';

describe('RealtimeBus', () => {
  it('un único PSUBSCRIBE reparte telemetría y alarmas ya parseadas', async () => {
    const { redis, sub } = createRedisMocks();
    const bus = new RealtimeBus(sub);
    const got: BusMessage[] = [];
    bus.messages$.subscribe((m) => got.push(m));
    await bus.onModuleInit();

    await redis.publish(
      'campo:events:demo',
      JSON.stringify({
        type: 'telemetry',
        plant: 'demo',
        asset: 'tk-01',
        ts: 1,
        quality: 'good',
        values: { level: 5 },
      }),
    );
    await redis.publish(
      'campo:alarms:demo',
      JSON.stringify({ type: 'alarm', id: 'a', plant: 'demo' }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(got.map((m) => m.kind)).toEqual(['telemetry', 'alarm']);
    expect(got[0]).toMatchObject({ plant: 'demo', event: { asset: 'tk-01' } });
    await bus.onModuleDestroy();
    redis.disconnect();
    sub.disconnect();
  });

  it('descarta JSON inválido, tipos que no corresponden y plantas inválidas', () => {
    const bus = new RealtimeBus({} as Redis);
    const got: BusMessage[] = [];
    bus.messages$.subscribe((m) => got.push(m));
    bus.handle('campo:events:demo', 'no-json');
    bus.handle('campo:events:demo', JSON.stringify({ type: 'alarm' }));
    bus.handle('campo:events:demo', JSON.stringify({ type: 'telemetry', asset: 'a' })); // sin values
    bus.handle(
      'campo:events:BAD PLANT',
      JSON.stringify({ type: 'telemetry', asset: 'a', values: {} }),
    );
    bus.handle('otro:canal', '{}');
    expect(got).toHaveLength(0);
  });

  describe('catálogo (campo:catalog:changed)', () => {
    it('reparte {kind:"catalog", plant} una sola vez por publicación', async () => {
      const { redis, sub } = createRedisMocks();
      const bus = new RealtimeBus(sub);
      const got: BusMessage[] = [];
      bus.messages$.subscribe((m) => got.push(m));
      await bus.onModuleInit();

      await redis.publish('campo:catalog:changed', JSON.stringify({ plant: 'demo' }));
      await redis.publish(
        'campo:events:demo',
        JSON.stringify({ type: 'telemetry', asset: 'a', values: { x: 1 } }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(got).toEqual([
        { kind: 'catalog', plant: 'demo' },
        expect.objectContaining({ kind: 'telemetry', plant: 'demo' }),
      ]);
      await bus.onModuleDestroy();
      redis.disconnect();
      sub.disconnect();
    });

    it('descarta payloads inválidos, plantas con formato incorrecto y otros canales', () => {
      const bus = new RealtimeBus({} as Redis);
      const got: BusMessage[] = [];
      bus.messages$.subscribe((m) => got.push(m));
      for (const raw of [
        'no-json',
        'null',
        '5',
        '{}',
        JSON.stringify({ plant: 5 }),
        JSON.stringify({ plant: 'BAD PLANT' }),
        JSON.stringify({ plant: '../x' }),
      ]) {
        bus.handle('campo:catalog:changed', raw);
      }
      bus.handle('campo:catalog:other', JSON.stringify({ plant: 'demo' }));
      expect(got).toHaveLength(0);
      bus.handle('campo:catalog:changed', JSON.stringify({ plant: 'demo', extra: 1 }));
      expect(got).toEqual([{ kind: 'catalog', plant: 'demo' }]);
    });
  });
});
