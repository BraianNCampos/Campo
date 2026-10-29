'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp, damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { assetStatus, STATUS_META } from '@/lib/status';
import { Equipment } from './Equipment';
import type { Vec3 } from './layout';
import { useAssetTarget } from './useAssetTarget';

export const TANK_R = 1.4;
export const TANK_H = 3.4;
const BASE = 0.15;

const steel = { color: '#8fa3b8', metalness: 0.55, roughness: 0.4 } as const;

export function Tank({ id, position }: { id: string; position: Vec3 }) {
  const target = useAssetTarget(id);
  const liquid = useRef<THREE.Mesh>(null);
  const liquidMat = useRef<THREE.MeshStandardMaterial>(null);
  const valueEl = useRef<HTMLElement>(null);
  const level = useRef<number | null>(null);
  const tmp = useMemo(() => new THREE.Color(), []);

  useFrame(({ clock }, dt) => {
    const { state, severity } = target.current;
    const goal = state?.values.level ?? 0;
    level.current = level.current === null ? goal : damp(level.current, goal, 3.5, dt);
    const frac = clamp(level.current / 100, 0, 1);

    const mesh = liquid.current;
    if (mesh) {
      const h = Math.max(frac * (TANK_H - BASE - 0.15), 0.001);
      mesh.scale.y = h;
      mesh.position.y = BASE + h / 2;
      mesh.visible = frac > 0.004;
    }
    const mat = liquidMat.current;
    if (mat) {
      const status = assetStatus(state, severity);
      tmp.set(STATUS_META[status].hex);
      mat.color.lerp(tmp, 1 - Math.exp(-6 * dt));
      const pulse = status === 'critical' ? 0.3 + 0.2 * Math.sin(clock.elapsedTime * 6) : 0.18;
      mat.emissive.copy(mat.color).multiplyScalar(pulse);
    }
    const el = valueEl.current;
    if (el) {
      const text = formatMetric('level', state?.values.level);
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} position={position} ringRadius={TANK_R + 0.35} labelY={TANK_H + 0.75} valueRef={valueEl}>
      {/* zócalo */}
      <mesh position-y={BASE / 2}>
        <cylinderGeometry args={[TANK_R + 0.12, TANK_R + 0.18, BASE, 40]} />
        <meshStandardMaterial color="#475569" metalness={0.3} roughness={0.7} />
      </mesh>
      {/* líquido */}
      <mesh ref={liquid}>
        <cylinderGeometry args={[TANK_R - 0.07, TANK_R - 0.07, 1, 40]} />
        <meshStandardMaterial ref={liquidMat} color="#38bdf8" roughness={0.25} metalness={0.05} />
      </mesh>
      {/* casco translúcido */}
      <mesh position-y={BASE + (TANK_H - BASE) / 2}>
        <cylinderGeometry args={[TANK_R, TANK_R, TANK_H - BASE, 40, 1, true]} />
        <meshStandardMaterial {...steel} transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* aros */}
      {[0.02, 0.34, 0.67, 1].map((f) => (
        <mesh key={f} position-y={BASE + f * (TANK_H - BASE)} rotation-x={Math.PI / 2}>
          <torusGeometry args={[TANK_R + 0.01, f === 1 || f === 0.02 ? 0.06 : 0.035, 8, 48]} />
          <meshStandardMaterial {...steel} />
        </mesh>
      ))}
      {/* marcas de umbral 10% y 90% */}
      {[0.1, 0.9].map((f) => (
        <mesh key={f} position-y={BASE + f * (TANK_H - BASE)} rotation-x={Math.PI / 2}>
          <torusGeometry args={[TANK_R + 0.02, 0.018, 6, 48]} />
          <meshBasicMaterial color="#ff6b6b" toneMapped={false} />
        </mesh>
      ))}
      {/* toma lateral hacia la tubería (origen: lado +x; destino: lado -x) */}
      <mesh position={[position[0] < 0 ? TANK_R : -TANK_R, 0.8, 0]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.2, 0.2, 0.25, 16]} />
        <meshStandardMaterial {...steel} />
      </mesh>
    </Equipment>
  );
}
