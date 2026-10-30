'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp, damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { assetStatus, STATUS_META } from '@/lib/status';
import { Equipment, type AssetNodeProps } from './Equipment';
import { PIPE_Y } from './layout';
import { useAssetTarget } from './useAssetTarget';

const steel = { color: '#8fa3b8', metalness: 0.15, roughness: 0.38 } as const;

/** Válvula de bola: la palanca gira de 90° (cerrada, transversal) a 0° (abierta, alineada con la tubería). */
export function Valve({ id, name, placement }: AssetNodeProps) {
  const target = useAssetTarget(id);
  const lever = useRef<THREE.Group>(null);
  const leverMat = useRef<THREE.MeshStandardMaterial>(null);
  const bodyMat = useRef<THREE.MeshStandardMaterial>(null);
  const valueEl = useRef<HTMLElement>(null);
  const pos = useRef<number | null>(null);
  const tmp = useMemo(() => new THREE.Color(), []);
  const closed = useMemo(() => new THREE.Color('#ef4444'), []);
  const open = useMemo(() => new THREE.Color('#22c55e'), []);

  useFrame((_, dt) => {
    const { state, severity } = target.current;
    const goal = state?.values.position ?? 0;
    pos.current = pos.current === null ? goal : damp(pos.current, goal, 5, dt);
    const frac = clamp(pos.current / 100, 0, 1);
    if (lever.current) lever.current.rotation.y = (1 - frac) * (Math.PI / 2);
    leverMat.current?.color.copy(closed).lerp(open, frac);
    if (bodyMat.current) {
      const status = assetStatus(state, severity);
      tmp.set(status === 'ok' ? '#64748b' : STATUS_META[status].hex);
      bodyMat.current.color.lerp(tmp, 1 - Math.exp(-6 * dt));
    }
    const el = valueEl.current;
    if (el) {
      const text = formatMetric('position', state?.values.position);
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} name={name} type="valve" placement={placement} ringRadius={0.95} labelPos={[0, 2.0, 0]} valueRef={valueEl}>
      <mesh position-y={0.35}>
        <boxGeometry args={[0.5, 0.7, 0.5]} />
        <meshStandardMaterial color="#334155" roughness={0.8} />
      </mesh>
      <mesh position-y={PIPE_Y}>
        <sphereGeometry args={[0.36, 24, 18]} />
        <meshStandardMaterial ref={bodyMat} color="#64748b" metalness={0.12} roughness={0.4} />
      </mesh>
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.45, PIPE_Y, 0]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.17, 0.17, 0.5, 16]} />
            <meshStandardMaterial {...steel} />
          </mesh>
          <mesh position={[s * 0.62, PIPE_Y, 0]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.27, 0.27, 0.08, 20]} />
            <meshStandardMaterial {...steel} />
          </mesh>
        </group>
      ))}
      {/* vástago y palanca */}
      <mesh position-y={PIPE_Y + 0.5}>
        <cylinderGeometry args={[0.06, 0.06, 0.5, 10]} />
        <meshStandardMaterial {...steel} />
      </mesh>
      <group ref={lever} position-y={PIPE_Y + 0.78}>
        <mesh position-x={0.38}>
          <boxGeometry args={[0.9, 0.09, 0.14]} />
          <meshStandardMaterial ref={leverMat} color="#ef4444" roughness={0.5} />
        </mesh>
        <mesh>
          <cylinderGeometry args={[0.1, 0.1, 0.14, 12]} />
          <meshStandardMaterial {...steel} />
        </mesh>
      </group>
    </Equipment>
  );
}
