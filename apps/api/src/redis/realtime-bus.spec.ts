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
});
