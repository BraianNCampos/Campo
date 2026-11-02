import { describe, expect, it } from 'vitest';
import type { AssetDef, Limit, Order } from '@campo/shared';
import { ControlApiError } from './errors';
import { DemoControlEngine, type DemoUser, type EngineContext } from './demo-engine';

const tank: AssetDef = { plant: 'demo', id: 'tk-01', name: 'Tanque 01', type: 'tank', model3dRef: null, tag: 'TNK-101', metadata: { capacityM3: 60, control: { enabled: true, minTarget: 10, maxTarget: 90 } } };
const off: AssetDef = { ...tank, id: 'tk-09', tag: 'TNK-109', metadata: { capacityM3: 60 } };
const hh: Limit = { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical', kind: 'HH' };
const op: DemoUser = { id: 'u1', email: 'op@campo.demo', role: 'operator' };
const viewer: DemoUser = { id: 'u2', email: 've@campo.demo', role: 'viewer' };

function setup(over: { level?: number; module?: boolean } = {}) {
  const natural = over.level ?? 50; // lo que daría la simulación sin órdenes
  const t = { now: 1_000_000, level: natural, moduleOn: over.module ?? true };
  const events: Order[] = [];
  const ctx: EngineContext = {
    now: () => t.now,
    catalog: () => ({ 'tk-01': tank, 'tk-09': off }),
    state: (a) => (a === 'tk-01' || a === 'tk-09' ? { ts: t.now, quality: 'good', values: { level: t.level } } : undefined),
    limits: () => [hh],
    alarms: () => [],
    moduleActive: () => t.moduleOn,
  };
  const engine = new DemoControlEngine({ plant: 'demo', ctx, emit: (o) => events.push(o), rate: 5, acceptMs: 500, runMs: 1000, decaySec: 10 });
  /** avanza el reloj y la simulación, como el bucle de mock-source (el nivel visible sale de `transform`) */
  const advance = (sec: number, step = 0.25) => {
    let peak = t.level;
    for (let s = 0; s < sec; s += step) {
      t.now += step * 1000;
      engine.step(step);
      t.level = engine.transform('tk-01', { level: natural }).level!;
      peak = Math.max(peak, t.level);
    }
    return peak;
  };
  return { t, engine, events, advance };
}

const statuses = (events: Order[], id: string) => events.filter((e) => e.id === id).map((e) => e.status);

describe('DemoControlEngine: dos pasos', () => {
  it('preview no ejecuta nada y devuelve confirmId, resumen, advertencias y vence a los 60 s', () => {
    const { engine, events, t } = setup();
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 80 });
    expect(p.confirmId).toBeTruthy();
    expect(p.expiresAt).toBe(t.now + 60_000);
    expect(p.summary).toMatch(/Llenar TNK-101 \(Tanque 01\) de 50 % a 80 %/);
    expect(p.summary).toMatch(/18 m³/);
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(p.blocked).toBeNull();
    expect(events).toHaveLength(0);
    expect(engine.list()).toHaveLength(0);
  });

  it('execute con el confirmId crea la orden pending y pasa pending → accepted → running → done', () => {
    const { engine, events, advance } = setup();
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 60 });
    const o = engine.execute(op, 'tk-01', p.confirmId);
    expect(o).toMatchObject({ status: 'pending', command: 'fill', target: 60, asset: 'tk-01', tag: 'TNK-101', requestedBy: { email: 'op@campo.demo' } });
    advance(10);
    expect(statuses(events, o.id)).toEqual(['pending', 'accepted', 'running', 'done']);
    const done = engine.list().find((x) => x.id === o.id)!;
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeGreaterThan(done.requestedAt);
    expect(done.reason).toMatch(/Nivel objetivo alcanzado/);
  });

  it('el confirmId es de un solo uso', () => {
    const { engine } = setup();
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 60 });
    engine.execute(op, 'tk-01', p.confirmId);
    expect(() => engine.execute(op, 'tk-01', p.confirmId)).toThrowError(/ya no sirve/);
  });

  it('está atado al usuario y al activo', () => {
    const { engine } = setup();
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 60 });
    expect(() => engine.execute({ ...op, id: 'otro' }, 'tk-01', p.confirmId)).toThrowError(/ya no sirve/);
    expect(() => engine.execute(op, 'tk-09', p.confirmId)).toThrowError(/ya no sirve/);
    expect(() => engine.execute(op, 'tk-01', 'inventado')).toThrowError(/ya no sirve/);
  });

  it('vence a los 60 s', () => {
    const { engine, t } = setup();
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 60 });
    t.now += 60_001;
    expect(() => engine.execute(op, 'tk-01', p.confirmId)).toThrowError(/venció/);
  });

  it('viewer no puede (403) ni previsualizar ni ejecutar', () => {
    const { engine } = setup();
    expect(() => engine.preview(viewer, 'tk-01', { command: 'fill', target: 60 })).toThrowError(/rol no permite/);
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 60 });
    expect(() => engine.execute(viewer, 'tk-01', p.confirmId)).toThrowError(/rol no permite/);
  });

  it('validaciones de entrada', () => {
    const { engine } = setup();
    expect(() => engine.preview(op, 'tk-01', { command: 'fill' })).toThrowError();
    expect(() => engine.preview(op, 'tk-01', { command: 'fill', target: 120 })).toThrowError();
    expect(() => engine.preview(op, 'tk-01', { command: 'open' as never, target: 60 })).toThrowError();
    expect(() => engine.preview(op, 'nada', { command: 'stop' })).toThrowError();
  });
});

describe('DemoControlEngine: enclavamientos', () => {
  it('preview informa `blocked` (módulo, habilitación, dirección, rango)', () => {
    expect(setup({ module: false }).engine.preview(op, 'tk-01', { command: 'fill', target: 80 }).blocked).toMatch(/no está contratado/);
    expect(setup().engine.preview(op, 'tk-09', { command: 'fill', target: 80 }).blocked).toMatch(/no está habilitado/);
    expect(setup().engine.preview(op, 'tk-01', { command: 'fill', target: 30 }).blocked).toMatch(/No hace falta llenar/);
    expect(setup().engine.preview(op, 'tk-01', { command: 'fill', target: 95 }).blocked).toMatch(/entre 10 % y 90 %/);
  });
  it('execute vuelve a evaluar y rechaza con 409', () => {
    const { engine } = setup();
    const p = engine.preview(op, 'tk-01', { command: 'fill', target: 30 });
    expect(p.blocked).toBeTruthy();
    expect(() => engine.execute(op, 'tk-01', p.confirmId)).toThrowError(ControlApiError);
  });
  it('una sola orden en curso por activo (order_in_progress)', () => {
    const { engine } = setup();
    engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'fill', target: 80 }).confirmId);
    expect(engine.preview(op, 'tk-01', { command: 'drain', target: 20 }).blocked).toMatch(/Ya hay una orden en curso/);
    const p2 = engine.preview(op, 'tk-01', { command: 'fill', target: 70 });
    expect(() => engine.execute(op, 'tk-01', p2.confirmId)).toThrowError(/Ya hay una orden en curso/);
  });
  it('máximo 10 órdenes por minuto y usuario (429)', () => {
    const { engine, t } = setup();
    for (let i = 0; i < 10; i++) {
      const p = engine.preview(op, 'tk-01', { command: 'stop' });
      engine.execute(op, 'tk-01', p.confirmId);
      t.now += 1000;
    }
    const p = engine.preview(op, 'tk-01', { command: 'stop' });
    expect(() => engine.execute(op, 'tk-01', p.confirmId)).toThrowError(/10 por minuto/);
    t.now += 61_000;
    expect(() => engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'stop' }).confirmId)).not.toThrow();
  });
  it('permisos de enclavamiento del equipo', () => {
    const { engine } = setup();
    const items = engine.interlocksOf(op, 'tk-01');
    expect(items.map((i) => i.id)).toContain('telemetry');
    expect(items.every((i) => i.ok)).toBe(true);
    expect(setup().engine.interlocksOf(op, 'tk-09').some((i) => !i.ok)).toBe(true);
  });
});

describe('DemoControlEngine: la simulación sigue la orden', () => {
  it('el nivel sube hacia el objetivo y se detiene ahí; STS = 1 durante el llenado', () => {
    const { engine, t, advance } = setup({ level: 50 });
    engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'fill', target: 62 }).confirmId);
    advance(2.5); // pending → accepted → running (1 s) y empieza a moverse
    const mid = engine.transform('tk-01', { level: 50 });
    expect(mid.sts).toBe(1);
    expect(mid.mode).toBe(1);
    expect(t.level).toBeGreaterThan(50);
    const peak = advance(6);
    expect(peak).toBeGreaterThan(61.5);
    expect(peak).toBeLessThanOrEqual(62); // llega al objetivo y no lo pasa
    expect(engine.transform('tk-01', { level: 50 }).sts).toBe(0);
  });
  it('vaciar baja el nivel (STS = 2)', () => {
    const { engine, t, advance } = setup({ level: 70 });
    engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'drain', target: 40 }).confirmId);
    advance(3);
    expect(engine.transform('tk-01', { level: 70 }).sts).toBe(2);
    expect(t.level).toBeLessThan(70);
  });
  it('detener cancela la orden en curso y frena el nivel', () => {
    const { engine, t, events, advance } = setup({ level: 50 });
    const fill = engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'fill', target: 85 }).confirmId);
    advance(3);
    const before = t.level;
    expect(before).toBeGreaterThan(50);
    const stop = engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'stop' }).confirmId);
    expect(stop.command).toBe('stop');
    advance(4);
    expect(statuses(events, fill.id).at(-1)).toBe('cancelled');
    expect(statuses(events, stop.id).at(-1)).toBe('done');
    const frozen = t.level;
    advance(1);
    expect(t.level).toBeLessThanOrEqual(frozen); // ya no sube (sólo se diluye hacia lo natural)
    expect(frozen).toBeLessThan(85);
  });
  it('cancelar una orden envía un stop', () => {
    const { engine, events, advance } = setup();
    const fill = engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'fill', target: 85 }).confirmId);
    advance(2);
    engine.cancel(op, fill.id);
    advance(4);
    expect(statuses(events, fill.id).at(-1)).toBe('cancelled');
    expect(engine.list({ asset: 'tk-01' }).some((o) => o.command === 'stop')).toBe(true);
    expect(() => engine.cancel(op, fill.id)).toThrowError(/ya terminó/);
    expect(() => engine.cancel(viewer, fill.id)).toThrowError();
  });
  it('tras terminar, la diferencia con la simulación natural se diluye', () => {
    const { engine, advance } = setup({ level: 50 });
    engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'fill', target: 70 }).confirmId);
    expect(advance(8)).toBeGreaterThan(69);
    advance(60);
    expect(engine.transform('tk-01', { level: 50 }).level).toBeCloseTo(50, 0);
  });
  it('no toca activos sin control habilitado ni otras métricas', () => {
    const { engine } = setup();
    expect(engine.transform('tk-09', { level: 33 })).toEqual({ level: 33 });
    expect(engine.transform('tk-01', { level: 50, temp: 20 }).temp).toBe(20);
  });
  it('corta sola al superar la duración máxima (timeout)', () => {
    const { engine, events, t, advance } = setup({ level: 50 });
    const slow = new DemoControlEngine({
      plant: 'demo', emit: (o) => events.push(o), rate: 0.0001, acceptMs: 100, runMs: 200,
      ctx: { now: () => t.now, catalog: () => ({ 'tk-01': { ...tank, metadata: { control: { enabled: true, minTarget: 10, maxTarget: 90, maxDurationMinutes: 1 } } } }), state: () => ({ ts: t.now, quality: 'good', values: { level: 50 } }), limits: () => [], alarms: () => [], moduleActive: () => true },
    });
    void engine; void advance;
    const o = slow.execute(op, 'tk-01', slow.preview(op, 'tk-01', { command: 'fill', target: 80 }).confirmId);
    for (let i = 0; i < 100; i++) {
      t.now += 1000;
      slow.step(1);
    }
    expect(statuses(events, o.id).at(-1)).toBe('timeout');
  });
  it('list filtra por activo y estado y ordena lo más reciente primero', () => {
    const { engine, t } = setup();
    engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'stop' }).confirmId);
    t.now += 1000;
    engine.execute(op, 'tk-01', engine.preview(op, 'tk-01', { command: 'stop' }).confirmId);
    const all = engine.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.requestedAt).toBeGreaterThan(all[1]!.requestedAt);
    expect(engine.list({ asset: 'tk-09' })).toHaveLength(0);
    expect(engine.list({ status: 'done' })).toHaveLength(0);
    expect(engine.list({ limit: 1 })).toHaveLength(1);
  });
});
