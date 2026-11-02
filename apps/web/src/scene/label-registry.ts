import type { RefObject } from 'react';
import type * as THREE from 'three';
import type { Vec3 } from './layout';
import type { LabelMode, Size } from './label-plan';

/**
 * Registro de las etiquetas 3D: cada `Equipment` se inscribe y el `LabelDirector` decide, a baja frecuencia y sin pasar por
 * React, qué modo (`data-mode`) tiene cada una según anomalías, foco, distancia y solapes.
 */
export interface LabelEntry {
  id: string;
  group: RefObject<THREE.Group | null>;
  label: RefObject<HTMLDivElement | null>;
  labelPos: Vec3;
  decorative: boolean;
  mode: LabelMode;
  /** tamaños medidos (clave: modo + «!» si el rótulo lleva ficha de anomalía) */
  sizes: Map<string, Size>;
}

export const labelEntries = new Map<string, LabelEntry>();

/** Equipo bajo el cursor (el seleccionado vive en `ui-store`). */
export const labelFocus: { hover: string | null } = { hover: null };
