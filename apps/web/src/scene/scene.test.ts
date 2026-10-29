import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LAYOUT, LINES, PIPES, positionFor } from './layout';
import { buildPipe, pointAt } from './pipe-geometry';
import { lineFlow } from './Pipes';

describe('layout', () => {
  it('todas las bombas de las tuberías existen en LINES y en LAYOUT', () => {
    const pumps = new Set(LINES.map((l) => l.pump));
    for (const p of PIPES) for (const pump of p.pumps) expect(pumps.has(pump)).toBe(true);
    for (const l of LINES) {
      expect(LAYOUT[l.pump]).toBeDefined();
      expect(LAYOUT[l.valve]).toBeDefined();
    }
  });
  it('activos desconocidos reciben posición propia', () => {
    expect(positionFor('tk-01', 0)).toEqual(LAYOUT['tk-01']);
    const a = positionFor('tk-99', 0);
    const b = positionFor('tk-98', 1);
    expect(a).not.toEqual(b);
  });
});

describe('pipe-geometry', () => {
  const pipe = buildPipe([[0, 0, 0], [2, 0, 0], [2, 0, 3]]);
  it('longitud total y puntos a lo largo del recorrido', () => {
    expect(pipe.length).toBeCloseTo(5);
    const v = new THREE.Vector3();
    expect(pointAt(pipe, 1, v).toArray()).toEqual([1, 0, 0]);
    expect(pointAt(pipe, 3.5, v).toArray()).toEqual([2, 0, 1.5]);
    expect(pointAt(pipe, 99, v).toArray()).toEqual([2, 0, 3]);
  });
});

describe('lineFlow', () => {
  it('requiere bomba en marcha y válvula abierta', () => {
    expect(lineFlow(0, 100)).toBe(0);
    expect(lineFlow(1450, 0)).toBe(0);
    expect(lineFlow(1450, 100)).toBe(1);
    expect(lineFlow(725, 50)).toBeCloseTo(0.25);
    expect(lineFlow(undefined, undefined)).toBe(0);
  });
});
