import { describe, expect, it } from 'vitest';
import type { Series } from '@/store/history';
import { computeTrend, formatRate, lastStateChange, sinceText, slopePerHour, trendText } from './trend';

const HOUR = 3_600_000;
/** Serie lineal: `perHour` por hora durante `seconds`, una muestra por segundo. */
function ramp(start: number, perHour: number, seconds: number, noise = 0): Series {
  const t: number[] = [];
  const v: number[] = [];
  for (let s = 0; s <= seconds; s++) {
    t.push(1_000_000 + s * 1000);
    v.push(start + (perHour * s) / 3600 + (noise ? Math.sin(s * 7.3) * noise : 0));
  }
  return { t, v };
}

describe('tendencia por regresión lineal sobre el buffer', () => {
  it('recupera la pendiente exacta de una recta', () => {
    expect(slopePerHour(ramp(20, 10, 120))).toBeCloseTo(10, 6);
    expect(slopePerHour(ramp(20, -4.5, 200))).toBeCloseTo(-4.5, 6);
    expect(slopePerHour(ramp(20, 0, 100))).toBeCloseTo(0, 9);
  });
  it('sin datos suficientes: null (pocas muestras o poco tiempo)', () => {
    expect(slopePerHour({ t: [], v: [] })).toBeNull();
    expect(slopePerHour(ramp(1, 5, 3))).toBeNull(); // 4 muestras
    expect(slopePerHour({ t: [0, 1000, 2000, 3000, 4000, 5000], v: [1, 2, 3, 4, 5, 6] })).toBeNull(); // 5 s
  });
  it('sólo usa la ventana de 5 min', () => {
    const old = ramp(0, 1000, 300); // subida fuerte antigua
    const flat = ramp(300 / 3.6, 0, 400);
    const t = [...old.t.map((x) => x - 1_000_000 - 10_000_000), ...flat.t];
    const v = [...old.v, ...flat.v];
    expect(slopePerHour({ t, v })).toBeCloseTo(0, 6);
  });
  it('dirección con el umbral de «estable» = 3 % de la escala por hora', () => {
    const scale = { min: 0, max: 100 }; // 3 %/h = 3 unidades/h
    expect(computeTrend(ramp(50, 2.9, 120), scale)?.direction).toBe('steady');
    expect(computeTrend(ramp(50, 3.1, 120), scale)?.direction).toBe('up');
    expect(computeTrend(ramp(50, -3.1, 120), scale)?.direction).toBe('down');
    expect(computeTrend(ramp(50, 10, 120), scale)).toMatchObject({ direction: 'up' });
  });
  it('el ruido no inventa una tendencia', () => {
    expect(computeTrend(ramp(20, 0, 240, 0.05), { min: -10, max: 50 })?.direction).toBe('steady');
  });
  it('sin escala nada es «estable» salvo que cambie algo', () => {
    expect(computeTrend(ramp(5, 0, 100), undefined)?.direction).toBe('steady');
    expect(computeTrend(ramp(5, 1, 100), undefined)?.direction).toBe('up');
  });
  it('sin datos suficientes computeTrend devuelve null', () => {
    expect(computeTrend({ t: [], v: [] }, { min: 0, max: 1 })).toBeNull();
    void HOUR;
  });
});

describe('textos de tendencia', () => {
  it('tasa con signo y unidad por hora', () => {
    expect(formatRate(10, 'kW')).toBe('+10 kW/h');
    expect(formatRate(-3.24, '%')).toBe('−3.2 %/h');
    expect(formatRate(2.5, 'm³/h')).toBe('+2.5 m³/h por hora');
    expect(formatRate(1234, '%')).toBe('+1234 %/h');
    expect(formatRate(0.5, '')).toBe('+0.5 por hora');
  });
  it('estable / subiendo / bajando', () => {
    expect(trendText({ direction: 'steady', perHour: 0.1 }, '%')).toBe('→ estable');
    expect(trendText({ direction: 'up', perHour: 10 }, 'kW')).toBe('↗ subiendo +10 kW/h');
    expect(trendText({ direction: 'down', perHour: -2.5 }, '°C')).toBe('↘ bajando −2.5 °C/h');
    expect(trendText(null, '%')).toBe('calculando…');
  });
});

describe('máquinas: último cambio de estado visto', () => {
  it('detecta el cambio más reciente', () => {
    const s: Series = { t: [0, 1000, 2000, 3000, 4000], v: [0, 0, 1, 1, 1] };
    expect(lastStateChange(s)).toEqual({ running: true, since: 2000, observedFrom: 0, changed: true });
  });
  it('sin cambios en el buffer: desde que se empezó a observar', () => {
    const r = lastStateChange({ t: [5000, 6000], v: [1, 1] });
    expect(r).toMatchObject({ running: true, since: 5000, changed: false });
    expect(lastStateChange({ t: [], v: [] })).toBeNull();
  });
  it('textos de «hace cuánto»', () => {
    expect(sinceText(90_000, true)).toBe('hace 1 min');
    expect(sinceText(8_000, true)).toBe('hace 8 s');
    expect(sinceText(400_000, false)).toBe('hace más de 6 min');
    expect(sinceText(3000, false)).toBe('recién visto');
    expect(sinceText(3_900_000, true)).toBe('hace 1 h 5 min');
  });
});
