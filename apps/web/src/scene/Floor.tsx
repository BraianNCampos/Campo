'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { jointLines } from './kit/lines';
import { useKitMaterials } from './kit/Merged';
import type { Bounds } from './layout';

/** Separación entre juntas de dilatación de la solera (≈ paños de 4 m). */
export const JOINT_SPACING = 4;

/** Dimensiones de la solera para unos límites dados (mínimo 12 × 8). */
export function slabSize(bounds: Bounds): { w: number; d: number } {
  return { w: Math.max(12, bounds.halfX * 2 + 2), d: Math.max(8, bounds.halfZ * 2 + 2) };
}

/** Suelo: terreno oscuro alrededor y solera de hormigón con juntas (líneas) y moteado procedural. */
export function Floor({ bounds }: { bounds: Bounds }) {
  const mats = useKitMaterials();
  const { w, d } = slabSize(bounds);
  const joints = useMemo(() => jointLines(bounds.cx, bounds.cz, w, d, JOINT_SPACING, 0.052), [bounds.cx, bounds.cz, w, d]);
  useEffect(() => () => joints.dispose(), [joints]);
  const ground = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0f1823', roughness: 1, metalness: 0 }), []);
  useEffect(() => () => ground.dispose(), [ground]);
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} material={ground}>
        <circleGeometry args={[Math.max(90, Math.max(w, d) * 3), 48]} />
      </mesh>
      <mesh position={[bounds.cx, 0.0, bounds.cz]} material={mats.concrete} receiveShadow userData={{ noOutline: true }}>
        <boxGeometry args={[w, 0.1, d]} />
      </mesh>
      <lineSegments geometry={joints} userData={{ noOutline: true }}>
        <lineBasicMaterial color="#2c3239" />
      </lineSegments>
    </>
  );
}
