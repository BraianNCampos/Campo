import { describe, expect, it } from 'vitest';
import { formatPerDay, meterPositions, meterState, priorityShare, ratioText, sinceText } from './health-model';

describe('salud de alarmas: medidores', () => {
  it('meterState coincide con el criterio de la API (ok ≤ 1×, warning ≤ 1,5×, critical)', () => {
    expect(meterState(150, 150)).toBe('ok');
    expect(meterState(151, 150)).toBe('warning');
    expect(meterState(225, 150)).toBe('warning');
    expect(meterState(226, 150)).toBe('critical');
    expect(meterState(5, 0)).toBe('ok');
  });
  it('posiciones: el umbral cae a dos tercios y el relleno se acota', () => {
    expect(meterPositions(75, 150)).toEqual({ fill: 1 / 3, mark: 2 / 3 });
    expect(meterPositions(999, 150).fill).toBe(1);
    expect(meterPositions(-3, 150).fill).toBe(0);
    expect(meterPositions(1, 0)).toEqual({ fill: 0, mark: 0 });
  });
  it('textos', () => {
    expect(ratioText(75, 150)).toBe('50 % del máximo recomendado');
    expect(ratioText(15, 10)).toBe('1,5 veces el máximo recomendado');
    expect(formatPerDay(37.4)).toBe('37,4');
    expect(formatPerDay(12)).toBe('12');
    expect(formatPerDay(230.6)).toBe('231');
    expect(sinceText(26 * 3_600_000)).toBe('26 h');
    expect(sinceText(60 * 3_600_000)).toBe('2 d 12 h');
    expect(sinceText(5000)).toBe('1 min');
  });
  it('priorityShare', () => {
    expect(priorityShare({ critical: 1, warning: 3 })).toEqual({ critical: 0.25, warning: 0.75 });
    expect(priorityShare({ critical: 0, warning: 0 })).toEqual({ critical: 0, warning: 0 });
  });
});
