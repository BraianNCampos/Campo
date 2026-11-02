import type { ModuleDef, ModuleId } from '@campo/shared';
import { activeModules } from './nav';
import { countItems, moduleItems, type LiveSnapshot } from './summary';
import type { CardStatus } from './status';

/**
 * Vista general de la planta (nivel 1 ISA-101, docs/ux-isa.md §1): estado agregado por módulo, sin valores de
 * instrumentos. Funciones puras; la pantalla las alimenta con el estado vivo.
 */

/** Estado agregado de un módulo (los mismos que las tarjetas, para reutilizar chip y colores). */
export type ModuleHealth = Extract<CardStatus, 'ok' | 'near' | 'alarm' | 'nodata'>;

export interface ModuleOverview {
  id: ModuleId;
  label: string;
  total: number;
  /** activos que requieren atención: en alarma o cerca del límite */
  attention: number;
  alarm: number;
  near: number;
  status: ModuleHealth;
}

export function moduleHealth(c: { all: number; alarm: number; near: number; nodata: number }): ModuleHealth {
  if (c.alarm > 0) return 'alarm';
  if (c.near > 0) return 'near';
  if (c.all === 0 || c.nodata === c.all) return 'nodata';
  return 'ok';
}

/** Módulos con activos (todos los activos salvo «Vista 3D», que no tiene) y su estado agregado. */
export function planOverview(ids: readonly ModuleId[], s: LiveSnapshot): ModuleOverview[] {
  return activeModules(ids)
    .filter((m: ModuleDef) => m.id !== 'view3d')
    .map((m) => {
      const c = countItems(moduleItems(m.id, s));
      return { id: m.id, label: m.label, total: c.all, attention: c.attention, alarm: c.alarm, near: c.near, status: moduleHealth(c) };
    });
}

export type OverviewMode = 'none' | 'redirect' | 'scene' | 'map';

/**
 * Qué muestra `/`: sin módulos, aviso; con uno solo, va directo a su pantalla (regla vigente); con varios, la vista
 * general: con 3D si el cliente tiene `view3d`, y si no un mapa 2D de módulos.
 */
export function overviewMode(ids: readonly ModuleId[]): OverviewMode {
  const mods = activeModules(ids);
  if (mods.length === 0) return 'none';
  if (mods.length === 1) return 'redirect';
  return mods.some((m) => m.id === 'view3d') ? 'scene' : 'map';
}

/** Texto de latencia: «42 ms», «1,3 s» o «—» sin dato. */
export function latencyText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} s`;
}
