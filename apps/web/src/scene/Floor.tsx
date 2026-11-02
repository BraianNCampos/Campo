'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { GeoBuilder } from './kit/geo';
import { jointLines } from './kit/lines';
import { Merged, useBuilt, useKitMaterials } from './kit/Merged';
import type { Bounds } from './layout';

/** Separación entre juntas de dilatación de la solera (≈ paños de 4 m). */
export const JOINT_SPACING = 4;
/** Margen de la solera alrededor de los activos. */
export const SLAB_MARGIN = 0.9;
/** Colores de la marca (globals.css): fondo, superficie, superficie-2 y línea; la escena es siempre oscura. */
export const BRAND = { bg: '#0a1620', surface: '#101f2b', surface2: '#172b3b', line: '#264257' } as const;
/** Color del terreno y de la niebla: se funde con el degradado de fondo en el horizonte. */
export const HORIZON = '#0e1b27';

/** Dimensiones de la solera para unos límites dados: justo la planta más un margen pequeño (mínimo 8 × 6). */
export function slabSize(bounds: Bounds): { w: number; d: number } {
  return { w: Math.max(8, bounds.halfX * 2 + SLAB_MARGIN * 2), d: Math.max(6, bounds.halfZ * 2 + SLAB_MARGIN * 2) };
}

/** Bordillo perimetral de la solera y marca de seguridad en su cara superior. */
function buildCurb(w: number, d: number): Record<string, THREE.BufferGeometry> {
  const b = new GeoBuilder();
  const t = 0.22, h = 0.16;
  for (const s of [-1, 1]) {
    b.box('concreteLight', w + 2 * t, h, t, { pos: [0, h / 2 - 0.02, s * (d / 2 + t / 2)] });
    b.box('concreteLight', t, h, d, { pos: [s * (w / 2 + t / 2), h / 2 - 0.02, 0] });
    b.box('safety', w + 2 * t, 0.012, 0.05, { pos: [0, h - 0.02 + 0.006, s * (d / 2 + t / 2)] });
    b.box('safety', 0.05, 0.012, d, { pos: [s * (w / 2 + t / 2), h - 0.02 + 0.006, 0] });
  }
  return b.build();
}

/**
 * Suelo: solera de hormigón del tamaño de la planta (con bordillo y juntas), una faja de terreno alrededor y, más
 * allá, el terreno que se pierde en la niebla del horizonte.
 */
export function Floor({ bounds }: { bounds: Bounds }) {
  const mats = useKitMaterials();
  const { w, d } = slabSize(bounds);
  const joints = useMemo(() => jointLines(0, 0, w, d, JOINT_SPACING, 0.052), [w, d]);
  useEffect(() => () => joints.dispose(), [joints]);
  const curb = useBuilt(() => buildCurb(w, d), [w, d]);
  const ground = useMemo(() => new THREE.MeshStandardMaterial({ color: HORIZON, roughness: 1, metalness: 0 }), []);
  const apron = useMemo(() => new THREE.MeshStandardMaterial({ color: BRAND.surface2, roughness: 1, metalness: 0 }), []);
  useEffect(
    () => () => {
      ground.dispose();
      apron.dispose();
    },
    [ground, apron],
  );
  const span = Math.max(w, d);
  return (
    <group position={[bounds.cx, 0, bounds.cz]}>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.06} material={ground}>
        <circleGeometry args={[Math.max(90, span * 5), 48]} />
      </mesh>
      {/* faja de terreno alrededor de la solera */}
      <mesh position-y={-0.03} material={apron} receiveShadow userData={{ noOutline: true }}>
        <boxGeometry args={[w + 7, 0.04, d + 7]} />
      </mesh>
      <mesh position-y={0} material={mats.concrete} receiveShadow userData={{ noOutline: true }}>
        <boxGeometry args={[w, 0.1, d]} />
      </mesh>
      <Merged geo={curb} shadows={false} />
      <lineSegments geometry={joints} userData={{ noOutline: true }}>
        <lineBasicMaterial color="#2c3239" />
      </lineSegments>
    </group>
  );
}
