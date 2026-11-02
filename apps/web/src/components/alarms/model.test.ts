import { describe, expect, it } from 'vitest';
import type { AlarmEvent, AssetDef } from '@campo/shared';
import { EMPTY_FILTERS, alarmTitle, effectiveKind, filterAlarms, hasFilters, limitText, orderAlarms, orderHistory, orderShelved, remainingText, timeText, trendHref, valueText } from './model';

const catalog: Record<string, AssetDef> = {
  'tk-01': { plant: 'demo', id: 'tk-01', name: 'Tanque 01', type: 'tank', model3dRef: null, metadata: {} },
  'clima-01': { plant: 'demo', id: 'clima-01', name: 'Cámara 1', type: 'climate', model3dRef: null, metadata: {} },
};
const al = (o: Partial<AlarmEvent>): AlarmEvent => ({
  type: 'alarm', id: 'a', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'warning', state: 'active', value: 95, threshold: 90, ts: 1000, message: 'Nivel alto', ...o,
});

describe('tipo, textos y límites', () => {
  it('effectiveKind: usa el del servidor o lo deduce', () => {
    expect(effectiveKind(al({ kind: 'DEV' }))).toBe('DEV');
    expect(effectiveKind(al({ severity: 'critical' }))).toBe('HH');
    expect(effectiveKind(al({ severity: 'warning' }))).toBe('HI');
    expect(effectiveKind(al({ severity: 'critical', value: 5, threshold: 10 }))).toBe('LL');
    expect(effectiveKind(al({ severity: 'warning', value: 5, threshold: 10 }))).toBe('LO');
  });
  it('limitText según el tipo', () => {
    expect(limitText(al({ kind: 'HH' }))).toBe('> 90 %');
    expect(limitText(al({ kind: 'LO', threshold: 10 }))).toBe('< 10 %');
    expect(limitText(al({ kind: 'DEV', metric: 'temp', threshold: 6 }))).toBe('± 6 °C del SP');
    expect(limitText(al({ kind: 'ROC', metric: 'pressure', threshold: 2 }))).toBe('2 bar/min');
    expect(valueText(al({ value: 91.234 }))).toBe('91.2 %');
  });
  it('alarmTitle: descripción > mensaje > genérico', () => {
    expect(alarmTitle(al({ rationale: { description: ' Nivel muy alto en Tanque 01. ' } }))).toBe('Nivel muy alto en Tanque 01.');
    expect(alarmTitle(al({}))).toBe('Nivel alto');
    expect(alarmTitle(al({ message: '' }))).toBe('Nivel fuera de límite');
  });
  it('timeText y remainingText', () => {
    expect(timeText(al({ ts: 0 }), 5000)).toBe('hace 5 s');
    expect(timeText({ ...al({ lifecycle: 'rtn_unacked', state: 'cleared', ts: 0 }), clearedAt: 60_000 }, 180_000)).toBe('normalizó hace 2 min');
    expect(remainingText(undefined, 0)).toBe('');
    expect(remainingText(30 * 60_000, 0)).toBe('vuelve en 30 min');
    expect(remainingText(30 * 60_000, -800)).toBe('vuelve en 30 min'); // el reloj de la pantalla puede ir un poco atrasado
    expect(remainingText(125 * 60_000, 0)).toBe('vuelve en 2 h 5 min');
    expect(remainingText(5, 10)).toBe('vence ahora');
  });
});

describe('filtros y orden', () => {
  const list = [
    al({ id: '1', severity: 'warning', kind: 'HI', ts: 100 }),
    al({ id: '2', severity: 'critical', kind: 'HH', ts: 300 }),
    al({ id: '3', severity: 'critical', kind: 'LL', ts: 200, asset: 'clima-01', metric: 'temp', rationale: { description: 'Temperatura muy baja en Cámara 1.' } }),
    al({ id: '4', severity: 'warning', kind: 'DEV', ts: 50, asset: 'clima-01', metric: 'temp' }),
  ];
  const ctx = { catalog };
  it('por prioridad, tipo, módulo y búsqueda (sin tildes ni mayúsculas)', () => {
    expect(filterAlarms(list, EMPTY_FILTERS, ctx)).toHaveLength(4);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, severity: 'critical' }, ctx).map((a) => a.id)).toEqual(['2', '3']);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, kind: 'DEV' }, ctx).map((a) => a.id)).toEqual(['4']);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, module: 'climate' }, ctx).map((a) => a.id)).toEqual(['3', '4']);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, query: 'CAMARA' }, ctx).map((a) => a.id)).toEqual(['3', '4']);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, query: 'tanque 01' }, ctx).map((a) => a.id)).toEqual(['1', '2']);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, query: 'tk-01', severity: 'warning' }, ctx).map((a) => a.id)).toEqual(['1']);
    expect(filterAlarms(list, { ...EMPTY_FILTERS, query: 'muy baja' }, ctx).map((a) => a.id)).toEqual(['3']);
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, query: ' x ' })).toBe(true);
  });
  it('orden: críticas primero y, dentro, la más antigua', () => {
    expect(orderAlarms(list).map((a) => a.id)).toEqual(['3', '2', '4', '1']);
    expect(orderHistory(list).map((a) => a.id)).toEqual(['2', '3', '1', '4']);
    expect(orderShelved([al({ id: 'x', shelvedUntil: 9 }), al({ id: 'y', shelvedUntil: 3 }), al({ id: 'z' })]).map((a) => a.id)).toEqual(['y', 'x', 'z']);
  });
  it('trendHref sólo hacia módulos que el cliente tiene', () => {
    expect(trendHref({ asset: 'tk-01', metric: 'level' }, catalog, ['tanks'])).toBe('/m/tanks?trend=tk-01%3Alevel');
    expect(trendHref({ asset: 'tk-01', metric: 'level' }, catalog, ['climate'])).toBeNull();
    expect(trendHref({ asset: 'nada', metric: 'level' }, catalog, ['tanks'])).toBeNull();
  });
});
