import { activeModules } from './modules/nav';
import type { ModuleDef, ModuleId } from '@campo/shared';

/** Intervalos de rotación del modo pared, en segundos. */
export const WALL_INTERVALS = [10, 20, 30] as const;
export type WallInterval = (typeof WALL_INTERVALS)[number];
export const DEFAULT_WALL_INTERVAL: WallInterval = 20;

/** Pulsación larga (ms) que sale del modo pared. */
export const LONG_PRESS_MS = 700;

/** Módulos que rotan en el modo pared: los activos con tarjetas (la Vista 3D no rota: es un lienzo, no un tablero). */
export function wallModules(ids: readonly ModuleId[]): ModuleDef[] {
  return activeModules(ids).filter((m) => m.id !== 'view3d');
}

export interface RotationState {
  index: number;
  /** ms transcurridos en el módulo actual */
  elapsedMs: number;
  paused: boolean;
}

export const initialRotation = (): RotationState => ({ index: 0, elapsedMs: 0, paused: false });

/** Avanza `dtMs`; al cumplirse el intervalo pasa al siguiente módulo (circular). En pausa, o con un solo módulo, no rota. */
export function stepRotation(s: RotationState, dtMs: number, intervalSec: number, count: number): RotationState {
  if (count <= 0) return { ...s, index: 0, elapsedMs: 0 };
  const index = s.index >= count ? 0 : s.index;
  if (s.paused || count < 2) return { ...s, index, elapsedMs: 0 };
  const elapsed = s.elapsedMs + Math.max(0, dtMs);
  const limit = intervalSec * 1000;
  return elapsed >= limit ? { ...s, index: (index + 1) % count, elapsedMs: 0 } : { ...s, index, elapsedMs: elapsed };
}

export const togglePause = (s: RotationState): RotationState => ({ ...s, paused: !s.paused });

/** Salta a un módulo concreto (indicador de módulos) y reinicia el tiempo. */
export function goTo(s: RotationState, index: number, count: number): RotationState {
  return { ...s, index: count > 0 ? ((index % count) + count) % count : 0, elapsedMs: 0 };
}

/** Fracción (0–1) del intervalo ya consumida, para la barra de progreso. */
export const rotationProgress = (s: RotationState, intervalSec: number): number => Math.min(1, s.elapsedMs / (intervalSec * 1000));

/** Relación ancho/alto que se busca en cada tarjeta (algo más anchas que altas). */
const CARD_ASPECT = 1.2;

/**
 * Columnas y filas para repartir `count` tarjetas en una pantalla con relación de aspecto `aspect` (ancho/alto): la
 * combinación cuyas tarjetas quedan más cerca de `CARD_ASPECT`, penalizando las celdas vacías.
 */
export function wallGrid(count: number, aspect: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 1, rows: 1 };
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let best = { cols: 1, rows: count };
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const score = Math.abs(Math.log((a * rows) / cols / CARD_ASPECT)) + (cols * rows - count) / count;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

/** ¿La pulsación duró lo suficiente para ser «larga»? */
export const isLongPress = (downAt: number, upAt: number, threshold = LONG_PRESS_MS): boolean => upAt - downAt >= threshold;
