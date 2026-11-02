import { beforeEach, describe, expect, it } from 'vitest';
import {
  bestSync, ClockSync, LATENCY_CRIT_MS, LATENCY_WARN_MS, latencyLevel, LatencyTracker, OFFSET_WINDOW, percentile, sampleLatency,
  STATS_WINDOW_MS, syncSample,
} from './latency';

describe('offset de reloj', () => {
  it('offset = t1 − (t0 + rtt/2)', () => {
    // servidor 5000 ms adelantado; ida y vuelta de 100 ms simétrica: t1 = t0 + 50 + 5000
    const s = syncSample(1000, 6050, 1100);
    expect(s.rtt).toBe(100);
    expect(s.offset).toBe(5000);
  });
  it('reloj atrasado → offset negativo; rtt nunca negativo', () => {
    expect(syncSample(10_000, 4_040, 10_080).offset).toBe(-6000);
    expect(syncSample(10, 0, 5).rtt).toBe(0);
  });
  it('se queda con la muestra de menor RTT', () => {
    expect(bestSync([{ rtt: 300, offset: 1 }, { rtt: 40, offset: 2 }, { rtt: 90, offset: 3 }])).toEqual({ rtt: 40, offset: 2 });
    expect(bestSync([])).toBeNull();
  });
  it('ventana de las últimas 6: la mejor muestra vieja caduca', () => {
    const c = new ClockSync();
    expect(c.synced).toBe(false);
    expect(c.offset).toBe(0);
    c.add(0, 1000 + 5, 10); // rtt 10, offset 1000
    for (let i = 0; i < OFFSET_WINDOW; i++) c.add(0, 2000 + 50, 100); // rtt 100, offset 2000
    expect(c.offset).toBe(2000);
    expect(c.rtt).toBe(100);
    expect(c.synced).toBe(true);
    c.reset();
    expect(c.synced).toBe(false);
  });
  it('dentro de la ventana gana el menor RTT aunque no sea el último', () => {
    const c = new ClockSync();
    c.add(0, 1000 + 5, 10);
    c.add(0, 2050, 100);
    c.add(0, 3250, 500);
    expect(c.offset).toBe(1000);
  });
});

describe('percentiles y umbrales', () => {
  it('rango más cercano', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile(v, 0)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
  it('umbrales: <500 normal, 500–2000 ámbar, >2000 rojo', () => {
    expect(LATENCY_WARN_MS).toBe(500);
    expect(LATENCY_CRIT_MS).toBe(2000);
    expect(latencyLevel(0)).toBe('ok');
    expect(latencyLevel(499)).toBe('ok');
    expect(latencyLevel(500)).toBe('warn');
    expect(latencyLevel(2000)).toBe('warn');
    expect(latencyLevel(2001)).toBe('crit');
  });
  it('latencia de una muestra = (ahora + offset) − ingestTs', () => {
    expect(sampleLatency(10_000, 5000, 14_800)).toBe(200);
  });
});

describe('LatencyTracker', () => {
  let t: LatencyTracker;
  beforeEach(() => {
    t = new LatencyTracker();
  });

  it('sin sincronización no mide y conserva los pendientes', () => {
    t.noteIngest('a', 1000);
    expect(t.paint(2000)).toBe(0);
    expect(t.pendingCount).toBe(1);
    t.clock.add(0, 50, 100); // offset 0
    expect(t.paint(2000)).toBe(1);
    expect(t.pendingCount).toBe(0);
    expect(t.stats(2000)).toEqual({ p50: 1000, p95: 1000, count: 1 });
  });

  it('mide al pintar con el offset: servidor 5 s adelantado', () => {
    t.clock.add(1000, 6050, 1100); // offset +5000
    t.noteIngest('tk-01', 106_000); // ingesta en reloj del servidor
    // cliente pinta en 101_300 → servidor = 106_300 → 300 ms
    t.paint(101_300);
    expect(t.stats(101_300).p50).toBe(300);
  });

  it('un pendiente por activo (gana el último) y p50/p95 sobre varias muestras', () => {
    t.clock.add(0, 0, 0);
    t.noteIngest('a', 100);
    t.noteIngest('a', 900); // sustituye
    t.paint(1000);
    expect(t.stats(1000).count).toBe(1);
    expect(t.stats(1000).p50).toBe(100);
    for (let i = 1; i <= 20; i++) {
      t.noteIngest('a', 1000 - i * 10);
      t.paint(1000);
    }
    const s = t.stats(1000);
    expect(s.count).toBe(21);
    expect(s.p50).toBeGreaterThan(0);
    expect(s.p95).toBeGreaterThanOrEqual(s.p50 as number);
  });

  it('descarta muestras de más de 60 s y descarta valores absurdos; negativos pequeños → 0', () => {
    t.clock.add(0, 0, 0);
    t.noteIngest('a', 0);
    t.paint(1000);
    t.noteIngest('b', 1000 + 500); // 500 ms en el futuro → absurdo? no: dentro de tolerancia → 0
    t.paint(1000);
    expect(t.stats(1000).count).toBe(2);
    t.noteIngest('c', 1000 + 10_000); // 10 s en el futuro: reloj mal sincronizado
    expect(t.paint(1000)).toBe(0);
    const s = t.stats(1000 + STATS_WINDOW_MS + 1);
    expect(s.count).toBe(0);
    expect(s.p50).toBeNull();
  });

  it('reset limpia todo', () => {
    t.clock.add(0, 0, 0);
    t.noteIngest('a', 0);
    t.paint(10);
    t.reset();
    expect(t.clock.synced).toBe(false);
    expect(t.stats(10).count).toBe(0);
    expect(t.pendingCount).toBe(0);
  });
});
