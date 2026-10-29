import { describe, expect, it, vi } from 'vitest';
import type { AlarmEvent, ServerMessage } from '@campo/shared';
import { addToBatch, createBatcher, emptyBatch, type Batch, type Scheduler } from './batcher';

const tel = (asset: string, ts: number, values: Record<string, number>): ServerMessage => ({
  type: 'telemetry', plant: 'demo', asset, ts, values, quality: 'good',
});
const alarm = (id: string, state: 'active' | 'cleared', ts = 1): AlarmEvent => ({
  type: 'alarm', id, ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level',
  severity: 'critical', state, value: 95, threshold: 90, ts, message: '',
});

function manualScheduler() {
  const pending: (() => void)[] = [];
  const scheduler: Scheduler = {
    request(cb) {
      pending.push(cb);
      return () => {
        const i = pending.indexOf(cb);
        if (i >= 0) pending.splice(i, 1);
      };
    },
  };
  return { scheduler, frame: () => pending.splice(0).forEach((cb) => cb()), pending };
}

describe('addToBatch', () => {
  it('coalesce telemetría por activo: último ts gana y fusiona valores', () => {
    const b = emptyBatch();
    addToBatch(b, tel('tk-01', 1, { level: 10, temp: 20 }));
    addToBatch(b, tel('tk-01', 2, { level: 12 }));
    addToBatch(b, tel('tk-02', 1, { level: 50 }));
    expect(b.telemetry['tk-01']).toEqual({ ts: 2, quality: 'good', values: { level: 12, temp: 20 } });
    expect(Object.keys(b.telemetry)).toHaveLength(2);
    expect(b.count).toBe(3);
  });
  it('ignora telemetría más vieja que la ya acumulada', () => {
    const b = emptyBatch();
    addToBatch(b, tel('a', 10, { v: 1 }));
    addToBatch(b, tel('a', 5, { v: 99 }));
    expect(b.telemetry.a?.values.v).toBe(1);
  });
  it('un snapshot descarta la telemetría previa del lote', () => {
    const b = emptyBatch();
    addToBatch(b, tel('a', 1, { v: 1 }));
    addToBatch(b, { type: 'snapshot', plant: 'demo', assets: { a: { ts: 0, values: { v: 7 }, quality: 'good' } } });
    addToBatch(b, tel('a', 2, { v: 8 }));
    expect(b.snapshot).not.toBeNull();
    expect(b.telemetry.a?.values.v).toBe(8);
  });
  it('alarmas: la última por id gana y se conserva el orden', () => {
    const b = emptyBatch();
    addToBatch(b, alarm('x', 'active'));
    addToBatch(b, alarm('y', 'active'));
    addToBatch(b, alarm('x', 'cleared'));
    expect(b.alarms.map((a) => `${a.id}:${a.state}`)).toEqual(['y:active', 'x:cleared']);
  });
});

describe('createBatcher', () => {
  it('entrega UN lote por frame con todos los mensajes', () => {
    const { scheduler, frame } = manualScheduler();
    const flush = vi.fn<(b: Batch) => void>();
    const b = createBatcher(flush, scheduler);
    for (let i = 0; i < 100; i++) b.push(tel('tk-01', i, { level: i }));
    expect(flush).not.toHaveBeenCalled();
    frame();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[0].telemetry['tk-01']?.values.level).toBe(99);
    expect(flush.mock.calls[0]?.[0].count).toBe(100);
    frame();
    expect(flush).toHaveBeenCalledTimes(1); // sin mensajes nuevos no hay flush
  });
  it('programa un frame nuevo tras cada flush', () => {
    const { scheduler, frame } = manualScheduler();
    const flush = vi.fn();
    const b = createBatcher(flush, scheduler);
    b.push(tel('a', 1, { v: 1 }));
    frame();
    b.push(tel('a', 2, { v: 2 }));
    frame();
    expect(flush).toHaveBeenCalledTimes(2);
  });
  it('flushNow entrega ya y dispose descarta', () => {
    const { scheduler, frame, pending } = manualScheduler();
    const flush = vi.fn();
    const b = createBatcher(flush, scheduler);
    b.push(tel('a', 1, { v: 1 }));
    b.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
    b.push(tel('a', 2, { v: 2 }));
    b.dispose();
    frame();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
