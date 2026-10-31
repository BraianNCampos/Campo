import { beforeEach, describe, expect, it } from 'vitest';
import type { AlarmEvent } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory, readSeries } from './history';
import {
  mergeAlarm, reduceBatch, selectAlarmCounts, selectAlarmList, selectAssetNotices, selectShelved, severityByAsset, sortAlarms, useLiveStore,
} from './live-store';

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

describe('ciclo de vida ISA-18.2 en el store', () => {
  const push = (...list: AlarmEvent[]) => {
    const b = emptyBatch();
    b.alarms = list;
    useLiveStore.getState().applyBatch(b);
  };
  const rich = { kind: 'HH' as const, rationale: { description: 'Nivel muy alto', consequence: 'Rebalse', response: 'Cerrar válvula' } };

  it('conserva kind, rationale y lifecycle, y los mantiene si el evento siguiente no los trae', () => {
    push(alarm({ id: 'a1', lifecycle: 'unacked', ...rich }));
    push(alarm({ id: 'a1', lifecycle: 'acked', acknowledged: true, value: 96 }));
    const a = useLiveStore.getState().alarms.a1!;
    expect(a).toMatchObject({ lifecycle: 'acked', kind: 'HH', value: 96, acknowledged: true });
    expect(a.rationale?.response).toBe('Cerrar válvula');
  });

  it('normalizada sin reconocer sigue en la lista con clearedAt; al reconocerla se cierra', () => {
    push(alarm({ id: 'a1', lifecycle: 'unacked', ts: 100 }));
    push(alarm({ id: 'a1', state: 'cleared', lifecycle: 'rtn_unacked', ts: 200 }));
    let s = useLiveStore.getState();
    expect(selectAlarmList(s).map((x) => x.id)).toEqual(['a1']);
    expect(s.alarms.a1?.clearedAt).toBe(200);
    expect(s.alarmSeverityByAsset).toEqual({}); // ya no es una condición activa
    expect(selectAssetNotices(s)['tk-01']).toEqual({ severity: 'critical', lifecycle: 'rtn_unacked' });
    expect(useLiveStore.getState().ackLocal('a1')).toBeDefined();
    s = useLiveStore.getState();
    expect(s.alarms.a1).toBeUndefined();
    push(alarm({ id: 'a1', state: 'cleared', lifecycle: 'closed', ts: 300 }));
    expect(useLiveStore.getState().alarms.a1).toBeUndefined();
  });

  it('postergadas salen de la lista activa y de los contadores de la lista; selectShelved las expone', () => {
    push(
      alarm({ id: 'u', lifecycle: 'unacked' }),
      alarm({ id: 'k', lifecycle: 'acked', severity: 'warning', asset: 'tk-02' }),
      alarm({ id: 's2', lifecycle: 'shelved', shelvedUntil: 900, shelvedReason: 'mantenimiento', asset: 'tk-03' }),
      alarm({ id: 's1', lifecycle: 'shelved', shelvedUntil: 500, severity: 'warning', asset: 'tk-04' }),
    );
    const s = useLiveStore.getState();
    expect(selectAlarmList(s).map((x) => x.id)).toEqual(['u', 'k']);
    expect(selectShelved(s).map((x) => x.id)).toEqual(['s1', 's2']);
    expect(selectShelved(s)[1]?.shelvedReason).toBe('mantenimiento');
    const c = selectAlarmCounts(s);
    expect(c.list).toEqual({ critical: 1, warning: 1, total: 2 });
    expect(c.unacked.total).toBe(1);
    expect(c.acked.warning).toBe(1);
    expect(c.shelved).toEqual({ critical: 1, warning: 1, total: 2 });
    expect(s.alarmSeverityByAsset).toEqual({ 'tk-01': 'critical', 'tk-02': 'warning' });
  });

  it('al reanunciarse una postergada se limpian los campos de shelving', () => {
    push(alarm({ id: 'a1', lifecycle: 'shelved', shelvedUntil: 500, shelvedReason: 'x', ts: 100 }));
    push(alarm({ id: 'a1', lifecycle: 'unacked', ts: 600 }));
    const a = useLiveStore.getState().alarms.a1!;
    expect(a.shelvedUntil).toBeUndefined();
    expect(a.shelvedReason).toBeUndefined();
  });

  it('selectores memoizados: misma referencia si `alarms` no cambia', () => {
    push(alarm({ id: 'a1' }));
    const s = useLiveStore.getState();
    expect(selectAlarmList(s)).toBe(selectAlarmList(s));
    expect(selectAlarmCounts(s)).toBe(selectAlarmCounts(s));
    const b = emptyBatch();
    b.telemetry.x = { ts: 1, quality: 'good', values: { v: 1 } };
    useLiveStore.getState().applyBatch(b);
    expect(selectAlarmList(useLiveStore.getState())).toBe(selectAlarmList(s));
  });

  it('ignora eventos más viejos que el guardado; restoreAlarm revierte un ack optimista', () => {
    push(alarm({ id: 'a1', lifecycle: 'unacked', ts: 500 }));
    push(alarm({ id: 'a1', lifecycle: 'acked', ts: 100 }));
    expect(useLiveStore.getState().alarms.a1?.lifecycle).toBe('unacked');
    const prev = useLiveStore.getState().ackLocal('a1')!;
    expect(useLiveStore.getState().alarms.a1?.lifecycle).toBe('acked');
    useLiveStore.getState().restoreAlarm(prev);
    expect(selectAlarmCounts(useLiveStore.getState()).unacked.total).toBe(1);
  });

  it('el revert antiguo (acknowledged:false con lifecycle acked) cuenta como sin reconocer', () => {
    push(alarm({ id: 'a1', lifecycle: 'unacked' }));
    useLiveStore.getState().ackLocal('a1');
    const a = useLiveStore.getState().alarms.a1!;
    useLiveStore.setState({ alarms: { a1: { ...a, acknowledged: false } } });
    expect(selectAlarmCounts(useLiveStore.getState()).unacked.total).toBe(1);
  });

  it('mergeAlarm: evento cleared sin lifecycle (legado) cierra; upsertAlarms aplica una lista', () => {
    expect(mergeAlarm(undefined, alarm({ state: 'cleared' }))).toBeNull();
    useLiveStore.getState().upsertAlarms([alarm({ id: 'x', lifecycle: 'rtn_unacked', state: 'cleared' }), alarm({ id: 'y' })]);
    expect(Object.keys(useLiveStore.getState().alarms).sort()).toEqual(['x', 'y']);
  });
});
