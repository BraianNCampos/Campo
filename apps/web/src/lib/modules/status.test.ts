import { describe, expect, it } from 'vitest';
import type { Limit } from '@campo/shared';
import { resolveScale } from './scale';
import { beyondLimit, cardStatus, isNearLimit, needsAttention } from './status';

const L = (operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning', metric = 'level'): Limit => ({ asset: 'a', metric, operator, threshold, severity });
const S = { min: 0, max: 100 };

describe('isNearLimit (a menos del 10 % de la escala, en la dirección peligrosa)', () => {
  const rows: [string, number, Limit[], { min: number; max: number } | undefined, boolean][] = [
    ['gt: 85 con límite 90 → cerca (5 < 10)', 85, [L('gt', 90)], S, true],
    ['gt: 80 con límite 90 → no (10 no es < 10)', 80, [L('gt', 90)], S, false],
    ['gt: 80.1 → cerca', 80.1, [L('gt', 90)], S, true],
    ['gt: 50 → lejos', 50, [L('gt', 90)], S, false],
    ['gt: ya pasó el límite → no es «cerca» (es alarma)', 95, [L('gt', 90)], S, false],
    ['gt: justo en el umbral no lo cruza ni está cerca', 90, [L('gt', 90)], S, true],
    ['gte: en el umbral ya lo cruzó', 90, [L('gte', 90)], S, false],
    ['lt: 15 con límite 10 → cerca', 15, [L('lt', 10)], S, true],
    ['lt: 25 con límite 10 → no', 25, [L('lt', 10)], S, false],
    ['lt: por debajo del límite → no (es alarma)', 5, [L('lt', 10)], S, false],
    ['lte: en el umbral ya lo cruzó', 10, [L('lte', 10)], S, false],
    ['lte: 12 → cerca', 12, [L('lte', 10)], S, true],
    ['dos límites: cerca del bajo', 14, [L('gt', 90), L('lt', 10)], S, true],
    ['dos límites: cerca del alto', 86, [L('gt', 90), L('lt', 10)], S, true],
    ['dos límites: en el medio', 50, [L('gt', 90), L('lt', 10)], S, false],
    ['varios gt (advertencia 198 / crítica 220), escala 0-242: 190 cerca del primero', 190, [L('gt', 198), L('gt', 220, 'critical')], { min: 0, max: 242 }, true],
    ['activo sin límites', 99, [], S, false],
    ['escala ausente: no se puede decidir', 89, [L('gt', 90)], undefined, false],
    ['escala degenerada', 89, [L('gt', 90)], { min: 5, max: 5 }, false],
    ['valor no finito', NaN, [L('gt', 90)], S, false],
    ['escala no estándar: -10…50, límite 30, valor 26 (6 % cerca; 10 % = 6)', 24.5, [L('gt', 30)], { min: -10, max: 50 }, true],
  ];
  it.each(rows)('%s', (_n, v, limits, scale, expected) => {
    expect(isNearLimit(v, limits, scale)).toBe(expected);
  });

  it('beyondLimit respeta cada operador', () => {
    expect(beyondLimit(90, L('gt', 90))).toBe(false);
    expect(beyondLimit(90, L('gte', 90))).toBe(true);
    expect(beyondLimit(10, L('lt', 10))).toBe(false);
    expect(beyondLimit(10, L('lte', 10))).toBe(true);
  });
});

describe('resolveScale', () => {
  it('metadata.scale manda, tal cual', () => {
    expect(resolveScale({ metadata: { scale: { level: { min: 10, max: 60 } } } }, 'level')).toEqual({ min: 10, max: 60 });
  });
  it('sin metadata usa METRICS', () => {
    expect(resolveScale({ metadata: {} }, 'temp')).toEqual({ min: -10, max: 50 });
    expect(resolveScale(undefined, 'level')).toEqual({ min: 0, max: 100 });
  });
  it('metadata.scale inválida se ignora', () => {
    expect(resolveScale({ metadata: { scale: { level: { min: 5, max: 5 } } } }, 'level')).toEqual({ min: 0, max: 100 });
    expect(resolveScale({ metadata: { scale: { level: 'x' } } }, 'level')).toEqual({ min: 0, max: 100 });
  });
  it('se amplía para que quepan la potencia contratada y los umbrales', () => {
    const s = resolveScale({ metadata: { contractedKw: 220 } }, 'kw', [{ threshold: 220 }]);
    expect(s?.max).toBeGreaterThanOrEqual(220);
    expect(resolveScale({ metadata: {} }, 'pressure', [{ threshold: 8 }])).toEqual({ min: 0, max: 10 });
  });
  it('métrica desconocida: sin escala', () => {
    expect(resolveScale({ metadata: {} }, 'ph')).toBeUndefined();
  });
});

describe('cardStatus', () => {
  const state = (values: Record<string, number>, quality: 'good' | 'bad' | 'uncertain' = 'good') => ({ ts: 1, quality, values });
  const def = { type: 'tank' as const, metadata: {} };
  const base = { def, catalogReady: true, alarmSeverity: undefined, limits: [L('gt', 90, 'critical'), L('lt', 10)] };
  const rows: [string, Parameters<typeof cardStatus>[0], string][] = [
    ['sin telemetría → Sin datos', { ...base, state: undefined }, 'nodata'],
    ['calidad mala → Sin datos', { ...base, state: state({ level: 50 }, 'bad') }, 'nodata'],
    ['en rango', { ...base, state: state({ level: 50 }) }, 'ok'],
    ['cerca del límite alto', { ...base, state: state({ level: 85 }) }, 'near'],
    ['cerca del límite bajo', { ...base, state: state({ level: 14 }) }, 'near'],
    ['ya cruzó el límite pero la alarma aún no llegó → cerca/en el límite', { ...base, state: state({ level: 93 }) }, 'near'],
    ['alarma activa manda', { ...base, state: state({ level: 50 }), alarmSeverity: 'critical' }, 'alarm'],
    ['sin límites nunca es «cerca»', { ...base, limits: [], state: state({ level: 99 }) }, 'ok'],
    ['con datos pero fuera del catálogo → No catalogado', { ...base, def: undefined, state: state({ level: 50 }) }, 'uncataloged'],
    ['sin catálogo cargado aún no se afirma «No catalogado»', { ...base, def: undefined, catalogReady: false, state: state({ level: 50 }) }, 'ok'],
  ];
  it.each(rows)('%s', (_n, input, expected) => {
    expect(cardStatus(input)).toBe(expected);
  });
  it('requieren atención: cerca del límite y alarma', () => {
    expect(['ok', 'near', 'alarm', 'nodata', 'uncataloged'].filter((s) => needsAttention(s as never))).toEqual(['near', 'alarm']);
  });
});
