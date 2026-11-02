import { describe, expect, it, vi } from 'vitest';
import { bucketMs, DEFAULT_WINDOW, HistoryError, loadHistory, mergeHistoryLive, parseHistory, TREND_WINDOWS, windowById, windowRange } from './history';

describe('ventanas de tendencia', () => {
  it('15 min, 1 h, 6 h y 24 h, con buckets que dan ≤ 130 puntos', () => {
    expect(TREND_WINDOWS.map((w) => w.label)).toEqual(['15 min', '1 h', '6 h', '24 h']);
    for (const w of TREND_WINDOWS) expect(w.ms / bucketMs(w)).toBeLessThanOrEqual(130);
    expect(windowById(DEFAULT_WINDOW).id).toBe('1h');
  });
  it('windowRange termina en `now` y dura la ventana', () => {
    expect(windowRange('15m', 1_000_000)).toEqual({ from: 1_000_000 - 900_000, to: 1_000_000 });
    expect(windowRange('24h', 10 ** 9)).toEqual({ from: 10 ** 9 - 86_400_000, to: 10 ** 9 });
  });
});

describe('mergeHistoryLive', () => {
  const hist = [10, 20, 30, 40].map((t, i) => ({ t: t * 1000, avg: i }));
  it('sin vivo: devuelve el histórico dentro del rango', () => {
    expect(mergeHistoryLive(hist, { t: [], v: [] }, 15_000, 40_000).t).toEqual([20_000, 30_000, 40_000]);
  });
  it('sin histórico: sólo el vivo (modo demo)', () => {
    const r = mergeHistoryLive([], { t: [1, 2, 3], v: [5, 6, 7] }, 0, 10);
    expect(r).toEqual({ t: [1, 2, 3], v: [5, 6, 7] });
  });
  it('el vivo manda donde se solapa: descarta histórico desde su primera muestra', () => {
    const r = mergeHistoryLive(hist, { t: [28_000, 33_000], v: [99, 98] }, 0, 50_000);
    expect(r.t).toEqual([10_000, 20_000, 28_000, 33_000]);
    expect(r.v).toEqual([0, 1, 99, 98]);
  });
  it('descarta el bucket que se solapa con el vivo (no se duplica el tramo)', () => {
    const r = mergeHistoryLive(hist, { t: [35_000], v: [7] }, 0, 50_000, 10_000);
    expect(r.t).toEqual([10_000, 20_000, 35_000]);
  });
  it('ordena, deduplica y descarta no finitos y fuera de rango', () => {
    const r = mergeHistoryLive(
      [{ t: 5, avg: NaN }, { t: 100, avg: 1 }],
      { t: [3, 2, 2, 999], v: [1, 2, 3, 4] }, 0, 200,
    );
    expect(r.t).toEqual([2, 3]);
    expect(r.v[0]).toBe(3);
  });
});

describe('loadHistory', () => {
  it('parseHistory filtra puntos mal formados', () => {
    expect(parseHistory({ points: [{ t: 1, avg: 2 }, { t: 'x', avg: 1 }, null, { t: 3 }] })).toEqual([{ t: 1, avg: 2 }]);
    expect(parseHistory(null)).toEqual([]);
  });
  // `config.mock` depende de las variables NEXT_PUBLIC_*; sin WS_URL el modo demo está activo
  it('en modo demo no llama a la API', async () => {
    const f = vi.fn();
    expect(await loadHistory({ plant: 'demo', asset: 'tk-01', metric: 'level', from: 0, to: 1, bucket: '30s' }, f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('HistoryError lleva el estado HTTP', () => {
    expect(new HistoryError(403).status).toBe(403);
  });
});
