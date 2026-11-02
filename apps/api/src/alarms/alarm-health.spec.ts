import { DEFAULT_ALARM_POLICY } from '@campo/shared';
import {
  MemoryAlarmHealthRepository,
  MemoryAlarmJournalRepository,
  MemoryAlarmRulesRepository,
  MemoryAlarmsRepository,
  MemoryAuditRepository,
} from '../../test/support/memory-repos';
import { AuditService } from '../audit/audit.service';
import { AlarmHealthService } from './alarm-health.service';
import { sanitizePolicy } from './alarm-health.repository';
import { TEN_MIN_MS, kpiStatus, maxInWindow } from './alarm-kpis';
import type { AlarmRecord } from './alarm.types';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const admin = { id: 'u1', email: 'a@x.test', role: 'admin' as const, plants: ['*'], org: null };

let seq = 0;
const alarm = (over: Partial<AlarmRecord> & { ts: number }): AlarmRecord => ({
  type: 'alarm',
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  ruleId: 'rule-a',
  plant: 'demo',
  asset: 'tk-01',
  metric: 'level',
  severity: 'critical',
  state: 'cleared',
  value: 99,
  threshold: 90,
  message: 'm',
  acknowledged: true,
  lifecycle: 'closed',
  kind: 'HH',
  ...over,
});

describe('KPIs de salud de alarmas (EEMUA 191)', () => {
  let alarms: MemoryAlarmsRepository;
  let journal: MemoryAlarmJournalRepository;
  let rules: MemoryAlarmRulesRepository;
  let repo: MemoryAlarmHealthRepository;
  let audit: MemoryAuditRepository;
  let svc: AlarmHealthService;
  const add = (...list: AlarmRecord[]) => list.forEach((a) => alarms.alarms.set(a.id, a));
  /** n activaciones de una pareja (regla, activo) cada `step` ms desde `from`. */
  const burst = (n: number, from: number, step: number, over: Partial<AlarmRecord> = {}) =>
    Array.from({ length: n }, (_, i) => alarm({ ts: from + i * step, ...over }));

  beforeEach(() => {
    seq = 0;
    alarms = new MemoryAlarmsRepository();
    journal = new MemoryAlarmJournalRepository();
    rules = new MemoryAlarmRulesRepository();
    repo = new MemoryAlarmHealthRepository(alarms, journal, rules, (p) => p === 'demo');
    audit = new MemoryAuditRepository();
    svc = new AlarmHealthService(repo, new AuditService(audit));
  });

  it('sin alarmas: todo en cero y estado ok', async () => {
    const k = await svc.kpis('demo', '24h', NOW);
    expect(k).toEqual({
      window: '24h',
      from: NOW - DAY,
      to: NOW,
      policy: DEFAULT_ALARM_POLICY,
      total: 0,
      perDay: 0,
      perHour: 0,
      peak10min: { count: 0, at: null },
      byPriority: { critical: 0, warning: 0 },
      top: [],
      chattering: [],
      stale: [],
      shelved: 0,
      suppressed: 0,
      outOfService: 0,
      status: 'ok',
    });
  });

  describe('200 activaciones concentradas en un pico', () => {
    const T0 = NOW - 5 * HOUR;
    beforeEach(() => {
      add(...burst(200, T0, 3_000)); // 200 críticas de tk-01 cada 3 s: caben en 10 min (último a +597 s)
      add(
        ...burst(10, NOW - 20 * HOUR, 2 * HOUR, {
          ruleId: 'rule-b',
          asset: 'tk-02',
          metric: 'temp',
          severity: 'warning',
          kind: 'HI',
        }),
      );
    });

    it('números exactos en 24 h', async () => {
      const k = await svc.kpis('demo', '24h', NOW);
      expect(k.total).toBe(210);
      expect(k.perDay).toBe(210);
      expect(k.perHour).toBe(210 / 24);
      expect(k.byPriority).toEqual({ critical: 200, warning: 10 });
      expect(k.peak10min).toEqual({ count: 200, at: T0 });
      expect(k.top).toEqual([
        { ruleId: 'rule-a', asset: 'tk-01', metric: 'level', kind: 'HH', count: 200 },
        { ruleId: 'rule-b', asset: 'tk-02', metric: 'temp', kind: 'HI', count: 10 },
      ]);
      expect(k.chattering).toEqual([
        { ruleId: 'rule-a', asset: 'tk-01', metric: 'level', activations10min: 200 },
      ]);
      // 210/día = 1,4 x 150 pero el pico es 20 x 10: crítico
      expect(k.status).toBe('critical');
    });

    it('7 y 30 días: perDay = total / días y perHour = total / (días x 24)', async () => {
      const k7 = await svc.kpis('demo', '7d', NOW);
      expect(k7.total).toBe(210);
      expect(k7.perDay).toBe(30);
      expect(k7.perHour).toBe(210 / 168);
      expect(k7.from).toBe(NOW - 7 * DAY);
      const k30 = await svc.kpis('demo', '30d', NOW);
      expect(k30.perDay).toBe(7);
      expect(k30.perHour).toBe(210 / 720);
      expect(k30.peak10min.count).toBe(200);
    });

    it('la ventana excluye lo anterior (borde inclusivo en `from`)', async () => {
      add(alarm({ ts: NOW - DAY, ruleId: 'rule-c', asset: 'x' })); // justo en el borde: entra
      add(alarm({ ts: NOW - DAY - 1, ruleId: 'rule-d', asset: 'y' })); // 1 ms antes: no
      add(alarm({ ts: NOW + 1, ruleId: 'rule-e', asset: 'z' })); // futuro: no
      expect((await svc.kpis('demo', '24h', NOW)).total).toBe(211);
      expect((await svc.kpis('demo', '7d', NOW)).total).toBe(212);
    });

    it('ignora las alarmas de otras plantas', async () => {
      add(...burst(50, T0, 1000, { plant: 'otra', ruleId: 'rule-z' }));
      expect((await svc.kpis('demo', '24h', NOW)).total).toBe(210);
      expect((await svc.kpis('otra', '24h', NOW)).total).toBe(50);
    });

    it('la política cambia el estado sin tocar los números', async () => {
      await svc.setPolicy(
        'demo',
        'campos-demo',
        { ratePerDay: 300, peak10min: 200, staleHours: 24 },
        admin,
      );
      const k = await svc.kpis('demo', '24h', NOW);
      expect(k.total).toBe(210);
      expect(k.policy).toEqual({ ratePerDay: 300, peak10min: 200, staleHours: 24 });
      expect(k.status).toBe('ok');
    });
  });

  describe('pico de 10 minutos y desempates', () => {
    it('ventana [t, t+10min): dos alarmas separadas exactamente 10 min no coinciden', () => {
      expect(maxInWindow([0, TEN_MIN_MS])).toEqual({ count: 1, at: 0 });
      expect(maxInWindow([0, TEN_MIN_MS - 1])).toEqual({ count: 2, at: 0 });
      expect(maxInWindow([])).toEqual({ count: 0, at: null });
    });

    it('desliza: gana el primer grupo de mayor tamaño y `at` es su inicio', () => {
      const t = [0, 1, 2, 11 * MIN, 11 * MIN + 1, 11 * MIN + 2, 12 * MIN]; // 3 y luego 4
      expect(maxInWindow(t)).toEqual({ count: 4, at: 11 * MIN });
      const tie = [0, 1000, 20 * MIN, 20 * MIN + 1000];
      expect(maxInWindow(tie)).toEqual({ count: 2, at: 0 });
    });

    it('marcas de tiempo repetidas cuentan todas', () => {
      expect(maxInWindow([5, 5, 5, 5])).toEqual({ count: 4, at: 5 });
    });
  });

  describe('intermitencia (chattering): ≥3 activaciones en 10 min por regla + activo', () => {
    it('2 no; 3 sí; repartidas en ventanas distintas no', async () => {
      add(...burst(2, NOW - HOUR, MIN, { ruleId: 'r2', asset: 'a2' }));
      add(...burst(3, NOW - HOUR, MIN, { ruleId: 'r3', asset: 'a3' }));
      add(...burst(5, NOW - 10 * HOUR, 11 * MIN, { ruleId: 'r4', asset: 'a4' })); // separadas > 10 min
      add(...burst(4, NOW - 2 * HOUR, 3 * MIN, { ruleId: 'r5', asset: 'a5' }));
      const k = await svc.kpis('demo', '24h', NOW);
      expect(k.chattering.map((c) => [c.asset, c.activations10min])).toEqual([
        ['a5', 4],
        ['a3', 3],
      ]);
    });

    it('la misma regla en dos activos se cuenta por separado', async () => {
      add(
        ...burst(2, NOW - HOUR, MIN, { asset: 'a1' }),
        ...burst(2, NOW - HOUR, MIN, { asset: 'a2' }),
      );
      expect((await svc.kpis('demo', '24h', NOW)).chattering).toEqual([]);
    });
  });

  it('top: 10 como máximo, por frecuencia y desempate estable (activo, regla)', async () => {
    for (let i = 0; i < 12; i++) {
      add(
        ...burst(12 - i, NOW - 20 * HOUR, 20 * MIN, {
          ruleId: `r${String(i).padStart(2, '0')}`,
          asset: `a${i}`,
        }),
      );
    }
    const k = await svc.kpis('demo', '24h', NOW);
    expect(k.top).toHaveLength(10);
    expect(k.top.map((t) => t.count)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('top: a igual frecuencia ordena por activo y luego por regla', async () => {
    add(...burst(2, NOW - 5 * HOUR, 20 * MIN, { ruleId: 'zz', asset: 'a0' }));
    add(...burst(2, NOW - 5 * HOUR, 20 * MIN, { ruleId: 'aa', asset: 'a0' }));
    add(...burst(2, NOW - 5 * HOUR, 20 * MIN, { ruleId: 'bb', asset: 'a_' }));
    const k = await svc.kpis('demo', '24h', NOW);
    expect(k.top.map((t) => `${t.asset}/${t.ruleId}`)).toEqual(['a0/aa', 'a0/zz', 'a_/bb']);
  });

  describe('estado según la política (ok / warning hasta 1,5x / critical)', () => {
    it.each([
      [150, 10, 'ok'], // en el objetivo exacto
      [151, 10, 'warning'],
      [225, 10, 'warning'], // 1,5x exacto
      [226, 10, 'critical'],
      [10, 10, 'ok'],
      [10, 11, 'warning'],
      [10, 15, 'warning'],
      [10, 16, 'critical'],
      [100, 16, 'critical'], // manda la peor de las dos medidas
      [0, 0, 'ok'],
    ])('perDay=%d pico=%d -> %s', (perDay, peak, status) => {
      expect(kpiStatus(perDay, peak, DEFAULT_ALARM_POLICY)).toBe(status);
    });

    it('extremo a extremo con alarmas distribuidas', async () => {
      // 100 en 24 h espaciadas 14,4 min: ok. 200 espaciadas 7,2 min (pico 2): 1,33x -> warning. 300: 2x -> critical
      add(...burst(100, NOW - 23 * HOUR, 864_000));
      expect((await svc.kpis('demo', '24h', NOW)).status).toBe('ok');
      alarms.alarms.clear();
      add(...burst(200, NOW - 23 * HOUR, 432_000));
      const w = await svc.kpis('demo', '24h', NOW);
      expect(w.peak10min.count).toBe(2);
      expect(w.status).toBe('warning');
      alarms.alarms.clear();
      add(...burst(300, NOW - 23 * HOUR, 288_000));
      expect((await svc.kpis('demo', '24h', NOW)).status).toBe('critical');
    });
  });

  describe('estancadas, postergadas, suprimidas y fuera de servicio', () => {
    it('stale = activas (no postergadas) desde hace más de staleHours', async () => {
      add(
        alarm({
          ts: NOW - 25 * HOUR,
          state: 'active',
          lifecycle: 'unacked',
          acknowledged: false,
          asset: 'viejo',
        }),
        alarm({ ts: NOW - 30 * HOUR, state: 'active', lifecycle: 'acked', asset: 'viejo2' }),
        alarm({
          ts: NOW - 23 * HOUR,
          state: 'active',
          lifecycle: 'unacked',
          acknowledged: false,
          asset: 'reciente',
        }),
        alarm({ ts: NOW - 40 * HOUR, state: 'active', lifecycle: 'shelved', asset: 'postergada' }),
        alarm({
          ts: NOW - 50 * HOUR,
          state: 'cleared',
          lifecycle: 'rtn_unacked',
          acknowledged: false,
          asset: 'normalizada',
        }),
      );
      const k = await svc.kpis('demo', '24h', NOW);
      expect(k.stale.map((s) => [s.asset, s.since])).toEqual([
        ['viejo2', NOW - 30 * HOUR],
        ['viejo', NOW - 25 * HOUR],
      ]);
      expect(k.shelved).toBe(1);
      await svc.setPolicy('demo', null, { ratePerDay: 150, peak10min: 10, staleHours: 48 }, admin);
      expect((await svc.kpis('demo', '24h', NOW)).stale.map((s) => s.asset)).toEqual([]);
      await svc.setPolicy('demo', null, { ratePerDay: 150, peak10min: 10, staleHours: 24 }, admin);
      expect((await svc.kpis('demo', '24h', NOW)).stale).toHaveLength(2);
    });

    it('suppressed cuenta los `suppress` del diario dentro de la ventana y de la planta', async () => {
      const e = (plant: string, ts: number) => ({
        alarmId: null,
        plant,
        ts,
        type: 'suppress' as const,
      });
      await journal.add([
        e('demo', NOW - HOUR),
        e('demo', NOW - 2 * HOUR),
        e('demo', NOW - 2 * DAY),
        e('otra', NOW - HOUR),
        { alarmId: 'x', plant: 'demo', ts: NOW - HOUR, type: 'ack' },
      ]);
      expect((await svc.kpis('demo', '24h', NOW)).suppressed).toBe(2);
      expect((await svc.kpis('demo', '7d', NOW)).suppressed).toBe(3);
    });

    it('outOfService cuenta las reglas deshabilitadas de la planta', async () => {
      const mk = (plant: string, enabled: boolean) =>
        rules.create({
          plant,
          asset: '*',
          metric: 'level',
          operator: 'gt',
          threshold: 1,
          severity: 'warning',
          forSeconds: 0,
          hysteresis: 0,
          enabled,
        });
      await mk('demo', false);
      await mk('demo', false);
      await mk('demo', true);
      await mk('otra', false);
      expect((await svc.kpis('demo', '24h', NOW)).outOfService).toBe(2);
    });
  });

  describe('política por planta', () => {
    it('por defecto 150 / 10 / 24 y se sustituye por completo', async () => {
      expect(await svc.getPolicy('demo')).toEqual({
        ratePerDay: 150,
        peak10min: 10,
        staleHours: 24,
      });
      const saved = await svc.setPolicy(
        'demo',
        'campos-demo',
        { ratePerDay: 80, peak10min: 5, staleHours: 12 },
        admin,
      );
      expect(saved).toEqual({ ratePerDay: 80, peak10min: 5, staleHours: 12 });
      expect(await svc.getPolicy('demo')).toEqual(saved);
      expect(await svc.getPolicy('otra')).toEqual(DEFAULT_ALARM_POLICY); // no se comparte entre plantas
    });

    it('se audita sin datos sensibles y una planta no registrada da 404', async () => {
      await svc.setPolicy(
        'demo',
        'campos-demo',
        { ratePerDay: 80, peak10min: 5, staleHours: 12 },
        admin,
      );
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'plant.alarm_policy',
        target: 'plant:demo',
        orgId: 'campos-demo',
        detail: { ratePerDay: 80, peak10min: 5, staleHours: 12 },
      });
      await expect(
        svc.setPolicy('fantasma', null, { ratePerDay: 1, peak10min: 1, staleHours: 1 }, admin),
      ).rejects.toThrow('Planta no registrada');
    });

    it('sanitizePolicy completa lo que falte o sea inválido con los valores por defecto', () => {
      expect(sanitizePolicy(null)).toEqual(DEFAULT_ALARM_POLICY);
      expect(sanitizePolicy({ ratePerDay: 20 })).toEqual({
        ratePerDay: 20,
        peak10min: 10,
        staleHours: 24,
      });
      expect(sanitizePolicy({ ratePerDay: -1, peak10min: 'x', staleHours: 5 })).toEqual({
        ratePerDay: 150,
        peak10min: 10,
        staleHours: 5,
      });
    });
  });
});
