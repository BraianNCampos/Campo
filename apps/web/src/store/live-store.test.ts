import { beforeEach, describe, expect, it } from 'vitest';
import type { AlarmEvent } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory, readSeries } from './history';
import { reduceBatch, severityByAsset, sortAlarms, useLiveStore } from './live-store';

const alarm = (over: Partial<AlarmEvent>): AlarmEvent => ({
  type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level',
  severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 100, message: '', ...over,
});

beforeEach(() => {
  useLiveStore.getState().reset();
  clearHistory();
});

describe('useLiveStore.applyBatch', () => {
  it('aplica snapshot, ordena ids y guarda histórico', () => {
    const b = emptyBatch();
    b.snapshot = {
      type: 'snapshot', plant: 'demo',
      assets: {
        'valve-01': { ts: 1000, quality: 'good', values: { position: 50 } },
        'tk-01': { ts: 1000, quality: 'good', values: { level: 40, temp: 20 } },
      },
    };
    useLiveStore.getState().applyBatch(b, 5000);
    const s = useLiveStore.getState();
    expect(s.assetIds).toEqual(['tk-01', 'valve-01']);
    expect(s.assets['tk-01']?.values.level).toBe(40);
    expect(s.lastMessageAt).toBe(5000);
    expect(readSeries('tk-01', 'level').v).toEqual([40]);
  });

  it('fusiona telemetría parcial y descarta datos fuera de orden', () => {
    const s0 = useLiveStore.getState();
    const b1 = emptyBatch();
    b1.telemetry['tk-01'] = { ts: 2000, quality: 'good', values: { level: 40, temp: 20 } };
    s0.applyBatch(b1);
    const b2 = emptyBatch();
    b2.telemetry['tk-01'] = { ts: 3000, quality: 'good', values: { level: 45 } };
    useLiveStore.getState().applyBatch(b2);
    expect(useLiveStore.getState().assets['tk-01']?.values).toEqual({ level: 45, temp: 20 });
    const b3 = emptyBatch();
    b3.telemetry['tk-01'] = { ts: 1000, quality: 'good', values: { level: 1 } };
    useLiveStore.getState().applyBatch(b3);
    expect(useLiveStore.getState().assets['tk-01']?.values.level).toBe(45);
  });

  it('mantiene la referencia de assetIds si el conjunto no cambia (sin re-render de listas)', () => {
    const b1 = emptyBatch();
    b1.telemetry['tk-01'] = { ts: 1, quality: 'good', values: { level: 1 } };
    useLiveStore.getState().applyBatch(b1);
    const ids = useLiveStore.getState().assetIds;
    const b2 = emptyBatch();
    b2.telemetry['tk-01'] = { ts: 2, quality: 'good', values: { level: 2 } };
    useLiveStore.getState().applyBatch(b2);
    expect(useLiveStore.getState().assetIds).toBe(ids);
  });

  it('un snapshot nuevo reemplaza los activos (reconexión)', () => {
    const b1 = emptyBatch();
    b1.telemetry['viejo'] = { ts: 1, quality: 'good', values: { level: 1 } };
    useLiveStore.getState().applyBatch(b1);
    const b2 = emptyBatch();
    b2.snapshot = { type: 'snapshot', plant: 'demo', assets: { nuevo: { ts: 2, quality: 'good', values: { level: 2 } } } };
    useLiveStore.getState().applyBatch(b2);
    expect(Object.keys(useLiveStore.getState().assets)).toEqual(['nuevo']);
  });

  it('alarmas: activa, severidad por activo, ack local conservado y cleared', () => {
    const b = emptyBatch();
    b.alarms = [alarm({ id: 'a1' }), alarm({ id: 'a2', severity: 'warning', asset: 'tk-02' })];
    useLiveStore.getState().applyBatch(b);
    expect(Object.keys(useLiveStore.getState().alarms)).toHaveLength(2);
    expect(useLiveStore.getState().alarmSeverityByAsset).toEqual({ 'tk-01': 'critical', 'tk-02': 'warning' });

    useLiveStore.getState().ackLocal('a1');
    expect(useLiveStore.getState().alarms.a1?.acknowledged).toBe(true);

    // llega de nuevo "active" sin campo acknowledged → no pierde el ack local
    const b2 = emptyBatch();
    b2.alarms = [alarm({ id: 'a1', value: 97 })];
    useLiveStore.getState().applyBatch(b2);
    expect(useLiveStore.getState().alarms.a1).toMatchObject({ value: 97, acknowledged: true });

    const b3 = emptyBatch();
    b3.alarms = [alarm({ id: 'a1', state: 'cleared' })];
    useLiveStore.getState().applyBatch(b3);
    expect(useLiveStore.getState().alarms.a1).toBeUndefined();
    expect(useLiveStore.getState().alarmSeverityByAsset).toEqual({ 'tk-02': 'warning' });
  });

  it('hydrate sólo rellena si el store está vacío y se marca fromCache hasta el snapshot real', () => {
    useLiveStore.getState().hydrate({ a: { ts: 1, quality: 'good', values: { v: 1 } } });
    expect(useLiveStore.getState().fromCache).toBe(true);
    const b = emptyBatch();
    b.snapshot = { type: 'snapshot', plant: 'demo', assets: { b: { ts: 2, quality: 'good', values: { v: 2 } } } };
    useLiveStore.getState().applyBatch(b);
    expect(useLiveStore.getState().fromCache).toBe(false);
    useLiveStore.getState().hydrate({ c: { ts: 1, quality: 'good', values: { v: 1 } } });
    expect(Object.keys(useLiveStore.getState().assets)).toEqual(['b']);
  });

  it('notifica a subscribe() una vez por lote (no por mensaje)', () => {
    let calls = 0;
    const unsub = useLiveStore.subscribe(() => calls++);
    const b = emptyBatch();
    for (let i = 0; i < 50; i++) b.telemetry[`tk-${i}`] = { ts: 1, quality: 'good', values: { level: i } };
    useLiveStore.getState().applyBatch(b);
    unsub();
    expect(calls).toBe(1);
  });
});

describe('helpers', () => {
  it('reduceBatch es puro (no muta el estado anterior)', () => {
    const state = { assets: {}, catalog: {}, assetIds: [], alarms: {}, alarmSeverityByAsset: {} };
    const b = emptyBatch();
    b.telemetry.a = { ts: 1, quality: 'good', values: { v: 1 } };
    b.alarms = [alarm({})];
    const patch = reduceBatch(state, b);
    expect(state.assets).toEqual({});
    expect(state.alarms).toEqual({});
    expect(patch.assets).toBeDefined();
  });
  it('sortAlarms: críticas, sin reconocer y recientes primero', () => {
    const list = sortAlarms({
      a: alarm({ id: 'a', severity: 'warning', ts: 300 }),
      b: alarm({ id: 'b', ts: 100, acknowledged: true }),
      c: alarm({ id: 'c', ts: 200 }),
      d: alarm({ id: 'd', ts: 250 }),
    });
    expect(list.map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('severityByAsset toma la máxima', () => {
    expect(severityByAsset({ a: alarm({ id: 'a', severity: 'warning' }), b: alarm({ id: 'b', severity: 'critical' }) })).toEqual({ 'tk-01': 'critical' });
  });
});

describe('alarmas WS como upsert por id (contrato de la API)', () => {
  it('el ack llega como el mismo id con acknowledged:true aunque repita state:active', () => {
    const b1 = emptyBatch();
    b1.alarms = [alarm({ id: 'a1', acknowledged: false })];
    useLiveStore.getState().applyBatch(b1);
    const b2 = emptyBatch();
    b2.alarms = [alarm({ id: 'a1', acknowledged: true })];
    useLiveStore.getState().applyBatch(b2);
    const s = useLiveStore.getState();
    expect(Object.keys(s.alarms)).toEqual(['a1']);
    expect(s.alarms.a1?.acknowledged).toBe(true);
  });
  it('repeticiones idénticas de active no duplican', () => {
    for (let i = 0; i < 3; i++) {
      const b = emptyBatch();
      b.alarms = [alarm({ id: 'a1', value: 91 + i })];
      useLiveStore.getState().applyBatch(b);
    }
    expect(Object.keys(useLiveStore.getState().alarms)).toHaveLength(1);
    expect(useLiveStore.getState().alarms.a1?.value).toBe(93);
  });
});
