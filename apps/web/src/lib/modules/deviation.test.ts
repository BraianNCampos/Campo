import { describe, expect, it } from 'vitest';
import type { Limit } from '@campo/shared';
import { deviationModel, deviationText, limitTag } from './deviation';
import { cardStatus } from './status';

const L = (operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning'): Limit => ({ asset: 'a', metric: 'level', operator, threshold, severity });
const S = { min: 0, max: 100 };
const both = [L('gt', 90, 'critical'), L('lt', 10)];

describe('deviationModel', () => {
  it('sin SP, SP no finito o fuera de la escala → null (se mantiene la barra de rango)', () => {
    for (const sp of [undefined, NaN, Infinity, -5, 120]) expect(deviationModel({ value: 50, setpoint: sp, limits: both, scale: S })).toBeNull();
    expect(deviationModel({ value: 50, setpoint: 60, limits: both, scale: undefined })).toBeNull();
  });

  // [descripción, valor, límites, escala, esperado {pos, state, side}]
  const rows: [string, number, Limit[], { min: number; max: number }, { pos: number; state: string; side: string }][] = [
    ['en el SP', 60, both, S, { pos: 0, state: 'ok', side: 'at' }],
    ['por encima, a mitad del tramo SP→HH (75 de 60→90)', 75, both, S, { pos: 0.5, state: 'ok', side: 'above' }],
    ['por debajo, a mitad del tramo SP→LO (35 de 60→10)', 35, both, S, { pos: -0.5, state: 'ok', side: 'below' }],
    ['arriba: justo 90 % (87 de 60→90) → ámbar', 87, both, S, { pos: 0.9, state: 'near', side: 'above' }],
    ['arriba: 86.9 → aún en rango', 86.9, both, S, { pos: 0.897, state: 'ok', side: 'above' }],
    ['abajo: justo 90 % (15 de 60→10) → ámbar', 15, both, S, { pos: -0.9, state: 'near', side: 'below' }],
    ['abajo: 15.1 → en rango', 15.1, both, S, { pos: -0.898, state: 'ok', side: 'below' }],
    ['cruzó el límite sin alarma todavía → ámbar y pos acotada', 95, both, S, { pos: 1, state: 'near', side: 'above' }],
    ['cruzó el límite bajo sin alarma → ámbar', 3, both, S, { pos: -1, state: 'near', side: 'below' }],
    ['sólo límite alto: lado bajo usa el extremo de la escala (nunca ámbar)', 1, [L('gt', 90)], S, { pos: -0.983, state: 'ok', side: 'below' }],
    ['sólo límite alto: el lado alto sí se evalúa', 88, [L('gt', 90)], S, { pos: 0.933, state: 'near', side: 'above' }],
    ['sin límites: sin ámbar aunque esté en el extremo', 100, [], S, { pos: 1, state: 'ok', side: 'above' }],
  ];
  it.each(rows)('%s', (_n, value, limits, scale, exp) => {
    const m = deviationModel({ value, setpoint: 60, limits, scale })!;
    expect(m.pos).toBeCloseTo(exp.pos, 2);
    expect(m.state).toBe(exp.state);
    expect(m.side).toBe(exp.side);
  });

  it('extremos: el límite más cercano de cada lado; ignora los que están del lado equivocado del SP', () => {
    const m = deviationModel({ value: 60, setpoint: 60, scale: S, limits: [L('gt', 80), L('gt', 90, 'critical'), L('lt', 30, 'critical'), L('lt', 40), L('gt', 50)] })!;
    expect(m.high).toMatchObject({ at: 80, tag: 'HI' });
    expect(m.low).toMatchObject({ at: 40, tag: 'LO' });
  });
  it('rótulos: HH/HI/LO/LL por operador y severidad; el `kind` del contrato manda', () => {
    expect(limitTag(L('gt', 1, 'critical'))).toBe('HH');
    expect(limitTag(L('gte', 1))).toBe('HI');
    expect(limitTag(L('lt', 1))).toBe('LO');
    expect(limitTag(L('lte', 1, 'critical'))).toBe('LL');
    expect(limitTag({ ...L('gt', 1), kind: 'DEV' })).toBe('DEV');
  });
  it('sin límite de un lado, el extremo es el de la escala', () => {
    const m = deviationModel({ value: 60, setpoint: 60, scale: S, limits: [L('gt', 90)] })!;
    expect(m.low).toEqual({ at: 0, tag: '' });
    expect(m.high.at).toBe(90);
  });
  it('alarma activa → rojo, aunque el valor haya vuelto un poco', () => {
    expect(deviationModel({ value: 92, setpoint: 60, limits: both, scale: S, alarm: true })!.state).toBe('alarm');
    expect(deviationModel({ value: 80, setpoint: 60, limits: both, scale: S, alarm: true })!.state).toBe('alarm');
  });
  it('NaN o sin valor → «sin datos», sin posición', () => {
    for (const value of [NaN, undefined]) {
      const m = deviationModel({ value, setpoint: 60, limits: both, scale: S })!;
      expect(m).toMatchObject({ state: 'nodata', pos: 0, offset: undefined });
      expect(deviationText(m, '%', 1)).toBe('sin datos');
    }
  });
  it('SP en el borde de la escala sin límite en ese lado: distancia cero, no divide por cero', () => {
    const m = deviationModel({ value: 5, setpoint: 0, limits: [L('gt', 90)], scale: S })!;
    expect(Number.isFinite(m.pos)).toBe(true);
    expect(m.pos).toBeGreaterThan(0);
    const below = deviationModel({ value: -3, setpoint: 0, limits: [], scale: S })!;
    expect(below.pos).toBe(-1);
    expect(below.state).toBe('ok');
  });
  it('mismo criterio que cardStatus (regla del 90 % desde el SP)', () => {
    const def = { type: 'tank' as const, metadata: { setpoints: { level: 60 } } };
    for (const v of [50, 60, 80, 86.9, 87, 89, 91, 15, 15.1, 14, 8]) {
      const m = deviationModel({ value: v, setpoint: 60, limits: both, scale: S })!;
      const st = cardStatus({ def, catalogReady: true, state: { ts: 1, quality: 'good', values: { level: v } }, alarmSeverity: undefined, limits: both });
      expect(m.state === 'near', `valor ${v}`).toBe(st === 'near');
    }
  });
});

describe('deviationText', () => {
  const m = (value: number) => deviationModel({ value, setpoint: 60, limits: both, scale: S })!;
  it('a X por encima / por debajo del SP, con unidad y decimales', () => {
    expect(deviationText(m(63.2), '%', 1)).toBe('a 3,2 % por encima del SP (60,0 %)');
    expect(deviationText(m(41), 'm', 0)).toBe('a 19 m por debajo del SP (60 m)');
  });
  it('en el SP cuando la diferencia se redondea a cero', () => {
    expect(deviationText(m(60.02), '%', 1)).toBe('en el SP (60,0 %)');
  });
});
