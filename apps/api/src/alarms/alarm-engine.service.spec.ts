import type { AlarmEvent, TelemetryEvent } from '@campo/shared';
import { redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import { Subject } from 'rxjs';
import { parseEnv } from '../config/app-config';
import type { BusMessage, RealtimeBus } from '../redis/realtime-bus';
import {
  MemoryAlarmRulesRepository,
  MemoryAlarmsRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmsService } from './alarms.service';

const cfg = parseEnv({ JWT_SECRET: 'x'.repeat(32), NODE_ENV: 'test' });

const tel = (value: number, asset = 'tk-01'): TelemetryEvent => ({
  type: 'telemetry',
  plant: 'demo',
  asset,
  ts: 0,
  quality: 'good',
  values: { level: value },
});

describe('AlarmEngine', () => {
  let redis: Redis;
  let sub: Redis;
  let rules: MemoryAlarmRulesRepository;
  let alarms: MemoryAlarmsRepository;
  let bus: Subject<BusMessage>;
  let engine: AlarmEngine;
  let published: AlarmEvent[];
  let ruleId: string;

  beforeEach(async () => {
    ({ redis, sub } = createRedisMocks());
    rules = new MemoryAlarmRulesRepository();
    alarms = new MemoryAlarmsRepository();
    bus = new Subject<BusMessage>();
    await redis.flushall();
    const list: AlarmEvent[] = [];
    published = list;
    sub.on('message', (_c: string, m: string) => list.push(JSON.parse(m) as AlarmEvent));
    await sub.subscribe(redisKeys.alarms('demo'));

    const rule = await rules.create({
      plant: 'demo',
      asset: 'tk-*',
      metric: 'level',
      operator: 'gt',
      threshold: 90,
      severity: 'critical',
      forSeconds: 5,
      hysteresis: 5,
      enabled: true,
    });
    ruleId = rule.id;
    engine = new AlarmEngine(
      rules,
      alarms,
      { messages$: bus.asObservable() } as unknown as RealtimeBus,
      redis,
      cfg,
    );
    await engine.onModuleInit();
  });

  afterEach(async () => {
    engine.onModuleDestroy();
    await sub.unsubscribe();
    redis.disconnect();
    sub.disconnect();
  });

  const flush = async () => {
    await engine.idle();
    await new Promise((r) => setTimeout(r, 10)); // entrega pub/sub del mock
  };

  it('recorre el ciclo debounce -> active -> cleared con Redis, pub/sub y persistencia', async () => {
    engine.onTelemetry(tel(95), 0);
    engine.onTelemetry(tel(95), 4000);
    await flush();
    expect(published).toHaveLength(0);
    expect(alarms.alarms.size).toBe(0);

    engine.onTelemetry(tel(96), 5000);
    await flush();
    expect(published).toHaveLength(1);
    const active = published[0];
    expect(active).toMatchObject({ state: 'active', ruleId, asset: 'tk-01', value: 96 });
    expect(alarms.alarms.get(active.id)?.state).toBe('active');
    const hash = await redis.hgetall(redisKeys.activeAlarms('demo'));
    expect(Object.keys(hash)).toEqual([`tk-01:level:${ruleId}`]);
    expect((JSON.parse(hash[`tk-01:level:${ruleId}`]) as AlarmEvent).id).toBe(active.id);

    // dentro de la banda muerta (90-5=85): sigue activa
    engine.onTelemetry(tel(88), 6000);
    await flush();
    expect(published).toHaveLength(1);

    engine.onTelemetry(tel(80), 7000);
    await flush();
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ id: active.id, state: 'cleared' });
    expect(alarms.alarms.get(active.id)).toMatchObject({ state: 'cleared', clearedAt: 7000 });
    expect(await redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({});
  });

  it('consume mensajes del bus compartido (sólo telemetría)', async () => {
    const rule2 = await rules.create({
      plant: 'demo',
      asset: '*',
      metric: 'level',
      operator: 'gt',
      threshold: 50,
      severity: 'warning',
      forSeconds: 0,
      hysteresis: 0,
      enabled: true,
    });
    await engine.refresh();
    bus.next({ kind: 'telemetry', plant: 'demo', event: tel(60, 'pump-01') });
    bus.next({
      kind: 'alarm',
      plant: 'demo',
      event: { ...(tel(0) as unknown as AlarmEvent), type: 'alarm' },
    });
    await flush();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ ruleId: rule2.id, asset: 'pump-01' });
  });

  it('el ack lo hace un usuario, queda registrado y se propaga a Redis y pub/sub', async () => {
    engine.onTelemetry(tel(95), 0);
    engine.onTelemetry(tel(95), 5000);
    await flush();
    const id = published[0].id;

    const svc = new AlarmsService(alarms, engine, redis);
    const rec = await svc.ack(id, { id: 'user-1', email: 'a@b.c', role: 'operator' }, 9000);
    expect(rec).toMatchObject({
      acknowledged: true,
      acknowledgedBy: 'user-1',
      acknowledgedAt: 9000,
    });
    await flush();
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ id, state: 'active', acknowledged: true });
    const stored = JSON.parse(
      (await redis.hget(redisKeys.activeAlarms('demo'), `tk-01:level:${ruleId}`)) as string,
    ) as AlarmEvent;
    expect(stored.acknowledged).toBe(true);

    // idempotente: segundo ack no cambia ni publica
    await svc.ack(id, { id: 'user-2', email: 'x@y.z', role: 'admin' }, 9500);
    await flush();
    expect(published).toHaveLength(2);
    expect(alarms.alarms.get(id)?.acknowledgedBy).toBe('user-1');

    // al normalizarse, el evento cleared arrastra acknowledged=true
    engine.onTelemetry(tel(10), 10_000);
    await flush();
    expect(published[2]).toMatchObject({ state: 'cleared', acknowledged: true });
  });

  it('ack de una alarma inexistente -> NotFound', async () => {
    const svc = new AlarmsService(alarms, engine, redis);
    await expect(
      svc.ack('00000000-0000-4000-8000-0000000000ff', { id: 'u', email: 'e', role: 'admin' }),
    ).rejects.toThrow('Alarma no encontrada');
  });

  it('cierra la alarma activa si se elimina su regla', async () => {
    engine.onTelemetry(tel(95), 0);
    engine.onTelemetry(tel(95), 5000);
    await flush();
    await rules.delete(ruleId);
    await engine.refresh();
    await flush();
    expect(published.at(-1)).toMatchObject({ state: 'cleared' });
    expect(await redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({});
  });

  it('tras un reinicio restaura las alarmas activas y no las duplica', async () => {
    engine.onTelemetry(tel(95), 0);
    engine.onTelemetry(tel(95), 5000);
    await flush();
    engine.onModuleDestroy();
    await redis.flushall();

    const engine2 = new AlarmEngine(
      rules,
      alarms,
      { messages$: bus.asObservable() } as unknown as RealtimeBus,
      redis,
      cfg,
    );
    await engine2.onModuleInit();
    expect(Object.keys(await redis.hgetall(redisKeys.activeAlarms('demo')))).toHaveLength(1);
    engine2.onTelemetry(tel(97), 20_000);
    await engine2.idle();
    expect(alarms.alarms.size).toBe(1);
    engine2.onModuleDestroy();
    engine = engine2;
  });

  it('un fallo de la base de datos no impide publicar en Redis', async () => {
    jest.spyOn(alarms, 'insert').mockRejectedValue(new Error('db caída'));
    engine.onTelemetry(tel(95), 0);
    engine.onTelemetry(tel(95), 5000);
    await flush();
    expect(published).toHaveLength(1);
  });
});
