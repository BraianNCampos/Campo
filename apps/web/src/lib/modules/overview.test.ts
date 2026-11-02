import { describe, expect, it } from 'vitest';
import type { AssetDef, Limit, ModuleId } from '@campo/shared';
import { latencyText, moduleHealth, overviewMode, planOverview } from './overview';
import type { LiveSnapshot } from './summary';

const def = (id: string, type: AssetDef['type']): AssetDef => ({ plant: 'p', id, name: id, type, model3dRef: null, metadata: {} });
const lim = (asset: string, operator: Limit['operator'], threshold: number): Limit => ({ asset, metric: 'level', operator, threshold, severity: 'critical' });
const snap = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  catalog: { 'tk-1': def('tk-1', 'tank'), 'tk-2': def('tk-2', 'tank'), 'c-1': def('c-1', 'climate') },
  catalogReady: true,
  assets: {
    'tk-1': { ts: 1, quality: 'good', values: { level: 50 } },
    'tk-2': { ts: 1, quality: 'good', values: { level: 50 } },
    'c-1': { ts: 1, quality: 'good', values: { temp: 20 } },
  },
  alarmSeverityByAsset: {},
  limitsByAsset: { 'tk-1': [lim('tk-1', 'gt', 90)], 'tk-2': [lim('tk-2', 'gt', 90)] },
  ...over,
});

describe('moduleHealth', () => {
  it.each([
    [{ all: 4, alarm: 1, near: 2, nodata: 0 }, 'alarm'],
    [{ all: 4, alarm: 0, near: 1, nodata: 0 }, 'near'],
    [{ all: 4, alarm: 0, near: 0, nodata: 0 }, 'ok'],
    [{ all: 4, alarm: 0, near: 0, nodata: 4 }, 'nodata'],
    [{ all: 4, alarm: 0, near: 0, nodata: 2 }, 'ok'],
    [{ all: 0, alarm: 0, near: 0, nodata: 0 }, 'nodata'],
  ] as const)('%j → %s', (c, exp) => expect(moduleHealth(c)).toBe(exp));
});

describe('planOverview', () => {
  const ids: ModuleId[] = ['tanks', 'climate', 'view3d'];
  it('una entrada por módulo con activos (sin «Vista 3D»), en el orden del registro', () => {
    expect(planOverview(ids, snap()).map((o) => [o.id, o.total, o.status])).toEqual([['tanks', 2, 'ok'], ['climate', 1, 'ok']]);
  });
  it('«Control de llenado» tampoco aparece: no tiene activos propios', () => {
    expect(planOverview(['tanks', 'control'], snap()).map((o) => o.id)).toEqual(['tanks']);
  });
  it('alarma y cerca del límite se agregan por módulo y cuentan los activos que requieren atención', () => {
    const s = snap({
      alarmSeverityByAsset: { 'tk-1': 'critical' },
      assets: { ...snap().assets, 'tk-2': { ts: 1, quality: 'good', values: { level: 89 } } },
    });
    const [tanks, climate] = planOverview(ids, s);
    expect(tanks).toMatchObject({ status: 'alarm', alarm: 1, near: 1, attention: 2 });
    expect(climate).toMatchObject({ status: 'ok', attention: 0 });
  });
  it('no expone valores de instrumentos', () => {
    expect(JSON.stringify(planOverview(ids, snap()))).not.toMatch(/"(value|level|values)"/);
  });
  it('un módulo sin activos en el catálogo o sin datos', () => {
    expect(planOverview(['gas'], snap())[0]).toMatchObject({ total: 0, status: 'nodata' });
    expect(planOverview(['climate'], snap({ assets: {} }))[0]).toMatchObject({ total: 1, status: 'nodata' });
  });
});

describe('overviewMode', () => {
  it.each([
    [[], 'none'],
    [['tanks'], 'redirect'],
    [['view3d'], 'redirect'],
    [['tanks', 'climate'], 'map'],
    [['tanks', 'view3d'], 'scene'],
  ] as [ModuleId[], string][])('%j → %s', (ids, mode) => expect(overviewMode(ids)).toBe(mode));
});

describe('latencyText', () => {
  it('ms, segundos y sin dato', () => {
    expect(latencyText(null)).toBe('—');
    expect(latencyText(NaN)).toBe('—');
    expect(latencyText(41.6)).toBe('42 ms');
    expect(latencyText(1340)).toBe('1,3 s');
  });
});
