import { describe, expect, it } from 'vitest';
import type { Limit } from '@campo/shared';
import { resolveScale } from './scale';
import { beyondLimit, cardStatus, isNearLimit, needsAttention, setpointOf } from './status';

const L = (operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning', metric = 'level'): Limit => ({ asset: 'a', metric, operator, threshold, severity });
const S = { min: 0, max: 100 };

describe('isNearLimit (ámbar al llegar al 90 % de la distancia setpoint → límite)', () => {
  // [descripción, valor, límites, escala, setpoint, esperado]
  const rows: [string, number, Limit[], { min: number; max: number } | undefined, number | undefined, boolean][] = [
    // sin setpoint: la distancia va desde el mínimo de la escala (límite superior) o su máximo (inferior)
    ['gt sin SP: 81 = 90 % de 0→90 → cerca', 81, [L('gt', 90)], S, undefined, true],
    ['gt sin SP: 80.9 → aún no', 80.9, [L('gt', 90)], S, undefined, false],
    ['gt sin SP: 50 → lejos', 50, [L('gt', 90)], S, undefined, false],
    ['gt sin SP: ya pasó el límite → no es «cerca» (es alarma)', 95, [L('gt', 90)], S, undefined, false],
    ['gt sin SP: justo en el umbral (no lo cruza) → cerca', 90, [L('gt', 90)], S, undefined, true],
    ['gte: en el umbral ya lo cruzó', 90, [L('gte', 90)], S, undefined, false],
    ['lt sin SP: 19 = 90 % de 100→10 → cerca', 19, [L('lt', 10)], S, undefined, true],
    ['lt sin SP: 19.1 → aún no', 19.1, [L('lt', 10)], S, undefined, false],
    ['lt sin SP: por debajo del límite → no (es alarma)', 5, [L('lt', 10)], S, undefined, false],
    ['lte: en el umbral ya lo cruzó', 10, [L('lte', 10)], S, undefined, false],
    ['lte sin SP: 12 → cerca', 12, [L('lte', 10)], S, undefined, true],
    // con setpoint
    ['gt con SP 50: 90 % de 50→90 = 86 → cerca', 86, [L('gt', 90)], S, 50, true],
    ['gt con SP 50: 85.9 → aún no', 85.9, [L('gt', 90)], S, 50, false],
    ['gt con SP 50: 81 (cerca sin SP) ya no lo es con SP', 81, [L('gt', 90)], S, 50, false],
    ['lt con SP 50: 90 % de 50→10 = 14 → cerca', 14, [L('lt', 10)], S, 50, true],
    ['lt con SP 50: 15 → aún no', 15, [L('lt', 10)], S, 50, false],
    ['SP del lado equivocado del límite se ignora (cae a la escala)', 81, [L('gt', 90)], S, 95, true],
    ['SP igual al límite se ignora', 81, [L('gt', 90)], S, 90, true],
    // varios límites
    ['dos límites: cerca del bajo', 19, [L('gt', 90), L('lt', 10)], S, undefined, true],
    ['dos límites: cerca del alto', 82, [L('gt', 90), L('lt', 10)], S, undefined, true],
    ['dos límites: en el medio', 50, [L('gt', 90), L('lt', 10)], S, undefined, false],
    ['advertencia 198 / crítica 220, escala 0-242: 180 ya está al 90 % de la primera', 180, [L('gt', 198), L('gt', 220, 'critical')], { min: 0, max: 242 }, undefined, true],
    ['advertencia 198 / crítica 220: 170 lejos de ambas', 170, [L('gt', 198), L('gt', 220, 'critical')], { min: 0, max: 242 }, undefined, false],
    ['SP 150 con límites 198/220: 193.2 = 90 % de 150→198', 193.2, [L('gt', 198), L('gt', 220, 'critical')], { min: 0, max: 242 }, 150, true],
    // casos límite
    ['activo sin límites', 99, [], S, undefined, false],
    ['escala ausente y sin SP: no se puede decidir', 89, [L('gt', 90)], undefined, undefined, false],
    ['escala ausente pero con SP: se decide por el SP', 86, [L('gt', 90)], undefined, 50, true],
    ['escala degenerada y sin SP', 89, [L('gt', 90)], { min: 90, max: 90 }, undefined, false],
    ['valor no finito', NaN, [L('gt', 90)], S, undefined, false],
    ['escala -10…50, límite 30: 90 % de -10→30 = 26', 26, [L('gt', 30)], { min: -10, max: 50 }, undefined, true],
    ['escala -10…50, límite 30: 25.9', 25.9, [L('gt', 30)], { min: -10, max: 50 }, undefined, false],
  ];
  it.each(rows)('%s', (_n, v, limits, scale, sp, expected) => {
    expect(isNearLimit(v, limits, scale, sp)).toBe(expected);
  });

  it('beyondLimit respeta cada operador', () => {
    expect(beyondLimit(90, L('gt', 90))).toBe(false);
    expect(beyondLimit(90, L('gte', 90))).toBe(true);
    expect(beyondLimit(10, L('lt', 10))).toBe(false);
    expect(beyondLimit(10, L('lte', 10))).toBe(true);
  });

  it('setpointOf: metadata.setpoints[métrica] o la métrica sp de la telemetría (sólo la principal)', () => {
    const tank = { type: 'tank' as const, metadata: { setpoints: { level: 55, temp: 20 } } };
    expect(setpointOf(tank, {}, 'level')).toBe(55);
    expect(setpointOf(tank, {}, 'temp')).toBe(20);
    const bare = { type: 'tank' as const, metadata: {} };
    expect(setpointOf(bare, { level: 40, sp: 60 }, 'level')).toBe(60);
    expect(setpointOf(bare, { level: 40, sp: 60 }, 'temp')).toBeUndefined();
    expect(setpointOf(bare, { level: 40 }, 'level')).toBeUndefined();
    expect(setpointOf({ type: 'tank', metadata: { setpoints: { level: 'x' } } }, {}, 'level')).toBeUndefined();
    expect(setpointOf(undefined, { sp: 1 }, 'level')).toBeUndefined();
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
    ['cerca del límite alto (≥81 sin setpoint)', { ...base, state: state({ level: 85 }) }, 'near'],
    ['a 80 todavía en rango', { ...base, state: state({ level: 80 }) }, 'ok'],
    ['con setpoint en metadata, 85 ya no es cerca (90 % de 50→90 = 86)', { ...base, def: { type: 'tank' as const, metadata: { setpoints: { level: 50 } } }, state: state({ level: 85 }) }, 'ok'],
    ['con setpoint en la telemetría (sp), 87 es cerca', { ...base, state: state({ level: 87, sp: 50 }) }, 'near'],
    ['cerca del límite bajo (≤19 sin setpoint)', { ...base, state: state({ level: 14 }) }, 'near'],
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
