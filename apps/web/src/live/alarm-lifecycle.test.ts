import { describe, expect, it } from 'vitest';
import type { AlarmEvent } from '@campo/shared';
import { AlarmEngine, AlarmError, buildDemoRules, computeKpis, peakInWindow, suppressionMet, type DemoRule } from './alarm-lifecycle';

const T0 = 1_700_000_000_000;
const S = 1000;

const hh: DemoRule = {
  id: 'tk-01:level:HH', asset: 'tk-01', metric: 'level', kind: 'HH', severity: 'critical', operator: 'gt', threshold: 90, deadband: 2,
  onDelayS: 2, offDelayS: 2, rationale: { description: 'Nivel muy alto en Tanque 01.', consequence: 'Rebalse.', response: 'Cerrá la entrada.' },
};

function setup(rules: DemoRule[] = [hh]) {
  const events: AlarmEvent[] = [];
  const e = new AlarmEngine({ plant: 'demo', rules, emit: (ev) => events.push(ev) });
  /** Avanza el reloj de a 250 ms, como el tick de la demo. */
  let t = T0;
  const run = (secs: number, values?: Record<string, Record<string, number>>) => {
    for (const [a, v] of Object.entries(values ?? {})) e.ingest(a, v);
    const end = t + secs * S;
    while (t < end) {
      t += 250;
      e.step(t);
    }
  };
  return { e, events, run, now: () => t };
}

describe('ciclo de vida ISA-18.2 (reloj falso)', () => {
  it('activa tras el retardo, no antes', () => {
    const { e, events, run } = setup();
    run(1, { 'tk-01': { level: 95 } });
    expect(events).toHaveLength(0);
    run(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'active', lifecycle: 'unacked', acknowledged: false, kind: 'HH', severity: 'critical', asset: 'tk-01' });
    expect(events[0]!.rationale?.consequence).toBe('Rebalse.');
    expect(e.list('active')).toHaveLength(1);
  });

  it('un pico más corto que el retardo no genera alarma', () => {
    const { events, run } = setup();
    run(1, { 'tk-01': { level: 95 } });
    run(1, { 'tk-01': { level: 50 } });
    run(5);
    expect(events).toHaveLength(0);
  });

  it('activa → reconoce → normaliza: queda cerrada', () => {
    const { e, events, run, now } = setup();
    run(3, { 'tk-01': { level: 95 } });
    const id = events[0]!.id;
    const acked = e.ack(id, now(), 'op@x');
    expect(acked).toMatchObject({ state: 'active', lifecycle: 'acked', acknowledged: true });
    run(4, { 'tk-01': { level: 50 } });
    const last = events.at(-1)!;
    expect(last).toMatchObject({ id, state: 'cleared', lifecycle: 'closed' });
    expect(e.list('active')).toHaveLength(0);
    expect(e.list('cleared').map((a) => a.id)).toContain(id);
  });

  it('normaliza sin reconocer: rtn_unacked sigue en la lista hasta reconocer', () => {
    const { e, events, run, now } = setup();
    run(3, { 'tk-01': { level: 95 } });
    const id = events[0]!.id;
    run(4, { 'tk-01': { level: 50 } });
    expect(events.at(-1)).toMatchObject({ state: 'cleared', lifecycle: 'rtn_unacked' });
    expect(e.list('active').map((a) => a.id)).toEqual([id]);
    const closed = e.ack(id, now());
    expect(closed).toMatchObject({ state: 'cleared', lifecycle: 'closed' });
    expect(e.list('active')).toHaveLength(0);
    expect(e.journal(id).map((j) => j.event)).toEqual(['activated', 'cleared', 'acknowledged', 'closed']);
  });

  it('banda muerta: dentro de la banda no normaliza; con retardo de retorno', () => {
    const { events, run } = setup();
    run(3, { 'tk-01': { level: 95 } });
    run(5, { 'tk-01': { level: 89 } }); // < 90 pero > 88: dentro de la banda
    expect(events).toHaveLength(1);
    run(1, { 'tk-01': { level: 87 } });
    expect(events).toHaveLength(1); // falta el retardo de retorno
    run(2);
    expect(events.at(-1)?.lifecycle).toBe('rtn_unacked');
  });

  it('reconocer es idempotente y una alarma desconocida da 404; cerrada da 409', () => {
    const { e, events, run, now } = setup();
    run(3, { 'tk-01': { level: 95 } });
    const id = events[0]!.id;
    e.ack(id, now());
    expect(e.ack(id, now()).lifecycle).toBe('acked');
    expect(() => e.ack('nope', now())).toThrow(AlarmError);
    run(4, { 'tk-01': { level: 50 } });
    expect(() => e.ack(id, now())).toThrow(/no se puede reconocer/);
    expect(() => e.shelve(id, 15, 'x', now())).toThrow(AlarmError);
  });

  it('postergar: sale de la lista, vence solo y se reanuncia si la condición sigue', () => {
    const { e, events, run, now } = setup();
    run(3, { 'tk-01': { level: 95 } });
    const id = events[0]!.id;
    e.ack(id, now());
    const sh = e.shelve(id, 15, 'sensor en revisión', now());
    expect(sh).toMatchObject({ lifecycle: 'shelved', shelvedReason: 'sensor en revisión' });
    expect(sh.shelvedUntil).toBe(now() + 15 * 60_000);
    expect(e.list('active')).toHaveLength(0);
    expect(e.list('shelved')).toHaveLength(1);
    run(14 * 60);
    expect(e.list('shelved')).toHaveLength(1);
    run(61);
    expect(e.list('shelved')).toHaveLength(0);
    expect(e.get(id)).toMatchObject({ state: 'active', lifecycle: 'unacked', acknowledged: false });
    expect(e.get(id)?.shelvedUntil).toBeUndefined();
  });

  it('postergada que normaliza se cierra al vencer; unshelve manual reanuncia', () => {
    const { e, events, run, now } = setup();
    run(3, { 'tk-01': { level: 95 } });
    const id = events[0]!.id;
    e.shelve(id, 1, 'prueba', now());
    run(5, { 'tk-01': { level: 40 } });
    expect(e.get(id)?.lifecycle).toBe('shelved');
    run(60);
    expect(e.get(id)).toMatchObject({ state: 'cleared', lifecycle: 'closed' });

    const b = setup();
    b.run(3, { 'tk-01': { level: 95 } });
    const id2 = b.events[0]!.id;
    b.e.shelve(id2, 30, 'prueba', b.now());
    expect(b.e.unshelve(id2, b.now())).toMatchObject({ lifecycle: 'unacked' });
    expect(() => b.e.unshelve(id2, b.now())).toThrow(/no está postergada/);
  });

  it('rtn_unacked que vuelve a cumplirse se reanuncia con el mismo id', () => {
    const { e, events, run } = setup();
    run(3, { 'tk-01': { level: 95 } });
    const id = events[0]!.id;
    run(4, { 'tk-01': { level: 50 } });
    run(4, { 'tk-01': { level: 96 } });
    expect(e.get(id)).toMatchObject({ state: 'active', lifecycle: 'unacked' });
    expect(e.journal(id).map((j) => j.event)).toContain('reannounced');
  });

  it('LO se activa por debajo y normaliza por encima de umbral + banda', () => {
    const lo: DemoRule = { ...hh, id: 'tk-01:level:LO', kind: 'LO', severity: 'warning', operator: 'lt', threshold: 10 };
    const { events, run } = setup([lo]);
    run(3, { 'tk-01': { level: 8 } });
    expect(events[0]).toMatchObject({ kind: 'LO', severity: 'warning' });
    run(4, { 'tk-01': { level: 11 } });
    expect(events).toHaveLength(1); // 11 < 12: dentro de la banda
    run(4, { 'tk-01': { level: 12 } });
    expect(events.at(-1)?.lifecycle).toBe('rtn_unacked');
  });

  it('DEV: |valor − SP| > umbral', () => {
    const dev: DemoRule = { ...hh, id: 'c:temp:DEV', asset: 'c', metric: 'temp', kind: 'DEV', severity: 'warning', threshold: 6, deadband: 1, setpoint: 20 };
    const { events, run } = setup([dev]);
    run(3, { c: { temp: 24 } });
    expect(events).toHaveLength(0);
    run(3, { c: { temp: 12 } }); // desvío −8
    expect(events[0]).toMatchObject({ kind: 'DEV', threshold: 6 });
    run(4, { c: { temp: 15 } }); // desvío 5: 5 > 6−1? no, 5 <= 5 → normaliza
    expect(events.at(-1)?.lifecycle).toBe('rtn_unacked');
  });

  it('ROC: tasa por minuto sobre la ventana y dirección', () => {
    const roc: DemoRule = { ...hh, id: 'p:pressure:ROC', asset: 'p', metric: 'pressure', kind: 'ROC', severity: 'warning', threshold: 2, deadband: 0, onDelayS: 0, rocWindowS: 30, rocDirection: 'rise' };
    const { events, run, e } = setup([roc]);
    // sube 0,1 bar cada 2 s = 3 bar/min
    let v = 5;
    for (let i = 0; i < 20; i++) {
      v += 0.1;
      run(2, { p: { pressure: v } });
    }
    expect(events.some((x) => x.kind === 'ROC' && x.state === 'active')).toBe(true);
    // baja: con dirección «rise» no activa otra
    const b = setup([roc]);
    let w = 8;
    for (let i = 0; i < 20; i++) {
      w -= 0.1;
      b.run(2, { p: { pressure: w } });
    }
    expect(b.events).toHaveLength(0);
    expect(e.rules[0]!.kind).toBe('ROC');
  });

  it('supresión por estado: con la bomba detenida no se genera y se cuenta', () => {
    const lo: DemoRule = { ...hh, id: 'tk-01:level:LO', kind: 'LO', severity: 'warning', operator: 'lt', threshold: 10, suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 } };
    const { e, events, run, now } = setup([lo]);
    run(5, { 'tk-01': { level: 5 }, 'pump-01': { rpm: 0 } });
    expect(events).toHaveLength(0);
    expect(e.kpis('24h', now()).suppressed).toBe(1);
    run(5, { 'pump-01': { rpm: 1450 } });
    expect(events).toHaveLength(1);
    expect(e.kpis('24h', now()).suppressed).toBe(0);
  });

  it('suppressionMet con los cuatro operadores', () => {
    const s = (operator: 'eq' | 'neq' | 'gt' | 'lt') => ({ asset: 'a', metric: 'm', operator, value: 5 });
    expect(suppressionMet(s('eq'), 5)).toBe(true);
    expect(suppressionMet(s('neq'), 5)).toBe(false);
    expect(suppressionMet(s('gt'), 6)).toBe(true);
    expect(suppressionMet(s('lt'), 6)).toBe(false);
    expect(suppressionMet(s('lt'), undefined)).toBe(false);
  });

  it('override fuerza el valor que ve el motor y se puede quitar', () => {
    const { e, events, run } = setup();
    e.override('tk-01', 'level', 99);
    run(3, { 'tk-01': { level: 20 } });
    expect(events).toHaveLength(1);
    e.override('tk-01', 'level', null);
    run(4);
    expect(events.at(-1)?.lifecycle).toBe('rtn_unacked');
  });

  it('el reloj adelantado envejece alarmas para «estancadas»', () => {
    const { e, run, now } = setup();
    run(3, { 'tk-01': { level: 95 } });
    expect(e.kpis('24h', now()).stale).toHaveLength(0);
    e.advance(25 * 3_600_000);
    expect(e.kpis('24h', now()).stale).toHaveLength(1);
  });
});

describe('reglas y KPIs de la demo', () => {
  it('buildDemoRules incluye los límites sembrados con su tipo, y DEV/ROC', () => {
    const rules = buildDemoRules('demo');
    const kinds = new Set(rules.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['DEV', 'HH', 'HI', 'LO', 'ROC']);
    expect(rules.find((r) => r.id === 'tk-01:level:HH')).toMatchObject({ severity: 'critical', threshold: 90, operator: 'gt' });
    expect(rules.find((r) => r.id === 'tk-01:level:LO')?.suppressWhen).toMatchObject({ asset: 'pump-01' });
    expect(rules.every((r) => r.rationale.description && r.rationale.consequence && r.rationale.response)).toBe(true);
    expect(buildDemoRules('tanques').map((r) => r.kind)).not.toContain('DEV');
  });

  it('peakInWindow: ventana deslizante', () => {
    const m = 60_000;
    expect(peakInWindow([0, m, 2 * m, 30 * m, 31 * m], 10 * m)).toEqual({ count: 3, at: 0 });
    expect(peakInWindow([], 10 * m)).toEqual({ count: 0, at: null });
  });

  it('computeKpis: tasa, pico, top, intermitentes, estancadas y estado', () => {
    const now = T0 + 10 * 86_400_000;
    const act = (min: number, key: string, severity: 'critical' | 'warning' = 'warning') => ({ ts: now - min * 60_000, key, asset: key.split(':')[0]!, metric: 'level', kind: 'LO' as const, severity });
    const activations = [act(5, 'a:level:LO'), act(8, 'a:level:LO'), act(9, 'a:level:LO'), act(300, 'b:level:HH', 'critical'), act(60 * 30, 'c:level:HI')];
    const k = computeKpis({
      activations, active: [{ id: 'x', asset: 'b', metric: 'level', since: now - 30 * 3_600_000 }], shelved: 2, suppressed: 1, outOfService: 3,
      policy: { ratePerDay: 150, peak10min: 10, staleHours: 24 }, window: '24h', now,
    });
    expect(k.total).toBe(4); // la de 30 h queda fuera de 24 h
    expect(k.perDay).toBe(4);
    expect(k.peak10min.count).toBe(3);
    expect(k.byPriority).toEqual({ critical: 1, warning: 3 });
    expect(k.top[0]).toMatchObject({ ruleId: 'a:level:LO', count: 3 });
    expect(k.chattering).toEqual([{ ruleId: 'a:level:LO', asset: 'a', metric: 'level', activations10min: 3 }]);
    expect(k.stale.map((s) => s.id)).toEqual(['x']);
    expect([k.shelved, k.suppressed, k.outOfService]).toEqual([2, 1, 3]);
    expect(k.status).toBe('ok');
    const w7 = computeKpis({ activations, active: [], shelved: 0, suppressed: 0, outOfService: 0, policy: { ratePerDay: 150, peak10min: 10, staleHours: 24 }, window: '7d', now });
    expect(w7.total).toBe(5);
    const bad = (peak: number, per: number) => computeKpis({ activations: Array.from({ length: per }, (_, i) => ({ ...act(i < peak ? 1 : 100 + i, 'z:level:HI'), ts: now - (i < peak ? 1000 + i : (100 + i) * 60_000) })), active: [], shelved: 0, suppressed: 0, outOfService: 0, policy: { ratePerDay: 150, peak10min: 10, staleHours: 24 }, window: '24h', now }).status;
    expect(bad(11, 11)).toBe('warning'); // pico 11 > 10 (≤ 15)
    expect(bad(16, 16)).toBe('critical'); // 16 > 1,5 × 10
  });

  it('seedHistory: historia verosímil con perturbación e intermitente', () => {
    const e = new AlarmEngine({ plant: 'demo' });
    e.seedHistory(T0);
    const k24 = e.kpis('24h', T0);
    const k30 = e.kpis('30d', T0);
    expect(k30.total).toBeGreaterThan(k24.total);
    expect(k24.peak10min.count).toBeGreaterThanOrEqual(11);
    expect(k24.status).toBe('warning');
    expect(k24.chattering.length).toBeGreaterThan(0);
    expect(k30.top).toHaveLength(10);
    expect(e.list('cleared').length).toBeGreaterThan(100);
    expect(e.list('active')).toHaveLength(0);
    const id = e.list('cleared')[0]!.id;
    expect(e.journal(id).map((j) => j.event)).toEqual(expect.arrayContaining(['activated', 'acknowledged', 'cleared', 'closed']));
  });
});
