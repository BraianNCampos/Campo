import { describe, expect, it } from 'vitest';
import type { AssetDef, Limit } from '@campo/shared';
import { canEditSetpoint, canOrder, canSeeEquipment, controlConfigOf, evaluateInterlocks, firstBlock, hhActive, isControlEnabled, maxAllowedTarget, summarizeInterlocks, targetRange, type InterlockContext } from './interlocks';

const NONE = Symbol('sin control');
const def = (control: unknown = { enabled: true, minTarget: 10, maxTarget: 90 }, type: AssetDef['type'] = 'tank'): AssetDef => ({
  plant: 'demo', id: 'tk-01', name: 'T', type, model3dRef: null, metadata: control === NONE ? {} : { control },
});
const hh: Limit = { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical', kind: 'HH' };
const hi: Limit = { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 85, severity: 'warning', kind: 'HI' };
const NOW = 1_000_000;

const ctx = (over: Partial<InterlockContext> = {}): InterlockContext => ({
  command: 'fill', target: 80, role: 'operator', moduleActive: true, def: def(), state: { ts: NOW - 1000, values: { level: 50 } }, now: NOW,
  limits: [hh], alarms: [], assetId: 'tk-01', activeOrder: null, ...over,
});

describe('roles', () => {
  it('operator+ ordena; viewer sólo lee; setpoints desde engineer', () => {
    for (const r of ['operator', 'engineer', 'admin', 'platform_admin'] as const) expect(canOrder(r)).toBe(true);
    expect(canOrder('viewer')).toBe(false);
    expect(canOrder(null)).toBe(false);
    expect(canSeeEquipment('operator')).toBe(true);
    expect(canSeeEquipment('viewer')).toBe(false);
    expect(canEditSetpoint('operator')).toBe(false);
    for (const r of ['engineer', 'admin', 'platform_admin'] as const) expect(canEditSetpoint(r)).toBe(true);
  });
});

describe('metadata.control', () => {
  it('lee y sanea; por defecto 5–95', () => {
    expect(controlConfigOf(def({ enabled: true, minTarget: 10, maxTarget: 90, maxDurationMinutes: 60, x: 1 }))).toEqual({ enabled: true, minTarget: 10, maxTarget: 90, maxDurationMinutes: 60 });
    expect(controlConfigOf(def(NONE))).toBeNull();
    expect(isControlEnabled(def({ enabled: false }))).toBe(false);
    expect(isControlEnabled(def({ enabled: true }, 'pump'))).toBe(false);
    expect(targetRange(def({ enabled: true }))).toEqual({ min: 5, max: 95 });
    expect(targetRange(def())).toEqual({ min: 10, max: 90 });
  });
  it('el objetivo máximo baja con el límite HI menos 2 puntos', () => {
    expect(maxAllowedTarget(def(), [hh])).toBe(88); // sin HI, el límite más bajo (HH 90) − 2
    expect(maxAllowedTarget(def(), [hh, hi])).toBe(83); // HI manda
    expect(maxAllowedTarget(def(), [])).toBe(90);
  });
});

describe('evaluateInterlocks', () => {
  it('todo en orden: sin bloqueo', () => {
    const r = evaluateInterlocks(ctx());
    expect(r.blocked).toBeNull();
    expect(summarizeInterlocks(r.items)).toMatchObject({ allOk: true });
  });
  it('viewer no puede (rol)', () => {
    const r = evaluateInterlocks(ctx({ role: 'viewer' }));
    expect(r.blocked).toMatch(/consulta/);
    expect(r.items.find((i) => i.id === 'role')?.ok).toBe(false);
  });
  it('módulo no contratado y equipo no habilitado', () => {
    expect(evaluateInterlocks(ctx({ moduleActive: false })).blocked).toMatch(/no está contratado/);
    expect(evaluateInterlocks(ctx({ def: def({ enabled: false }) })).blocked).toMatch(/no está habilitado/);
  });
  it('sin telemetría reciente (>30 s) o sin datos', () => {
    expect(evaluateInterlocks(ctx({ state: { ts: NOW - 31_000, values: { level: 50 } } })).blocked).toMatch(/31 segundos/);
    expect(evaluateInterlocks(ctx({ state: undefined })).blocked).toMatch(/Todavía no llegaron datos/);
    expect(evaluateInterlocks(ctx({ state: { ts: NOW - 30_000, values: { level: 50 } } })).blocked).toBeNull();
  });
  it('objetivo fuera de [min, max] y por encima del límite alto menos margen', () => {
    expect(evaluateInterlocks(ctx({ target: 95 })).blocked).toMatch(/entre 10 % y 90 %/);
    expect(evaluateInterlocks(ctx({ target: 5 })).blocked).toMatch(/entre 10 % y 90 %/);
    expect(evaluateInterlocks(ctx({ target: 89 })).blocked).toMatch(/demasiado alto/);
    expect(evaluateInterlocks(ctx({ target: 88 })).blocked).toBeNull();
    expect(evaluateInterlocks(ctx({ target: undefined })).blocked).toMatch(/Elegí el nivel objetivo/);
  });
  it('llenar sólo si nivel < objetivo; vaciar sólo si nivel > objetivo', () => {
    expect(evaluateInterlocks(ctx({ command: 'fill', target: 40 })).blocked).toMatch(/No hace falta llenar/);
    expect(evaluateInterlocks(ctx({ command: 'drain', target: 80 })).blocked).toMatch(/No hace falta vaciar/);
    expect(evaluateInterlocks(ctx({ command: 'drain', target: 30 })).blocked).toBeNull();
  });
  it('llenar se bloquea con alarma HH activa; vaciar no', () => {
    const alarm = { asset: 'tk-01', metric: 'level', kind: 'HH' as const, severity: 'critical' as const, state: 'active' as const, lifecycle: 'unacked' as const };
    expect(hhActive('tk-01', [alarm])).toBe(true);
    expect(hhActive('tk-02', [alarm])).toBe(false);
    expect(hhActive('tk-01', [{ ...alarm, state: 'cleared', lifecycle: 'closed' }])).toBe(false);
    expect(evaluateInterlocks(ctx({ alarms: [alarm] })).blocked).toMatch(/HH/);
    expect(evaluateInterlocks(ctx({ command: 'drain', target: 20, alarms: [alarm], state: { ts: NOW, values: { level: 91 } } })).blocked).toBeNull();
  });
  it('una sola orden en curso por activo', () => {
    const r = evaluateInterlocks(ctx({ activeOrder: { command: 'fill', target: 70, status: 'running' } }));
    expect(r.blocked).toMatch(/Ya hay una orden en curso.*llenado a 70 %/);
    expect(evaluateInterlocks(ctx({ activeOrder: { command: 'fill', target: 70, status: 'done' } })).blocked).toBeNull();
  });
  it('stop siempre se permite a operator+ aunque haya otros enclavamientos', () => {
    const bad = ctx({ command: 'stop', target: undefined, moduleActive: false, def: def({ enabled: false }), state: undefined, activeOrder: { command: 'fill', status: 'running' } });
    expect(evaluateInterlocks(bad).blocked).toBeNull();
    expect(evaluateInterlocks({ ...bad, role: 'viewer' }).blocked).toMatch(/consulta/);
  });
  it('firstBlock devuelve el primer enclavamiento que falla', () => {
    const r = evaluateInterlocks(ctx({ moduleActive: false, state: undefined }));
    expect(firstBlock(r.items)?.id).toBe('module');
  });
});
