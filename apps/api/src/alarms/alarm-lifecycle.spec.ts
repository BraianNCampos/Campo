import { redisKeys } from '@campo/shared';
import type { AlarmEvent, TelemetryEvent } from '@campo/shared';
import type Redis from 'ioredis';
import { Subject } from 'rxjs';
import {
  MemoryAlarmJournalRepository,
  MemoryAlarmRulesRepository,
  MemoryAlarmsRepository,
  MemoryAssetsRepository,
  MemoryAuditRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import { AuditService } from '../audit/audit.service';
import { PlantCatalog } from '../auth/plant-catalog';
import { TenantScope } from '../auth/tenant-scope';
import { parseEnv } from '../config/app-config';
import type { BusMessage, RealtimeBus } from '../redis/realtime-bus';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmsService } from './alarms.service';
import type { ShelveDto } from './dto';

/** Todas las transiciones de §12.2 contra el motor y el servicio (repositorios en memoria, reloj inyectado). */
const cfg = parseEnv({ JWT_SECRET: 'x'.repeat(32), NODE_ENV: 'test' });
const ORG = { id: 'A', name: 'A', modules: [] };
const operator = {
  id: 'u-op',
  email: 'op@a.test',
  role: 'operator' as const,
  plants: ['demo'],
  org: ORG,
};
const engineer = {
  id: 'u-eng',
  email: 'eng@a.test',
  role: 'engineer' as const,
  plants: ['demo'],
  org: ORG,
};
const catalog = Object.assign(Object.create(PlantCatalog.prototype) as PlantCatalog, {
  orgOf: (p: string) => Promise.resolve(p === 'demo' ? 'A' : null),
  isLive: () => Promise.resolve(false),
});
const tel = (
  value: number,
  asset = 'tk-01',
  extra: Record<string, number> = {},
): TelemetryEvent => ({
  type: 'telemetry',
  plant: 'demo',
  asset,
  ts: 0,
  quality: 'good',
  values: { level: value, ...extra },
});
const shelveDto = (minutes: number, reason = 'mantenimiento'): ShelveDto => ({ minutes, reason });

describe('ciclo de vida de alarmas (§12.2)', () => {
  let redis: Redis;
  let sub: Redis;
  let rules: MemoryAlarmRulesRepository;
  let alarms: MemoryAlarmsRepository;
  let journal: MemoryAlarmJournalRepository;
  let auditRepo: MemoryAuditRepository;
  let bus: Subject<BusMessage>;
  let engine: AlarmEngine;
  let svc: AlarmsService;
  let published: AlarmEvent[];
  let ruleId: string;

  const mkEngine = () =>
    new AlarmEngine(
      rules,
      alarms,
      { messages$: bus.asObservable() } as unknown as RealtimeBus,
      redis,
      cfg,
      catalog,
      journal,
      new MemoryAssetsRepository(),
    );
  const mkSvc = () =>
    new AlarmsService(
      alarms,
      engine,
      journal,
      new AuditService(auditRepo),
      new TenantScope(catalog),
    );
  const flush = async () => {
    await engine.idle();
    await new Promise((r) => setTimeout(r, 10)); // entrega pub/sub del mock
  };
  const types = (id: string) => journal.entries.filter((e) => e.alarmId === id).map((e) => e.type);
  const lifecycles = () => published.map((p) => `${p.state}/${p.lifecycle}`);
  /** Activa una alarma HH en tk-01 y devuelve su id. */
  async function activate(): Promise<string> {
    engine.onTelemetry(tel(95), 1000);
    await flush();
    return [...alarms.alarms.keys()][0];
  }

  beforeEach(async () => {
    ({ redis, sub } = createRedisMocks());
    await redis.flushall();
    rules = new MemoryAlarmRulesRepository();
    alarms = new MemoryAlarmsRepository(() => 'A');
    journal = new MemoryAlarmJournalRepository((id) => `${id}@a.test`);
    auditRepo = new MemoryAuditRepository();
    bus = new Subject<BusMessage>();
    published = [];
    sub.on('message', (_c: string, m: string) => published.push(JSON.parse(m) as AlarmEvent));
    await sub.subscribe(redisKeys.alarms('demo'));
    ruleId = (
      await rules.create({
        plant: 'demo',
        asset: 'tk-*',
        metric: 'level',
        operator: 'gt',
        threshold: 90,
        severity: 'critical',
        forSeconds: 0,
        hysteresis: 0,
        enabled: true,
        description: 'Nivel muy alto',
        consequence: 'Rebalse',
        response: 'Cerrar la válvula de entrada',
      })
    ).id;
    engine = mkEngine();
    await engine.onModuleInit();
    svc = mkSvc();
  });

  afterEach(async () => {
    jest.useRealTimers();
    engine.onModuleDestroy();
    await sub.unsubscribe();
    redis.disconnect();
    sub.disconnect();
  });

  describe('activación y normalización', () => {
    it('activa como unacked con kind, racionalización y entrada de diario', async () => {
      const id = await activate();
      expect(published[0]).toMatchObject({
        state: 'active',
        lifecycle: 'unacked',
        kind: 'HH',
        rationale: { description: 'Nivel muy alto', consequence: 'Rebalse' },
      });
      expect(alarms.alarms.get(id)).toMatchObject({ lifecycle: 'unacked', kind: 'HH' });
      expect(types(id)).toEqual(['activate']);
    });

    it('active+unacked -> normaliza -> rtn_unacked: sigue en la lista hasta reconocer', async () => {
      const id = await activate();
      engine.onTelemetry(tel(10), 2000);
      await flush();
      expect(lifecycles()).toEqual(['active/unacked', 'cleared/rtn_unacked']);
      expect(await redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({}); // ya no está activa
      const list = await svc.list({ state: 'active' }, operator);
      expect(list.map((a) => [a.id, a.lifecycle])).toEqual([[id, 'rtn_unacked']]);
      expect(await svc.list({ state: 'cleared' }, operator)).toEqual([]);
      expect(types(id)).toEqual(['activate', 'rtn']);
    });

    it('rtn_unacked + ack -> closed: sale de la lista y pasa al historial', async () => {
      const id = await activate();
      engine.onTelemetry(tel(10), 2000);
      await flush();
      const rec = await svc.ack(id, operator, 3000);
      await flush();
      expect(rec).toMatchObject({ state: 'cleared', lifecycle: 'closed', acknowledged: true });
      expect(lifecycles().at(-1)).toBe('cleared/closed');
      expect(await svc.list({ state: 'active' }, operator)).toEqual([]);
      expect((await svc.list({ state: 'cleared' }, operator)).map((a) => a.id)).toEqual([id]);
      expect(types(id)).toEqual(['activate', 'rtn', 'ack', 'close']);
    });

    it('active+unacked + ack -> acked; al normalizarse pasa directamente a closed', async () => {
      const id = await activate();
      const rec = await svc.ack(id, operator, 2000);
      await flush();
      expect(rec).toMatchObject({ state: 'active', lifecycle: 'acked' });
      expect(published.at(-1)).toMatchObject({ lifecycle: 'acked', acknowledged: true });
      engine.onTelemetry(tel(10), 3000);
      await flush();
      expect(published.at(-1)).toMatchObject({ state: 'cleared', lifecycle: 'closed' });
      expect(await svc.list({ state: 'active' }, operator)).toEqual([]);
      expect(types(id)).toEqual(['activate', 'ack', 'rtn', 'close']);
    });

    it('un ack repetido no cambia nada ni difunde ni duplica el diario', async () => {
      const id = await activate();
      await svc.ack(id, operator, 2000);
      await flush();
      const n = published.length;
      const entries = journal.entries.length;
      await svc.ack(id, engineer, 2500);
      await flush();
      expect(published).toHaveLength(n);
      expect(journal.entries).toHaveLength(entries);
      expect(alarms.alarms.get(id)?.acknowledgedBy).toBe('u-op');
    });

    it('una nueva activación con una rtn_unacked previa crea otra alarma: ambas en la lista', async () => {
      const first = await activate();
      engine.onTelemetry(tel(10), 2000);
      engine.onTelemetry(tel(96), 3000);
      await flush();
      const list = await svc.list({ state: 'active' }, operator);
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.lifecycle).sort()).toEqual(['rtn_unacked', 'unacked']);
      expect(list.some((a) => a.id === first)).toBe(true);
    });

    it('al eliminar la regla la alarma sin reconocer se cierra directamente', async () => {
      const id = await activate();
      await rules.delete(ruleId);
      await engine.refresh();
      await flush();
      expect(published.at(-1)).toMatchObject({ state: 'cleared', lifecycle: 'closed' });
      expect(alarms.alarms.get(id)?.lifecycle).toBe('closed');
      expect(types(id)).toEqual(['activate', 'close']);
    });
  });

  describe('postergar (shelving)', () => {
    it('oculta la alarma de las activas, la difunde como shelved y la saca del hash de activas', async () => {
      const id = await activate();
      const now = Date.now();
      const rec = await svc.shelve(id, shelveDto(30), engineer, now);
      await flush();
      expect(rec).toMatchObject({
        lifecycle: 'shelved',
        state: 'active',
        shelvedUntil: now + 30 * 60_000,
        shelvedReason: 'mantenimiento',
        shelvedBy: 'u-eng',
      });
      expect(published.at(-1)).toMatchObject({
        id,
        state: 'active',
        lifecycle: 'shelved',
        shelvedUntil: now + 30 * 60_000,
        shelvedReason: 'mantenimiento',
      });
      expect(await redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({});
      expect(await svc.list({ state: 'active' }, operator)).toEqual([]);
      expect((await svc.list({ state: 'shelved' }, operator)).map((a) => a.id)).toEqual([id]);
      expect(await svc.list({ state: 'cleared' }, operator)).toEqual([]);
      expect(types(id)).toEqual(['activate', 'shelve']);
      expect(journal.entries.at(-1)?.note).toBe('30 min: mantenimiento');
      expect(engine.pendingShelved()).toEqual([id]);
    });

    it('mientras está postergada y la condición persiste no se crea otra alarma ni se difunde', async () => {
      const id = await activate();
      await svc.shelve(id, shelveDto(5), engineer);
      await flush();
      const n = published.length;
      engine.onTelemetry(tel(99), 5000);
      await flush();
      expect(published).toHaveLength(n);
      expect(alarms.alarms.size).toBe(1);
    });

    it('al vencer se reanuncia: vuelve a unacked, sin reconocimiento previo, y el diario lo anota', async () => {
      const id = await activate();
      await svc.ack(id, operator, 2000); // estaba reconocida
      const now = Date.now();
      await svc.shelve(id, shelveDto(1), engineer, now);
      await flush();
      expect(await engine.expireDue(now + 59_999)).toBe(0); // todavía no
      expect(await engine.expireDue(now + 60_000)).toBe(1);
      await flush();
      expect(published.at(-1)).toMatchObject({
        id,
        state: 'active',
        lifecycle: 'unacked',
        acknowledged: false,
      });
      expect(Object.keys(await redis.hgetall(redisKeys.activeAlarms('demo')))).toHaveLength(1);
      expect((await svc.list({ state: 'active' }, operator)).map((a) => a.lifecycle)).toEqual([
        'unacked',
      ]);
      expect(await svc.list({ state: 'shelved' }, operator)).toEqual([]);
      expect(alarms.alarms.get(id)).not.toHaveProperty('shelvedUntil');
      const last = journal.entries.at(-1);
      expect(last).toMatchObject({ type: 'unshelve', alarmId: id });
      expect(last?.userId ?? null).toBeNull(); // lo hizo el sistema
      expect(engine.pendingShelved()).toEqual([]);
    });

    it('el temporizador real vence solo (reloj falso)', async () => {
      const id = await activate();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      await svc.shelve(id, shelveDto(2), engineer);
      expect(alarms.alarms.get(id)?.lifecycle).toBe('shelved');
      await jest.advanceTimersByTimeAsync(119_000);
      expect(alarms.alarms.get(id)?.lifecycle).toBe('shelved');
      await jest.advanceTimersByTimeAsync(2_000);
      await engine.idle();
      expect(alarms.alarms.get(id)?.lifecycle).toBe('unacked');
    });

    it('levantar la postergación a mano reanuncia y la audita; no se puede dos veces', async () => {
      const id = await activate();
      await svc.shelve(id, shelveDto(60), engineer);
      const rec = await svc.unshelve(id, engineer);
      await flush();
      expect(rec).toMatchObject({ lifecycle: 'unacked', acknowledged: false });
      expect(published.at(-1)).toMatchObject({ lifecycle: 'unacked' });
      expect(engine.pendingShelved()).toEqual([]);
      expect(journal.entries.at(-1)).toMatchObject({ type: 'unshelve', userId: 'u-eng' });
      await expect(svc.unshelve(id, engineer)).rejects.toThrow('no está postergada');
      expect(auditRepo.entries.map((e) => e.action)).toEqual(
        expect.arrayContaining(['alarm.shelve', 'alarm.unshelve']),
      );
    });

    it('si la condición se normaliza mientras está postergada: cleared/closed y el vencimiento se cancela', async () => {
      const id = await activate();
      await svc.shelve(id, shelveDto(60), engineer);
      engine.onTelemetry(tel(10), 3000);
      await flush();
      expect(published.at(-1)).toMatchObject({ state: 'cleared', lifecycle: 'closed' });
      expect(alarms.alarms.get(id)).toMatchObject({ lifecycle: 'closed' });
      expect(alarms.alarms.get(id)).not.toHaveProperty('shelvedUntil');
      expect(engine.pendingShelved()).toEqual([]);
      expect(await engine.expireDue(Date.now() + 10 * 3_600_000)).toBe(0);
      expect(published.filter((p) => p.lifecycle === 'unacked')).toHaveLength(1); // sólo la activación
    });

    it.each([
      [
        'una alarma normalizada (rtn_unacked)',
        async (id: string) => {
          engine.onTelemetry(tel(10), 2000);
          await flush();
          return id;
        },
      ],
      [
        'una ya postergada',
        async (id: string) => {
          await svc.shelve(id, shelveDto(5), engineer);
          return id;
        },
      ],
    ])('no se puede postergar %s (409)', async (_n, prepare) => {
      const id = await prepare(await activate());
      await expect(svc.shelve(id, shelveDto(5), engineer)).rejects.toThrow(/postergada|activa/);
    });

    it('una postergada no se puede reconocer (409) y no cambia', async () => {
      const id = await activate();
      await svc.shelve(id, shelveDto(5), engineer);
      await expect(svc.ack(id, operator)).rejects.toThrow('postergada');
      expect(alarms.alarms.get(id)).toMatchObject({ lifecycle: 'shelved', acknowledged: false });
    });

    it('postergar una inexistente -> 404', async () => {
      await expect(
        svc.shelve('00000000-0000-4000-8000-0000000000ff', shelveDto(5), engineer),
      ).rejects.toThrow('Alarma no encontrada');
    });

    it('un usuario de otro cliente no puede postergar, levantar ni leer el diario (403) y nada cambia', async () => {
      const id = await activate();
      const other = { ...engineer, org: { ...ORG, id: 'B' } };
      await expect(svc.shelve(id, shelveDto(5), other)).rejects.toThrow('No tiene acceso');
      await expect(svc.unshelve(id, other)).rejects.toThrow('No tiene acceso');
      await expect(svc.journalOf(id, other)).rejects.toThrow('No tiene acceso');
      expect(alarms.alarms.get(id)?.lifecycle).toBe('unacked');
    });

    it('la auditoría de postergar lleva los minutos pero no el motivo', async () => {
      const id = await activate();
      await svc.shelve(id, shelveDto(45, 'texto libre del operador'), engineer);
      const e = auditRepo.entries.find((x) => x.action === 'alarm.shelve');
      expect(e?.detail).toMatchObject({ plant: 'demo', asset: 'tk-01', minutes: 45 });
      expect(JSON.stringify(e)).not.toContain('texto libre');
    });
  });

  describe('persistencia: reinicio del API', () => {
    it('restaura las postergadas y reprograma su vencimiento (la ya vencida se reanuncia al arrancar)', async () => {
      const id = await activate();
      engine.onTelemetry(tel(95, 'tk-02'), 1500);
      await flush();
      const second = published.find((p) => p.asset === 'tk-02')?.id as string;
      await svc.shelve(id, shelveDto(60), engineer);
      await svc.shelve(second, shelveDto(1), engineer);
      await flush();
      engine.onModuleDestroy();
      await redis.flushall();
      // mientras el API estaba caído venció la segunda
      const rec = alarms.alarms.get(second);
      if (rec) alarms.alarms.set(second, { ...rec, shelvedUntil: Date.now() - 1000 });

      engine = mkEngine();
      await engine.onModuleInit();
      svc = mkSvc();
      expect(engine.pendingShelved()).toContain(id);
      await new Promise((r) => setTimeout(r, 30)); // el temporizador (retardo 0) la reanuncia
      await engine.idle();
      expect(alarms.alarms.get(second)?.lifecycle).toBe('unacked');
      expect(alarms.alarms.get(id)?.lifecycle).toBe('shelved');
      expect(engine.pendingShelved()).toEqual([id]);
      // la postergada no vuelve al hash de activas; la reanunciada sí
      expect(Object.keys(await redis.hgetall(redisKeys.activeAlarms('demo')))).toHaveLength(1);
      // y mientras sigue la condición no se duplican
      engine.onTelemetry(tel(99), 9000);
      await engine.idle();
      expect(alarms.alarms.size).toBe(2);
    });
  });

  describe('supresión: diario y recuento', () => {
    it('la alarma suprimida no existe, pero queda un `suppress` en el diario (sin alarma) por episodio', async () => {
      await rules.update(ruleId, {
        suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 },
      });
      await engine.refresh();
      engine.onTelemetry({ ...tel(0, 'pump-01'), values: { rpm: 0 } }, 500);
      engine.onTelemetry(tel(95), 1000);
      engine.onTelemetry(tel(96), 2000);
      await flush();
      expect(alarms.alarms.size).toBe(0);
      expect(published).toEqual([]);
      const sup = journal.entries.filter((e) => e.type === 'suppress');
      expect(sup).toHaveLength(1);
      expect(sup[0]).toMatchObject({
        alarmId: null,
        plant: 'demo',
        ruleId,
        asset: 'tk-01',
        value: 95,
      });
    });
  });
});
