import { describe, expect, it } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { entryOf, type SceneEntry } from '@/lib/catalog';
import { connectionPipes, DEMO_PIPES, fitView, LAYOUT, orthogonalRoute, pipeSetFor, resolvePlacements, sceneBounds, trimPolyline } from './layout';
import { connectionFlow, flowOf } from './Pipes';

const e = (id: string, type: SceneEntry['type'], extra: Partial<SceneEntry> = {}): SceneEntry => ({ id, type, name: id, model3dRef: null, connectsTo: [], ...extra });
const def = (id: string, type: AssetDef['type'], metadata: Record<string, unknown> = {}): AssetDef => ({ plant: 'p', id, name: id, type, model3dRef: null, metadata });

describe('resolvePlacements: metadata → demo → cuadrícula', () => {
  it('metadata.layout manda: posición, y, rotación en rad y escala', () => {
    const p = resolvePlacements([e('a', 'tank', { layout: { x: 4, z: -2, y: 1, rotY: 90, scale: 2 } })]);
    expect(p.a?.position).toEqual([4, 1, -2]);
    expect(p.a?.rotY).toBeCloseTo(Math.PI / 2);
    expect(p.a?.scale).toBe(2);
  });
  it('sin layout: la posición manual de los ids de demo, con escala 1 y sin giro', () => {
    const p = resolvePlacements([e('tk-01', 'tank'), e('pump-01', 'pump')]);
    expect(p['tk-01']).toEqual({ position: LAYOUT['tk-01'], rotY: 0, scale: 1 });
    expect(p['pump-01']?.position).toEqual(LAYOUT['pump-01']);
  });
  it('demo + activo nuevo sin layout → fila trasera (z > 5), sin tocar los conocidos', () => {
    const p = resolvePlacements([e('tk-01', 'tank'), e('nuevo', 'sensor')]);
    expect(p['tk-01']?.position).toEqual(LAYOUT['tk-01']);
    expect(p.nuevo?.position[2]).toBeGreaterThan(5);
  });
  it('ids desconocidos → cuadrícula centrada sin solapes; los que tienen layout no entran en ella', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const p = resolvePlacements([...ids.map((id) => e(id, 'tank')), e('fijo', 'tank', { layout: { x: 100, z: 100 } })]);
    expect(p.fijo?.position).toEqual([100, 0, 100]);
    const keys = new Set(ids.map((id) => p[id]!.position.join()));
    expect(keys.size).toBe(ids.length);
    for (const id of ids) {
      expect(Math.abs(p[id]!.position[0])).toBeLessThan(12);
      expect(p[id]?.scale).toBe(1);
    }
  });
  it('mezcla: unos con layout propio y otros de demo', () => {
    const p = resolvePlacements([e('tk-01', 'tank', { layout: { x: 0, z: 0 } }), e('tk-02', 'tank')]);
    expect(p['tk-01']?.position).toEqual([0, 0, 0]);
    expect(p['tk-02']?.position).toEqual(LAYOUT['tk-02']);
  });
});

describe('tuberías de connectsTo', () => {
  const placements = resolvePlacements([
    e('p1', 'pump', { layout: { x: 0, z: 0 } }),
    e('t1', 'tank', { layout: { x: 10, z: 6 } }),
    e('v1', 'valve', { layout: { x: -8, z: 0 } }),
  ]);

  it('ruta ortogonal: primero el eje de mayor separación', () => {
    expect(orthogonalRoute([0, 0, 0], [10, 0, 6])).toEqual([[0, 0.8, 0], [10, 0.8, 0], [10, 0.8, 6]]);
    expect(orthogonalRoute([0, 0, 0], [3, 0, 8])).toEqual([[0, 0.8, 0], [0, 0.8, 8], [3, 0.8, 8]]);
    expect(orthogonalRoute([0, 0, 0], [5, 0, 0])).toHaveLength(2);
  });
  it('trimPolyline recorta los extremos y descarta tramos demasiado cortos', () => {
    const r = trimPolyline([[0, 0, 0], [4, 0, 0], [4, 0, 3]], 1, 1)!;
    expect(r[0]).toEqual([1, 0, 0]);
    expect(r[r.length - 1]).toEqual([4, 0, 2]);
    expect(trimPolyline([[0, 0, 0], [1, 0, 0]], 0.5, 0.5)).toBeNull();
  });
  it('null si ningún activo declara conexiones (se mantiene el comportamiento anterior)', () => {
    expect(connectionPipes([e('p1', 'pump'), e('t1', 'tank')], placements)).toBeNull();
  });
  it('una tubería por par, ortogonal, con el origen como fuente de caudal; ignora destinos inexistentes y pares repetidos', () => {
    const entries = [
      e('p1', 'pump', { layout: { x: 0, z: 0 }, connectsTo: ['t1', 'no-existe', 'p1'] }),
      e('t1', 'tank', { layout: { x: 10, z: 6 }, connectsTo: ['p1'] }), // inversa: repetida
      e('v1', 'valve', { layout: { x: -8, z: 0 } }),
    ];
    const set = connectionPipes(entries, resolvePlacements(entries))!;
    expect(set.pipes.map((p) => p.id)).toEqual(['p1->t1']);
    const pipe = set.pipes[0]!;
    expect(pipe.sources).toEqual(['p1']);
    expect(set.flows.p1).toEqual({ kind: 'asset', id: 'p1', type: 'pump' });
    for (let i = 1; i < pipe.points.length; i++) {
      const a = pipe.points[i - 1]!, b = pipe.points[i]!;
      expect(Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[2] - b[2]) < 1e-9).toBe(true); // sólo ejes x o z
    }
    expect(pipe.points[0]![0]).toBeGreaterThan(0.5); // recortada por la huella del origen
  });
  it('pipeSetFor: conexiones > tuberías de demo > ninguna', () => {
    const demo = [e('tk-01', 'tank'), e('pump-01', 'pump')];
    expect(pipeSetFor(demo, resolvePlacements(demo))).toBe(DEMO_PIPES);
    const other = [e('x1', 'tank'), e('x2', 'tank')];
    expect(pipeSetFor(other, resolvePlacements(other))).toBeNull();
    const conn = [e('tk-01', 'tank', { connectsTo: ['pump-01'] }), e('pump-01', 'pump')];
    expect(pipeSetFor(conn, resolvePlacements(conn))?.key).toMatch(/^conn:/);
    // si se mueve un activo de demo, sus tuberías manuales ya no encajan: se ocultan
    const moved = [e('tk-01', 'tank', { layout: { x: 30, z: 30 } }), e('pump-01', 'pump')];
    expect(pipeSetFor(moved, resolvePlacements(moved))).toBeNull();
  });
  it('caudal: bomba con rpm>0 o válvula con apertura>0; tanques y sensores no', () => {
    expect(connectionFlow('pump', { rpm: 0 })).toBe(0);
    expect(connectionFlow('pump', { rpm: 1450 })).toBe(1);
    expect(connectionFlow('pump', { rpm: 725 })).toBeCloseTo(0.5);
    expect(connectionFlow('valve', { position: 0 })).toBe(0);
    expect(connectionFlow('valve', { position: 40 })).toBeCloseTo(0.4);
    expect(connectionFlow('tank', { level: 80, rpm: 1450 })).toBe(0);
    expect(connectionFlow('sensor', undefined)).toBe(0);
    expect(flowOf({ kind: 'asset', id: 'p1', type: 'pump' }, { p1: { ts: 1, quality: 'good', values: { rpm: 1450 } } })).toBe(1);
    expect(flowOf({ kind: 'asset', id: 'p1', type: 'pump' }, {})).toBe(0);
  });
});

describe('límites y cámara', () => {
  it('sceneBounds: abarca los activos con su huella; vacío → los de la planta demo', () => {
    const entries = [e('a', 'tank', { layout: { x: -20, z: 0 } }), e('b', 'tank', { layout: { x: 20, z: 10 } })];
    const b = sceneBounds(entries, resolvePlacements(entries));
    expect(b.cx).toBeCloseTo(0);
    expect(b.halfX).toBeGreaterThan(21);
    expect(b.cz).toBeCloseTo(5);
    expect(sceneBounds([], {})).toMatchObject({ cx: -0.5 });
  });
  it('fitView: más lejos cuanto mayor la planta; retrato → vista lateral; objetivo en el centro', () => {
    const small = fitView({ cx: 0, cz: 0, halfX: 3, halfZ: 3 }, 1.6);
    const big = fitView({ cx: 50, cz: -20, halfX: 200, halfZ: 100 }, 1.6);
    expect(big.distance).toBeGreaterThan(small.distance * 5);
    expect(big.target).toEqual([50, 1.3, -20]);
    expect(fitView({ cx: 0, cz: 0, halfX: 9, halfZ: 5 }, 0.5).dir[0]).toBeGreaterThan(fitView({ cx: 0, cz: 0, halfX: 9, halfZ: 5 }, 1.6).dir[0]);
  });
  it('la planta demo conserva el encuadre de siempre (≈22 de distancia en 16:10)', () => {
    const demo = [...Object.keys(LAYOUT)].map((id) => entryOf(def(id, id.startsWith('tk') ? 'tank' : id.startsWith('pump') ? 'pump' : 'valve')));
    const b = sceneBounds(demo, resolvePlacements(demo));
    const f = fitView(b, 1.6);
    expect(f.distance).toBeGreaterThan(21);
    expect(f.distance).toBeLessThan(26);
    expect(f.target[0]).toBeCloseTo(-0.5, 0);
  });
});
