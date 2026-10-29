import { describe, expect, it } from 'vitest';
import { niceTicks } from './LineChart';

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
