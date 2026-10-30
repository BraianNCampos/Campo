import * as THREE from 'three';
import { clamp } from '@/lib/math';
import type { AssetStatus } from '@/lib/status';

/**
 * Convenciones de animación de los modelos GLB (docs/architecture.md §10.2). Funciones puras sobre un
 * `Object3D` (sin React ni WebGL): se prueban con GLB parseados en Node.
 *
 * - `campo_level*`: escala Y de 0 a 1 según `level` (0-100 %) respecto a su escala original.
 * - `campo_rotor*`: gira sobre Y proporcionalmente a `rpm` (1500 rpm ≈ 1 vuelta/s visual).
 * - `campo_gate*`: rota de 0° a 90° sobre Z según `position` (0-100 %).
 * - El resto de mallas se tiñen según el estado.
 */

/** 1450 rpm → ~1 vuelta/s en pantalla (mismo factor que la bomba procedural). */
export const VISUAL_RPM_FACTOR = 0.04;

type Convention = 'level' | 'rotor' | 'gate';
const PREFIX: Record<Convention, string> = { level: 'campo_level', rotor: 'campo_rotor', gate: 'campo_gate' };

/** ¿El nombre del nodo activa esta convención? Insensible a mayúsculas, por prefijo. */
export const matchesConvention = (name: string, c: Convention): boolean => name.toLowerCase().startsWith(PREFIX[c]);

interface PoseTarget {
  node: THREE.Object3D;
  baseScaleY: number;
  baseRotZ: number;
}

export interface TintTarget {
  material: THREE.Material;
  baseColor: THREE.Color;
  baseEmissive: THREE.Color | null;
  baseEmissiveIntensity: number;
}

export interface PoseTargets {
  level: PoseTarget[];
  rotor: PoseTarget[];
  gate: PoseTarget[];
  tint: TintTarget[];
}

const emissiveOf = (m: THREE.Material): THREE.Color | null => ('emissive' in m ? ((m as THREE.MeshStandardMaterial).emissive ?? null) : null);

/**
 * Localiza los nodos animables. Cuenta sólo el nodo más externo de cada convención (sus hijos ya se
 * mueven con él; si no, el efecto se compondría) y excluye sus mallas del teñido por estado.
 * Las mallas teñibles deben tener materiales propios (ver `createInstance`).
 */
export function collectTargets(root: THREE.Object3D): PoseTargets {
  const t: PoseTargets = { level: [], rotor: [], gate: [], tint: [] };
  const seen = new Set<THREE.Material>();
  const visit = (node: THREE.Object3D, inside: boolean) => {
    let nowInside = inside;
    if (!inside) {
      for (const c of ['level', 'rotor', 'gate'] as const) {
        if (matchesConvention(node.name, c)) {
          t[c].push({ node, baseScaleY: node.scale.y, baseRotZ: node.rotation.z });
          nowInside = true;
          break;
        }
      }
    }
    const mesh = node as THREE.Mesh;
    if (!nowInside && mesh.isMesh) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const color = (material as THREE.MeshStandardMaterial).color;
        if (!material || seen.has(material) || !color) continue;
        seen.add(material);
        const em = emissiveOf(material);
        t.tint.push({
          material,
          baseColor: color.clone(),
          baseEmissive: em ? em.clone() : null,
          baseEmissiveIntensity: (material as THREE.MeshStandardMaterial).emissiveIntensity ?? 1,
        });
      }
    }
    for (const child of node.children) visit(child, nowInside);
  };
  visit(root, false);
  return t;
}

export interface PoseValues {
  /** 0-100 */
  level: number;
  rpm: number;
  /** 0-100 */
  position: number;
}

/** Fracción visible de `campo_level` (0..1). */
export const levelFraction = (level: number): number => clamp(level / 100, 0, 1);
/** Giro (rad) del rotor en `dt` segundos a `rpm`. */
export const rotorStep = (rpm: number, dt: number): number => (Math.max(0, rpm) / 60) * Math.PI * 2 * VISUAL_RPM_FACTOR * dt;
/** Ángulo (rad) de la compuerta: 0 (cerrada) → 90° (abierta) sobre Z. */
export const gateAngle = (position: number): number => clamp(position / 100, 0, 1) * (Math.PI / 2);

/** Aplica los valores a los nodos animables (muta las transformaciones). */
export function applyPose(t: PoseTargets, v: PoseValues, dt: number): void {
  const frac = levelFraction(v.level);
  for (const l of t.level) {
    l.node.scale.y = l.baseScaleY * Math.max(frac, 0.001); // 0 exacto degeneraría la matriz
    l.node.visible = frac > 0.004;
  }
  const step = rotorStep(v.rpm, dt);
  if (step !== 0) for (const r of t.rotor) r.node.rotation.y += step;
  const angle = gateAngle(v.position);
  for (const g of t.gate) g.node.rotation.z = g.baseRotZ + angle;
}

export interface Tint {
  /** color emisivo; null = el original del material */
  hex: string | null;
  intensity: number;
  /** mezcla (0..1) del color base hacia el gris de "sin datos" */
  grey: number;
}

const GREY = new THREE.Color('#6b7a8c');

/** Tinte por estado: normal sin cambios, advertencia ámbar, crítica rojo, sin datos/señal gris. */
export function statusTint(status: AssetStatus): Tint {
  switch (status) {
    case 'warning':
      return { hex: '#fbbf24', intensity: 0.45, grey: 0 };
    case 'critical':
      return { hex: '#ff4d4d', intensity: 0.6, grey: 0 };
    case 'uncertain':
      return { hex: '#c9a227', intensity: 0.3, grey: 0 };
    case 'bad':
    case 'nodata':
      return { hex: '#6b7a8c', intensity: 0.35, grey: 0.65 };
    default:
      return { hex: null, intensity: 0, grey: 0 };
  }
}

const tmp = new THREE.Color();

/** Aplica el tinte a los materiales (`pulse` 0..1 modula la intensidad, p. ej. el parpadeo de las críticas). */
export function applyTint(targets: readonly TintTarget[], status: AssetStatus, pulse = 1): void {
  const tint = statusTint(status);
  for (const t of targets) {
    const m = t.material as THREE.MeshStandardMaterial;
    m.color.copy(t.baseColor);
    if (tint.grey > 0) m.color.lerp(GREY, tint.grey);
    const em = m.emissive as THREE.Color | undefined;
    if (!em) continue;
    if (tint.hex === null) {
      if (t.baseEmissive) em.copy(t.baseEmissive);
      m.emissiveIntensity = t.baseEmissiveIntensity;
    } else {
      em.copy(tmp.set(tint.hex));
      m.emissiveIntensity = tint.intensity * pulse;
    }
  }
}
