import { describe, expect, it } from 'vitest';
import { MODULE_IDS } from '@campo/shared';
import { goTo, initialRotation, isLongPress, rotationProgress, stepRotation, togglePause, wallGrid, wallModules, WALL_INTERVALS } from './wall';

describe('modo pared: rotación', () => {
  it('rota al cumplirse el intervalo (10 / 20 / 30 s) y vuelve al primero', () => {
    for (const sec of WALL_INTERVALS) {
      let s = initialRotation();
      s = stepRotation(s, sec * 1000 - 250, sec, 3);
      expect(s.index).toBe(0);
      s = stepRotation(s, 250, sec, 3);
      expect(s).toMatchObject({ index: 1, elapsedMs: 0 });
      s = stepRotation(stepRotation(s, sec * 1000, sec, 3), sec * 1000, sec, 3);
      expect(s.index).toBe(0);
    }
  });
  it('pausa: el tiempo no corre y no cambia de módulo; al seguir, retoma', () => {
    let s = togglePause(initialRotation());
    s = stepRotation(s, 60_000, 10, 3);
    expect(s).toMatchObject({ index: 0, paused: true });
    s = togglePause(s);
    expect(s.paused).toBe(false);
    expect(stepRotation(s, 10_000, 10, 3).index).toBe(1);
  });
  it('con un solo módulo no rota; sin módulos queda en 0', () => {
    expect(stepRotation(initialRotation(), 99_000, 10, 1).index).toBe(0);
    expect(stepRotation(initialRotation(), 99_000, 10, 0).index).toBe(0);
  });
  it('si desaparece un módulo el índice vuelve al inicio', () => {
    expect(stepRotation({ index: 5, elapsedMs: 0, paused: false }, 100, 10, 3).index).toBe(0);
  });
  it('goTo reinicia el tiempo y es circular', () => {
    expect(goTo({ index: 0, elapsedMs: 9000, paused: false }, 2, 3)).toMatchObject({ index: 2, elapsedMs: 0 });
    expect(goTo(initialRotation(), -1, 3).index).toBe(2);
    expect(rotationProgress({ index: 0, elapsedMs: 5000, paused: false }, 10)).toBe(0.5);
  });
  it('rotan los módulos activos con tarjetas (sin Vista 3D) y respetan el cliente', () => {
    expect(wallModules(MODULE_IDS).map((m) => m.id)).toEqual(['tanks', 'climate', 'energy', 'gas', 'machines', 'flow']);
    expect(wallModules(['tanks']).map((m) => m.id)).toEqual(['tanks']);
    expect(wallModules(['view3d'])).toEqual([]);
  });
});

describe('modo pared: grilla y toque largo', () => {
  it('reparte las tarjetas según la relación de aspecto (horizontal y vertical)', () => {
    for (const n of [1, 2, 4, 8, 12]) for (const a of [16 / 9, 9 / 16, 1]) {
      const g = wallGrid(n, a);
      expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
      expect(g.cols).toBeLessThanOrEqual(n);
    }
    expect(wallGrid(8, 16 / 9)).toEqual({ cols: 4, rows: 2 });
    expect(wallGrid(8, 9 / 16).cols).toBeLessThan(wallGrid(8, 16 / 9).cols); // vertical: menos columnas
    expect(wallGrid(0, 2)).toEqual({ cols: 1, rows: 1 });
    expect(wallGrid(3, NaN).cols).toBeGreaterThan(0);
  });
  it('toque largo desde 700 ms', () => {
    expect(isLongPress(0, 699)).toBe(false);
    expect(isLongPress(0, 700)).toBe(true);
  });
});
