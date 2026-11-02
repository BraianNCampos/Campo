import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyBatch } from '@/lib/batcher';
import { useLiveStore } from '@/store/live-store';
import { createThrottledDerived } from './derived';

beforeEach(() => {
  useLiveStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe('derivados limitados en frecuencia (sin re-render por mensaje)', () => {
  it('muchos mensajes dentro del intervalo notifican una sola vez, y sólo si el valor cambió', () => {
    vi.useFakeTimers();
    const d = createThrottledDerived((s) => Object.keys(s.assets).length, (a, b) => a === b, 1000);
    const listener = vi.fn();
    const off = d.subscribe(listener);
    for (let i = 0; i < 50; i++) {
      const b = emptyBatch();
      b.telemetry[`a${i}`] = { ts: 1, quality: 'good', values: { x: i } };
      useLiveStore.getState().applyBatch(b);
    }
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(d.getSnapshot()).toBe(50);
    const b = emptyBatch();
    b.telemetry.a0 = { ts: 5, quality: 'good', values: { x: 99 } }; // mismo nº de activos → sin notificación
    useLiveStore.getState().applyBatch(b);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
