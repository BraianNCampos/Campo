import { describe, expect, it } from 'vitest';
import type { AssetDef, AssetState, Limit, Severity } from '@campo/shared';
import { cardExtras, tankFlowM3h, tankVolume } from './extras';
import { fmtInt, moduleKpis } from './kpis';
import { countItems, moduleAssetIds, moduleBadges, moduleItems, type LiveSnapshot } from './summary';

const def = (id: string, type: AssetDef['type'], metadata: Record<string, unknown> = {}, name = id): AssetDef => ({ plant: 'p', id, name, type, model3dRef: null, metadata });
const st = (values: Record<string, number>): AssetState => ({ ts: 1, quality: 'good', values });

function snap(defs: AssetDef[], data: Record<string, Record<string, number>>, limits: Limit[] = [], alarms: Record<string, Severity> = {}): LiveSnapshot {
  const byAsset: Record<string, Limit[]> = {};
  for (const l of limits) (byAsset[l.asset] ??= []).push(l);
  return {
    catalog: Object.fromEntries(defs.map((d) => [d.id, d])),
    catalogReady: true,
    assets: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, st(v)])),
    alarmSeverityByAsset: alarms,
    limitsByAsset: byAsset,
  };
}
const kpis = (module: Parameters<typeof moduleKpis>[0], s: LiveSnapshot) => Object.fromEntries(moduleKpis(module, moduleItems(module, s)).map((k) => [k.key, k]));
const lim = (asset: string, metric: string, operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning'): Limit => ({ asset, metric, operator, threshold, severity });

describe('KPIs de tanques', () => {
  const defs = [def('tk-a', 'tank', { capacityM3: 60 }, 'Agua'), def('tk-b', 'tank', { capacityM3: 40 }, 'Gasoil'), def('tk-c', 'tank', {}, 'Sin capacidad'), def('p', 'pump')];
  const s = snap(defs, { 'tk-a': { level: 85 }, 'tk-b': { level: 20 }, 'tk-c': { level: 55 }, p: { rpm: 1400 } }, [lim('tk-a', 'level', 'gt', 90, 'critical'), lim('tk-b', 'level', 'lt', 10)], { 'tk-c': 'critical' });
  const k = kpis('tanks', s);
  it('cantidad de tanques (sin contar bombas) y capacidad total (suma de capacityM3)', () => {
    expect(k.tanks?.value).toBe('3');
    expect(k.capacity).toMatchObject({ value: '100', unit: 'm³' });
  });
  it('en alarma, cerca del límite y nivel más bajo con su nombre', () => {
    expect(k.alarm).toMatchObject({ value: '1', tone: 'crit' });
    expect(k.near).toMatchObject({ value: '1', tone: 'warn' }); // tk-a: 85 con límite 90
    expect(k.lowest).toMatchObject({ value: '20.0', unit: '%', hint: 'Gasoil' });
  });
  it('sin datos: guiones y tonos neutros', () => {
    const e = kpis('tanks', snap(defs, {}));
    expect(e.lowest?.value).toBe('—');
    expect(e.alarm).toMatchObject({ value: '0', tone: 'neutral' });
    expect(e.near).toMatchObject({ value: '0', tone: 'neutral' });
  });
});

describe('KPIs de clima', () => {
  const defs = [def('c1', 'climate', {}, 'Cámara'), def('c2', 'climate', {}, 'Depósito')];
  it('promedio, máx/mín y humedad promedio', () => {
    const k = kpis('climate', snap(defs, { c1: { temp: 6, humidity: 60 }, c2: { temp: 26, humidity: 50 } }));
    expect(k.sensors?.value).toBe('2');
    expect(k.temp).toMatchObject({ value: '16.0', unit: '°C', hint: 'máx 26.0 · mín 6.0 °C' });
    expect(k.humidity).toMatchObject({ value: '55', unit: '%' });
  });
  it('un sensor sin humedad no la promedia como cero', () => {
    const k = kpis('climate', snap(defs, { c1: { temp: 6 }, c2: { temp: 8, humidity: 70 } }));
    expect(k.humidity?.value).toBe('70');
  });
  it('en alarma', () => {
    expect(kpis('climate', snap(defs, { c1: { temp: 40 } }, [], { c1: 'warning' })).alarm).toMatchObject({ value: '1', tone: 'crit' });
  });
});

describe('KPIs de energía', () => {
  const defs = [def('e1', 'energy', { contractedKw: 100 }), def('e2', 'energy', { contractedKw: 100 })];
  const limits = [lim('e1', 'kw', 'gt', 90), lim('e1', 'kw', 'gt', 100, 'critical'), lim('e2', 'kw', 'gt', 90)];
  it('potencia total, % de la contratada, factor de potencia medio y cerca del límite', () => {
    const k = kpis('energy', snap(defs, { e1: { kw: 85, pf: 0.9 }, e2: { kw: 35, pf: 0.96 } }, limits));
    expect(k.kw).toMatchObject({ value: '120', unit: 'kW' });
    expect(k.contracted).toMatchObject({ value: '60', unit: '%', hint: 'de 200 kW' });
    expect(k.pf?.value).toBe('0.93');
    expect(k.near).toMatchObject({ value: '1', tone: 'warn' });
  });
  it('sin contratada: no inventa el porcentaje', () => {
    const k = kpis('energy', snap([def('x', 'energy')], { x: { kw: 10 } }));
    expect(k.contracted?.value).toBe('—');
  });
});

describe('KPIs de gas, máquinas y presión/caudal', () => {
  it('gas: caudal total y acumulado', () => {
    const k = kpis('gas', snap([def('g1', 'gas'), def('g2', 'gas')], { g1: { flow: 10.5, total: 1000 }, g2: { flow: 4, total: 2500 } }));
    expect(k.flow).toMatchObject({ value: '14.5', unit: 'm³/h' });
    expect(k.total).toMatchObject({ value: '3 500', unit: 'm³' });
    expect(k.meters?.value).toBe('2');
  });
  it('máquinas: en marcha / detenidas / en alarma (sin datos no cuenta)', () => {
    const defs = [def('m1', 'machine'), def('m2', 'machine'), def('m3', 'machine'), def('m4', 'machine')];
    const k = kpis('machines', snap(defs, { m1: { state: 1 }, m2: { state: 1 }, m3: { state: 0 } }, [], { m2: 'critical' }));
    expect(k.on?.value).toBe('2');
    expect(k.off?.value).toBe('1');
    expect(k.alarm?.value).toBe('1');
    expect(k.machines?.value).toBe('4');
  });
  it('presión máx/mín y caudal total', () => {
    const defs = [def('p1', 'pressure', {}, 'Aire'), def('p2', 'pressure', {}, 'Vapor'), def('f1', 'flow')];
    const k = kpis('flow', snap(defs, { p1: { pressure: 6.4 }, p2: { pressure: 3.1 }, f1: { flow: 52.3 } }));
    expect(k.pmax).toMatchObject({ value: '6.4', unit: 'bar', hint: 'Aire' });
    expect(k.pmin).toMatchObject({ value: '3.1', hint: 'Vapor' });
    expect(k.flow).toMatchObject({ value: '52.3', unit: 'm³/h' });
  });
  it('vista 3D no tiene franja', () => {
    expect(moduleKpis('view3d', [])).toEqual([]);
  });
  it('fmtInt agrupa miles', () => {
    expect(fmtInt(1284000)).toBe('1 284 000');
    expect(fmtInt(999.6)).toBe('1 000');
  });
});

describe('módulos: pertenencia, contadores e insignias', () => {
  const defs = [def('tk', 'tank'), def('pm', 'pump'), def('cl', 'climate'), def('sn', 'sensor')];
  const s = snap(defs, { tk: { level: 50 }, cl: { temp: 20 } }, [lim('cl', 'temp', 'gt', 22)], { tk: 'critical' });
  it('cada activo cae en el módulo de su tipo; el sensor genérico en ninguno', () => {
    expect(moduleAssetIds('tanks', s.catalog)).toEqual(['tk', 'pm']);
    expect(moduleAssetIds('climate', s.catalog)).toEqual(['cl']);
    expect(moduleAssetIds('energy', s.catalog)).toEqual([]);
  });
  it('contadores y estados', () => {
    expect(countItems(moduleItems('tanks', s))).toEqual({ all: 2, attention: 1, alarm: 1, near: 0, nodata: 1 });
    expect(moduleItems('climate', s)[0]?.status).toBe('near');
  });
  it('insignias por módulo (crítica → roja)', () => {
    const b = moduleBadges(['tanks', 'climate', 'gas'], s);
    expect(b.tanks).toEqual({ attention: 1, alarm: 1, critical: true });
    expect(b.climate).toEqual({ attention: 1, alarm: 0, critical: false });
    expect(b.gas).toEqual({ attention: 0, alarm: 0, critical: false });
  });
});

describe('extras de las tarjetas', () => {
  const series = (m: string, rows: [number, number][]) => (metric: string) => (metric === m ? { t: rows.map((r) => r[0]), v: rows.map((r) => r[1]) } : { t: [], v: [] });
  it('tanque: volumen = nivel × capacidad y caudal de llenado derivado de la pendiente', () => {
    expect(tankVolume(50, 60)).toBe(30);
    const rows: [number, number][] = Array.from({ length: 61 }, (_, s) => [s * 1000, 40 + (s / 3600) * 10]); // +10 %/h
    expect(tankFlowM3h({ t: rows.map((r) => r[0]), v: rows.map((r) => r[1]) }, 60)).toBeCloseTo(6, 6); // 10 % de 60 m³
    const e = cardExtras({ def: def('t', 'tank', { capacityM3: 60 }), values: { level: 50, temp: 19.5 }, series: series('level', rows), now: 61_000 });
    expect(e.map((x) => x.label)).toEqual(['Volumen', 'Llenando', 'Temperatura']);
    expect(e[0]?.value).toBe('30.0 m³ de 60');
    expect(e[1]?.value).toBe('6.0 m³/h');
  });
  it('tanque vaciándose y sin movimiento', () => {
    const down: [number, number][] = Array.from({ length: 61 }, (_, s) => [s * 1000, 50 - (s / 3600) * 5]);
    expect(cardExtras({ def: def('t', 'tank', { capacityM3: 40 }), values: { level: 50 }, series: series('level', down), now: 0 })[1]?.label).toBe('Vaciando');
    const flat: [number, number][] = Array.from({ length: 61 }, (_, s) => [s * 1000, 50]);
    expect(cardExtras({ def: def('t', 'tank', { capacityM3: 40 }), values: { level: 50 }, series: series('level', flat), now: 0 })[1]).toEqual({ label: 'Caudal', value: 'sin movimiento' });
  });
  it('tanque sin capacidad: no inventa volumen', () => {
    expect(cardExtras({ def: def('t', 'tank'), values: { level: 50 }, series: series('level', []), now: 0 })).toEqual([]);
  });
  it('energía: mín–máx recientes y % de la contratada', () => {
    const e = cardExtras({ def: def('e', 'energy', { contractedKw: 200 }), values: { kw: 150, pf: 0.93 }, series: series('kw', [[0, 120], [1000, 168], [2000, 150]]), now: 0 });
    expect(e).toEqual([
      { label: 'Mín–máx recientes', value: '120–168 kW' },
      { label: 'De la contratada', value: '75 % de 200 kW' },
      { label: 'Factor de potencia', value: '0.93' },
    ]);
  });
  it('máquina: En marcha / Detenida con el tiempo desde el último cambio visto', () => {
    const e = cardExtras({ def: def('m', 'machine'), values: { state: 1 }, series: series('state', [[0, 0], [1000, 0], [2000, 1], [3000, 1]]), now: 62_000 });
    expect(e).toEqual([{ label: 'Desde', value: 'hace 1 min' }]);
    expect(cardExtras({ def: def('m', 'machine'), values: { state: 0 }, series: series('state', [[0, 0]]), now: 600_000 })[0]).toEqual({ label: 'Desde', value: 'hace más de 10 min' });
  });
  it('clima: ambas métricas; gas: acumulado; válvula: estado', () => {
    expect(cardExtras({ def: def('c', 'climate'), values: { temp: 7.2, humidity: 66 }, series: series('', []), now: 0 }).map((x) => x.value)).toEqual(['7.2 °C', '66 %']);
    expect(cardExtras({ def: def('g', 'gas'), values: { flow: 3, total: 18420 }, series: series('', []), now: 0 })[0]?.value).toBe('18 420 m³');
    expect(cardExtras({ def: def('v', 'valve'), values: { position: 100 }, series: series('', []), now: 0 })[0]?.value).toBe('Abierta');
  });
});
