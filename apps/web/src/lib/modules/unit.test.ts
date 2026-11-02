import { describe, expect, it } from 'vitest';
import type { AssetDef, AssetType } from '@campo/shared';
import { DEMO_ASSETS, DEMO_LINKS } from '@/lib/demo-seed';
import { faceplateOf, hasMotor, modeOf, neighborIds, relatedAssets, relatedSummary, stsOf, supportsSetpoint, unitModule } from './unit';

const d = (id: string, type: AssetType, metadata: Record<string, unknown> = {}): AssetDef => ({ plant: 'p', id, name: id, type, model3dRef: null, metadata });

describe('nivel 3: panel frontal', () => {
  it('unitModule: silo→tanks, cinta→machines, nave sin detalle', () => {
    expect(unitModule({ type: 'silo' })).toBe('tanks');
    expect(unitModule({ type: 'conveyor' })).toBe('machines');
    expect(unitModule({ type: 'tank' })).toBe('tanks');
    expect(unitModule({ type: 'structure' })).toBeNull();
    expect(unitModule({ type: 'sensor' })).toBeNull();
  });
  it('STS: la métrica sts manda (0 inactivo … 4 falla); si no, se deduce del tipo', () => {
    expect(stsOf(d('t', 'tank'), { sts: 1 })).toEqual({ code: 1, label: 'Llenando', tone: 'active' });
    expect(stsOf(d('t', 'tank'), { sts: 2 }).label).toBe('Vaciando');
    expect(stsOf(d('t', 'tank'), { sts: 0 })).toMatchObject({ label: 'Inactivo', tone: 'idle' });
    expect(stsOf(d('t', 'tank'), { sts: 4 })).toMatchObject({ label: 'Falla', tone: 'fault' });
    expect(stsOf(d('m', 'machine'), { state: 1 }).label).toBe('En marcha');
    expect(stsOf(d('c', 'conveyor'), { state: 0 }).label).toBe('Detenida');
    expect(stsOf(d('p', 'pump'), { rpm: 1450 }).label).toBe('En marcha');
    expect(stsOf(d('p', 'pump'), { rpm: 3 }).label).toBe('Detenida');
    expect(stsOf(d('v', 'valve'), { position: 100 }).label).toBe('Abierta');
    expect(stsOf(d('v', 'valve'), { position: 50 }).label).toBe('Parcialmente abierta');
    expect(stsOf(d('t', 'tank'), { level: 50 }).label).toBe('—');
    expect(stsOf(undefined, undefined).code).toBeNull();
  });
  it('MODE: 0 manual, 1 automático', () => {
    expect(modeOf({ mode: 0 })).toEqual({ code: 0, label: 'Manual' });
    expect(modeOf({ mode: 1 })?.label).toBe('Automático');
    expect(modeOf({ level: 1 })).toBeNull();
    expect(modeOf(undefined)).toBeNull();
  });
  it('faceplate: PV de la métrica principal, SP, OP (op o válvula asociada), MODE y STS', () => {
    const f = faceplateOf(d('t', 'tank'), { level: 55, mode: 1, sts: 1 }, 60, { position: 85 });
    expect(f.pv).toEqual({ metric: 'level', value: 55 });
    expect(f.sp).toBe(60);
    expect(f.op).toEqual({ value: 85, source: 'valve' });
    expect(f.mode?.label).toBe('Automático');
    expect(f.sts.label).toBe('Llenando');
    expect(faceplateOf(d('t', 'tank'), { level: 55, op: 40 }, undefined, { position: 85 }).op).toEqual({ value: 40, source: 'op' });
    expect(faceplateOf(d('v', 'valve'), { position: 30 }, undefined).op).toEqual({ value: 30, source: 'valve' });
    expect(faceplateOf(d('t', 'tank'), { level: 55 }, undefined).op).toBeNull();
  });
  it('equipos con motor y con setpoint', () => {
    expect(hasMotor('pump') && hasMotor('machine') && hasMotor('conveyor')).toBe(true);
    expect(hasMotor('tank')).toBe(false);
    expect(supportsSetpoint('tank') && supportsSetpoint('silo') && supportsSetpoint('climate') && supportsSetpoint('pressure')).toBe(true);
    expect(supportsSetpoint('pump')).toBe(false);
  });
});

describe('equipos asociados', () => {
  const catalog = Object.fromEntries(DEMO_ASSETS.demo!.map((a) => [a.id, a]));
  it('sin connectsTo en la planta se usan las cañerías de la demo; un tanque ve su válvula y su bomba', () => {
    expect(neighborIds('tk-01', catalog, DEMO_LINKS.demo)).toEqual(['valve-01']);
    expect(relatedAssets('tk-01', catalog, DEMO_LINKS.demo)).toEqual(['valve-01', 'pump-01']);
    expect(relatedAssets('tk-04', catalog, DEMO_LINKS.demo)).toEqual(['valve-02', 'pump-02']);
    expect(relatedAssets('gas-01', catalog, DEMO_LINKS.demo)).toEqual([]);
  });
  it('con connectsTo: en ambos sentidos, sin duplicados ni inexistentes', () => {
    const c = {
      a: d('a', 'tank', { connectsTo: ['v', 'nada'] }),
      v: d('v', 'valve'),
      f: d('f', 'flow', { connectsTo: ['a'] }),
    };
    expect(neighborIds('a', c).sort()).toEqual(['f', 'v']);
    expect(relatedAssets('a', c)).toEqual(['v', 'f']);
    expect(neighborIds('v', c)).toEqual(['a']);
  });
  it('resumen de una línea por tipo', () => {
    expect(relatedSummary({ type: 'valve' }, { position: 100 })).toBe('Abierta · 100 %');
    expect(relatedSummary({ type: 'valve' }, { position: 0 })).toBe('Cerrada · 0 %');
    expect(relatedSummary({ type: 'pump' }, { rpm: 1450 })).toBe('En marcha · 1450 rpm');
    expect(relatedSummary({ type: 'pump' }, { rpm: 0 })).toBe('Detenida');
    expect(relatedSummary({ type: 'flow' }, { flow: 54.2, total: 1200 })).toBe('54,2 m³/h · acumulado 1200 m³');
    expect(relatedSummary({ type: 'tank' }, { level: 61.25 })).toBe('Nivel 61,3 %');
    expect(relatedSummary({ type: 'valve' }, undefined)).toBe('Sin datos');
  });
});
