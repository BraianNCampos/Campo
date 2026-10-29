import * as THREE from 'three';
import type { Vec3 } from './layout';

export interface Segment {
  mid: THREE.Vector3;
  quat: THREE.Quaternion;
  length: number;
  /** longitud acumulada al inicio del segmento */
  start: number;
}

export interface BuiltPipe {
  segments: Segment[];
  length: number;
  points: THREE.Vector3[];
}

const UP = new THREE.Vector3(0, 1, 0);

export function buildPipe(points: Vec3[]): BuiltPipe {
  const pts = points.map((p) => new THREE.Vector3(...p));
  const segments: Segment[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as THREE.Vector3;
    const b = pts[i + 1] as THREE.Vector3;
    const dir = b.clone().sub(a);
    const length = dir.length();
    segments.push({
      mid: a.clone().add(b).multiplyScalar(0.5),
      quat: new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()),
      length,
      start: acc,
    });
    acc += length;
  }
  return { segments, length: acc, points: pts };
}

/** Punto a distancia `s` (0..length) a lo largo de la tubería. */
export function pointAt(p: BuiltPipe, s: number, out: THREE.Vector3): THREE.Vector3 {
  const d = Math.min(Math.max(s, 0), p.length);
  for (let i = 0; i < p.segments.length; i++) {
    const seg = p.segments[i] as Segment;
    if (d <= seg.start + seg.length || i === p.segments.length - 1) {
      const t = seg.length === 0 ? 0 : (d - seg.start) / seg.length;
      return out.copy(p.points[i] as THREE.Vector3).lerp(p.points[i + 1] as THREE.Vector3, t);
    }
  }
  return out;
}
