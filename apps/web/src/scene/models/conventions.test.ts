// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose, applyTint, collectTargets, gateAngle, levelFraction, matchesConvention, rotorStep, statusTint, VISUAL_RPM_FACTOR } from './conventions';
import { createInstance, parseGlb } from './glb';
import { sampleGlb } from './fixtures';

const nodeNamed = (root: THREE.Object3D, name: string) => root.getObjectByName(name)!;
const pose = (over: Partial<{ level: number; rpm: number; position: number }> = {}) => ({ level: 0, rpm: 0, position: 0, ...over });

describe('funciones puras de las convenciones', () => {
  it('nombres: prefijo insensible a mayúsculas', () => {
    expect(matchesConvention('campo_level', 'level')).toBe(true);
    expect(matchesConvention('CAMPO_Level_2', 'level')).toBe(true);
    expect(matchesConvention('campo_rotor.001', 'rotor')).toBe(true);
    expect(matchesConvention('Campo_Gate', 'gate')).toBe(true);
    expect(matchesConvention('mi_campo_level', 'level')).toBe(false);
    expect(matchesConvention('campo_level', 'rotor')).toBe(false);
  });
  it('level: 0..100 % → 0..1 (acotado)', () => {
    expect(levelFraction(0)).toBe(0);
    expect(levelFraction(50)).toBe(0.5);
    expect(levelFraction(250)).toBe(1);
    expect(levelFraction(-5)).toBe(0);
  });
  it('rotor: 1500 rpm ≈ 1 vuelta/s visual y proporcional a rpm', () => {
    expect(rotorStep(1500, 1)).toBeCloseTo(2 * Math.PI, 5);
    expect(VISUAL_RPM_FACTOR).toBe(0.04);
    expect(rotorStep(750, 1)).toBeCloseTo(rotorStep(1500, 1) / 2, 8);
    expect(rotorStep(-100, 1)).toBe(0);
  });
  it('gate: 0° cerrada → 90° abierta', () => {
    expect(gateAngle(0)).toBe(0);
    expect(gateAngle(100)).toBeCloseTo(Math.PI / 2);
    expect(gateAngle(50)).toBeCloseTo(Math.PI / 4);
    expect(gateAngle(500)).toBeCloseTo(Math.PI / 2);
  });
  it('tinte por estado: normal sin cambios, ámbar, rojo, gris', () => {
    expect(statusTint('ok').hex).toBeNull();
    expect(statusTint('warning').hex).toBe('#fbbf24');
    expect(statusTint('critical').hex).toBe('#ff4d4d');
    expect(statusTint('nodata')).toMatchObject({ hex: '#6b7a8c' });
    expect(statusTint('nodata').grey).toBeGreaterThan(0);
    expect(statusTint('bad').hex).toBe(statusTint('nodata').hex);
  });
});

describe('sample-tank.glb (campo_level)', () => {
  it('localiza el nodo y lo escala en Y con el nivel, sin tocar la forma original', async () => {
    const model = await parseGlb(sampleGlb('sample-tank'));
    const inst = createInstance(model);
    const t = collectTargets(inst.object);
    expect(t.level).toHaveLength(1);
    expect(t.rotor).toHaveLength(0);
    expect(t.level[0]!.node.name).toBe('campo_level');
    const base = t.level[0]!.baseScaleY;

    applyPose(t, pose({ level: 100 }), 0.016);
    expect(nodeNamed(inst.object, 'campo_level').scale.y).toBeCloseTo(base);
    expect(nodeNamed(inst.object, 'campo_level').visible).toBe(true);
    applyPose(t, pose({ level: 50 }), 0.016);
    expect(nodeNamed(inst.object, 'campo_level').scale.y).toBeCloseTo(base * 0.5);
    applyPose(t, pose({ level: 0 }), 0.016);
    expect(nodeNamed(inst.object, 'campo_level').visible).toBe(false);
    expect(nodeNamed(inst.object, 'campo_level').scale.y).toBeGreaterThan(0); // nunca degenera
    inst.dispose();
  });

  it('la carcasa (resto de mallas) se tiñe por estado y la caché no se contamina', async () => {
    const model = await parseGlb(sampleGlb('sample-tank'));
    const shellOf = (root: THREE.Object3D) => (nodeNamed(root, 'shell') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const original = shellOf(model.scene).color.getHex();

    const a = createInstance(model);
    const b = createInstance(model);
    const ta = collectTargets(a.object);
    expect(ta.tint.map((x) => (x.material as THREE.MeshStandardMaterial).color.getHex())).toContain(original);
    // la malla animada (campo_level) no se tiñe
    expect(ta.tint).toHaveLength(1);

    applyTint(ta.tint, 'critical');
    const m = shellOf(a.object);
    expect(m.emissive.getHexString()).toBe('ff4d4d');
    expect(m.emissiveIntensity).toBeGreaterThan(0);
    applyTint(ta.tint, 'nodata');
    expect(m.emissive.getHexString()).toBe('6b7a8c');
    expect(m.color.getHex()).not.toBe(original); // tendido hacia gris
    applyTint(ta.tint, 'ok');
    expect(m.emissive.getHexString()).toBe('000000'); // vuelve al original
    expect(m.emissiveIntensity).toBe(1);
    expect(m.color.getHex()).toBe(original);

    // ni la caché ni la otra instancia cambiaron
    expect(shellOf(model.scene).color.getHex()).toBe(original);
    expect(shellOf(model.scene).emissive.getHexString()).toBe('000000');
    expect(shellOf(b.object)).not.toBe(shellOf(a.object));
    a.dispose();
    b.dispose();
  });
});

describe('sample-pump.glb (campo_rotor) y sample-valve.glb (campo_gate)', () => {
  it('el rotor gira ∝ rpm y se detiene sin rpm', async () => {
    const inst = createInstance(await parseGlb(sampleGlb('sample-pump')));
    const t = collectTargets(inst.object);
    const rotor = nodeNamed(inst.object, 'campo_rotor');
    expect(t.rotor).toHaveLength(1);
    applyPose(t, pose({ rpm: 1500 }), 0.5);
    expect(rotor.rotation.y).toBeCloseTo(Math.PI, 5);
    const before = rotor.rotation.y;
    applyPose(t, pose({ rpm: 0 }), 1);
    expect(rotor.rotation.y).toBe(before);
    applyPose(t, pose({ rpm: 750 }), 1);
    expect(rotor.rotation.y - before).toBeCloseTo(Math.PI, 5);
    expect(t.tint.length).toBeGreaterThan(0); // el alojamiento sí se tiñe
  });

  it('la compuerta rota de 0° a 90° sobre Z según la apertura', async () => {
    const inst = createInstance(await parseGlb(sampleGlb('sample-valve')));
    const t = collectTargets(inst.object);
    const gate = nodeNamed(inst.object, 'campo_gate');
    applyPose(t, pose({ position: 0 }), 0.016);
    expect(gate.rotation.z).toBeCloseTo(0);
    applyPose(t, pose({ position: 100 }), 0.016);
    expect(gate.rotation.z).toBeCloseTo(Math.PI / 2);
    applyPose(t, pose({ position: 25 }), 0.016);
    expect(gate.rotation.z).toBeCloseTo(Math.PI / 8);
  });

  it('un modelo sin convenciones sólo se tiñe', async () => {
    const t = collectTargets(createInstance(await parseGlb(sampleGlb('sample-static'))).object);
    expect([t.level.length, t.rotor.length, t.gate.length]).toEqual([0, 0, 0]);
    expect(t.tint).toHaveLength(1);
  });
});

describe('árboles con anidación y mayúsculas', () => {
  it('sólo cuenta el nodo más externo de cada convención y excluye su subárbol del teñido', () => {
    const root = new THREE.Group();
    const mk = (name: string) => Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()), { name });
    const outer = mk('CAMPO_LEVEL_outer');
    const inner = mk('campo_level_inner'); // hijo con el mismo prefijo: no debe componer el efecto
    const body = mk('cuerpo');
    outer.add(inner);
    root.add(outer, body);
    const t = collectTargets(root);
    expect(t.level.map((x) => x.node.name)).toEqual(['CAMPO_LEVEL_outer']);
    expect(t.tint).toHaveLength(1);
    outer.scale.y = 2;
    const t2 = collectTargets(root);
    applyPose(t2, pose({ level: 50 }), 0.016);
    expect(outer.scale.y).toBeCloseTo(1); // 2 (base) × 0.5
    expect(inner.scale.y).toBe(1);
  });
});
