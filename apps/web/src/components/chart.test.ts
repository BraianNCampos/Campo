import { describe, expect, it } from 'vitest';
import { ageLabel, niceTicks, spreadLabels } from './LineChart';

describe('niceTicks', () => {
  it('genera marcas redondas dentro del rango', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    const t = niceTicks(17.3, 31.9, 4);
    expect(t.every((x) => x >= 17.3 && x <= 31.9)).toBe(true);
    expect(t.length).toBeGreaterThanOrEqual(3);
  });
  it('rango degenerado no entra en bucle infinito', () => {
    expect(niceTicks(5, 5, 4).length).toBeLessThan(10);
  });
});

describe('ageLabel', () => {
  it('segundos, minutos y horas según la ventana', () => {
    expect(ageLabel(0)).toBe('ahora');
    expect(ageLabel(45)).toBe('-45 s');
    expect(ageLabel(450)).toBe('-8 min');
    expect(ageLabel(21600 * 0.75)).toBe('-4,5 h');
    expect(ageLabel(86400 / 2)).toBe('-12 h');
  });
});

describe('spreadLabels', () => {
  it('separa rótulos que se pisan y respeta los bordes', () => {
    const out = spreadLabels([50, 52, 54], 12, 0, 100);
    expect(out[1]! - out[0]!).toBeGreaterThanOrEqual(12);
    expect(out[2]! - out[1]!).toBeGreaterThanOrEqual(12);
    const edge = spreadLabels([95, 96, 99], 12, 0, 100);
    expect(Math.max(...edge)).toBeLessThanOrEqual(100);
    expect(edge[1]! - edge[0]!).toBeGreaterThanOrEqual(12);
  });
  it('no mueve los que ya están separados', () => {
    expect(spreadLabels([10, 40, 80], 12, 0, 100)).toEqual([10, 40, 80]);
  });
});
