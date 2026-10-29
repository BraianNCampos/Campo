import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, getHistoryVersion, HISTORY_CAPACITY, pushSample, readSeries, subscribeHistory } from './history';

beforeEach(() => clearHistory());

describe('history', () => {
  it('guarda muestras en orden y limita por maxPoints / since', () => {
    for (let i = 0; i < 10; i++) pushSample('a', 'm', i * 1000, i);
    expect(readSeries('a', 'm').v).toHaveLength(10);
    expect(readSeries('a', 'm', 3).v).toEqual([7, 8, 9]);
    expect(readSeries('a', 'm', 100, 7000).t).toEqual([7000, 8000, 9000]);
    expect(readSeries('a', 'otra').v).toEqual([]);
  });
  it('muestras dentro del intervalo mínimo sobrescriben la última', () => {
    pushSample('a', 'm', 1000, 1);
    pushSample('a', 'm', 1100, 2);
    pushSample('a', 'm', 1200, 3);
    expect(readSeries('a', 'm').v).toEqual([3]);
    pushSample('a', 'm', 1700, 4);
    expect(readSeries('a', 'm').v).toEqual([3, 4]);
  });
  it('con telemetría rápida (250 ms) sigue creando una muestra por ranura de 500 ms', () => {
    for (let i = 0; i < 40; i++) pushSample('a', 'm', i * 250, i); // 10 s
    const s = readSeries('a', 'm');
    expect(s.v.length).toBeGreaterThanOrEqual(19);
    expect(s.v.length).toBeLessThanOrEqual(21);
    expect(s.v[s.v.length - 1]).toBe(39);
  });
  it('buffer circular: conserva sólo las últimas HISTORY_CAPACITY', () => {
    const n = HISTORY_CAPACITY + 50;
    for (let i = 0; i < n; i++) pushSample('a', 'm', i * 1000, i);
    const s = readSeries('a', 'm');
    expect(s.v).toHaveLength(HISTORY_CAPACITY);
    expect(s.v[0]).toBe(50);
    expect(s.v[s.v.length - 1]).toBe(n - 1);
  });
  it('notifica a los suscriptores como máximo cada ~500 ms', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const unsub = subscribeHistory(cb);
    const v0 = getHistoryVersion();
    for (let i = 0; i < 20; i++) pushSample('a', 'm', i * 1000, i);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getHistoryVersion()).toBe(v0 + 1);
    unsub();
    vi.useRealTimers();
  });
});
