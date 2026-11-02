import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { SceneEntry } from '@/lib/catalog';
import { BELT_V_MAX, buildConveyorGeometry, conveyorLabel, conveyorSpeed } from './Conveyor';
import { buildPipeSupports } from './Pipes';
import { buildSiloGeometry, GAUGE_H, SILO_TOP } from './Silo';
import { buildHallGeometry, buildRackGeometry, buildSlabGeometry } from './Structure';
import { buildTankGeometry } from './Tank';
import { buildPipe } from './pipe-geometry';
import { FOOTPRINT, footprint, packPlacements, resolvePlacements, sceneBounds, structureSpec } from './layout';
import { detectQuality, forcedQuality, QUALITY_PROFILE, stepDown, stepUp } from './quality';
import { jointLines } from './kit/lines';

const e = (id: string, type: SceneEntry['type'], extra: Partial<SceneEntry> = {}): SceneEntry => ({ id, type, name: id, model3dRef: null, connectsTo: [], ...extra });

function sane(geo: Record<string, THREE.BufferGeometry>) {
  const keys = Object.keys(geo);
  expect(keys.length).toBeGreaterThan(0);
  for (const g of Object.values(geo)) {
    const pos = g.getAttribute('position');
    expect(pos.count).toBeGreaterThan(0);
    for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
  }
  return keys;
}

describe('kit industrial paramétrico', () => {
  it.each([1, 0.6, 0.3])('silo (detalle %s): geometría válida con cuerpo, escalera y escala', (detail) => {
    const keys = sane(buildSiloGeometry(detail === 1 ? 48 : 16, detail));
    expect(keys).toEqual(expect.arrayContaining(['paintGray', 'safety', 'galvanized']));
  });
  it('el silo y su indicador son coherentes: el indicador cabe en el cuerpo y el techo cierra por encima', () => {
    expect(GAUGE_H).toBeGreaterThan(3);
    expect(SILO_TOP).toBeGreaterThan(6);
  });
  it.each([1, 0.3])('conveyor (detalle %s) y tanque con bandeja', (detail) => {
    expect(sane(buildConveyorGeometry(detail))).toEqual(expect.arrayContaining(['steelDark', 'rubber']));
    expect(sane(buildTankGeometry(24, detail, 1))).toEqual(expect.arrayContaining(['concrete', 'shell']));
  });
  it('structure: nave, bastidor y losa', () => {
    expect(sane(buildHallGeometry(10, 7, 4.5, 1))).toEqual(expect.arrayContaining(['roofPanel', 'panel', 'glass']));
    sane(buildHallGeometry(6, 4, 3, 0.3));
    expect(sane(buildRackGeometry(9, 1.6, 3.6, 1))).toContain('galvanized');
    expect(sane(buildSlabGeometry(10, 8, 0.25))).toContain('concreteLight');
  });
  it('soportes de tubería: pedestales sólo en tramos horizontales', () => {
    const horizontal = buildPipe([[0, 0.8, 0], [6, 0.8, 0]]);
    const g = buildPipeSupports([horizontal]);
    expect(Object.keys(g)).toEqual(expect.arrayContaining(['concreteLight', 'steelDark', 'steel']));
    const vertical = buildPipe([[0, 0, 0], [0, 3, 0]]);
    expect(Object.keys(buildPipeSupports([vertical])).includes('concreteLight')).toBe(false);
  });
  it('juntas de la solera: líneas cada 4 dentro de los límites', () => {
    const g = jointLines(0, 0, 12, 8, 4, 0.05);
    // desde el borde cada 4: x = -2, 2 (2 líneas) + z = 0 (1 línea) = 3 segmentos = 6 vértices
    expect(g.getAttribute('position').count).toBe(6);
  });
});

describe('conveyor: velocidad según rpm/state', () => {
  it('detenida sin estado/rpm o con state 0', () => {
    expect(conveyorSpeed(undefined)).toBe(0);
    expect(conveyorSpeed({})).toBe(0);
    expect(conveyorSpeed({ state: 0, rpm: 1450 })).toBe(0);
    expect(conveyorSpeed({ rpm: 10 })).toBe(0); // bajo el umbral de marcha
  });
  it('proporcional a rpm si está en marcha; con sólo state, 70 % del nominal', () => {
    expect(conveyorSpeed({ state: 1, rpm: 1450 })).toBeCloseTo(BELT_V_MAX);
    expect(conveyorSpeed({ state: 1, rpm: 725 })).toBeCloseTo(BELT_V_MAX / 2);
    expect(conveyorSpeed({ rpm: 1450 })).toBeCloseTo(BELT_V_MAX);
    expect(conveyorSpeed({ state: 1 })).toBeCloseTo(BELT_V_MAX * 0.7);
    expect(conveyorSpeed({ state: 1, rpm: 99999 })).toBeLessThanOrEqual(BELT_V_MAX * 1.3 + 1e-9);
  });
  it('rótulo', () => {
    expect(conveyorLabel(undefined)).toBe('—');
    expect(conveyorLabel({ state: 1 })).toBe('En marcha');
    expect(conveyorLabel({ state: 0 })).toBe('Detenida');
    expect(conveyorLabel({ state: 1, rpm: 1200 })).toContain('1200');
  });
});

describe('layout con silo / conveyor / structure', () => {
  it('structureSpec: por metadata, por nombre y por defecto; acota tamaños', () => {
    expect(structureSpec({ id: 'x', name: 'Nave 1' }).variant).toBe('hall');
    expect(structureSpec({ id: 'rack-1', name: 'Bastidor' }).variant).toBe('rack');
    expect(structureSpec({ id: 'p', name: 'Losa principal' }).variant).toBe('slab');
    const sp = structureSpec({ id: 'n', name: 'n', metadata: { structure: { kind: 'hall', width: 20, depth: 9999, height: -4 } } });
    expect(sp).toEqual({ variant: 'hall', w: 20, d: 80, h: 0.1 });
    expect(structureSpec({ id: 'n', name: 'n', metadata: { structure: 'raro' } }).variant).toBe('hall');
  });
  it('huella por tipo (silo, cinta, estructura) y escala', () => {
    expect(footprint({ type: 'silo', model3dRef: null }, 1)).toBe(FOOTPRINT.silo);
    expect(footprint({ type: 'conveyor', model3dRef: null }, 2)).toBe(FOOTPRINT.conveyor * 2);
    expect(footprint({ type: 'structure', model3dRef: null, metadata: { structure: { width: 20, depth: 8 } } }, 1)).toBe(10);
  });
  it('autoposición: sin solapes entre silos/cintas, estructuras tras el equipo y dentro de los límites', () => {
    const entries = [e('silo-1', 'silo'), e('silo-2', 'silo'), e('conv-1', 'conveyor'), e('conv-2', 'conveyor'), e('tk-1', 'tank'), e('nave-1', 'structure')];
    const p = resolvePlacements(entries);
    expect(Object.keys(p).sort()).toEqual(entries.map((x) => x.id).sort());
    const eq = entries.filter((x) => x.type !== 'structure');
    for (let i = 0; i < eq.length; i++) {
      for (let j = i + 1; j < eq.length; j++) {
        const a = p[eq[i]!.id]!.position, b = p[eq[j]!.id]!.position;
        const ra = footprint(eq[i]!, 1) * 0.55, rb = footprint(eq[j]!, 1) * 0.55;
        expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThan(ra + rb);
      }
    }
    const nave = p['nave-1']!.position;
    for (const x of eq) expect(nave[2]).toBeLessThan(p[x.id]!.position[2]);
    const b = sceneBounds(entries, p);
    expect(b.halfX).toBeGreaterThan(5);
  });
  it('packPlacements: la cinta (larga) no se solapa con el silo contiguo de su fila', () => {
    const p = packPlacements([e('silo-1', 'silo'), e('conv-1', 'conveyor')]);
    const dx = Math.abs(p['silo-1']![0] - p['conv-1']![0]);
    expect(dx).toBeGreaterThanOrEqual(1.8 + 3.3);
  });
  it('plantas sin tipos nuevos conservan la cuadrícula de siempre', () => {
    const p = resolvePlacements([e('a1', 'tank'), e('a2', 'tank')]);
    expect(p.a1?.position[0]).toBeCloseTo(-0.5 - 2.1);
  });
  it('metadata.layout manda también para estructuras', () => {
    const p = resolvePlacements([e('nave', 'structure', { layout: { x: 3, z: -8, rotY: 90 } })]);
    expect(p.nave?.position).toEqual([3, 0, -8]);
    expect(p.nave?.rotY).toBeCloseTo(Math.PI / 2);
  });
});

describe('calidad', () => {
  it('?quality= acepta low|medium|high', () => {
    expect(forcedQuality('?quality=medium')).toBe('medium');
    expect(forcedQuality('?quality=low')).toBe('low');
    expect(forcedQuality('?quality=ultra')).toBeNull();
    expect(forcedQuality('')).toBeNull();
    expect(detectQuality('?quality=high')).toBe('high');
  });
  it('escalones: bajar y subir sin pasar del tope', () => {
    expect(stepDown('high')).toBe('medium');
    expect(stepDown('medium')).toBe('low');
    expect(stepDown('low')).toBe('low');
    expect(stepUp('low')).toBe('medium');
    expect(stepUp('medium')).toBe('high');
    expect(stepUp('low', 'low')).toBe('low');
    expect(stepUp('low', 'medium')).toBe('medium');
    expect(stepUp('medium', 'medium')).toBe('medium');
  });
  it('los perfiles se degradan de forma monótona', () => {
    const { high, medium, low } = QUALITY_PROFILE;
    expect(high.shadowMap).toBeGreaterThan(medium.shadowMap);
    expect(medium.shadowMap).toBeGreaterThan(low.shadowMap);
    expect(low.shadowMap).toBe(0);
    expect(low.environment).toBe(false);
    expect(low.msaa).toBe(false);
    expect(high.radial).toBeGreaterThan(medium.radial);
    expect(medium.radial).toBeGreaterThan(low.radial);
    expect(high.dpr).toBeGreaterThanOrEqual(medium.dpr);
  });
});
