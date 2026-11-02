import * as THREE from 'three';
import type { AnomalyLevel } from './anomaly';

/**
 * Luces puntuales de anomalía. Añadir/quitar luces cambia el número de luces del shader (recompila todos los
 * materiales), así que la escena tiene un POOL fijo (`AnomalyLights`) y cada activo anómalo sólo registra aquí dónde
 * y de qué color quiere luz; el pool reparte las luces entre las anomalías más urgentes.
 */
export interface LightRequest {
  level: AnomalyLevel;
  rank: number;
  pos: THREE.Vector3;
  color: THREE.Color;
  /** 0..1, pulso */
  pulse: number;
}

export const anomalyLights = new Map<string, LightRequest>();

/** Las `n` solicitudes más urgentes (rango desc., id asc. para desempatar). */
export function topRequests(reqs: ReadonlyMap<string, LightRequest>, n: number): LightRequest[] {
  return [...reqs.entries()]
    .sort((a, b) => b[1].rank - a[1].rank || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, n))
    .map(([, r]) => r);
}
