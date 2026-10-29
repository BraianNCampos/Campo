'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RUNNING_RPM } from '@/lib/assets';
import { damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { assetStatus, STATUS_META } from '@/lib/status';
import { Equipment } from './Equipment';
import { PIPE_Y, type Vec3 } from './layout';
import { useAssetTarget } from './useAssetTarget';

/** Factor visual: 1450 rpm → ~1 vuelta/s en pantalla (proporcional a rpm). */
export const VISUAL_RPM_FACTOR = 0.04;
const steel = { color: '#8fa3b8', metalness: 0.15, roughness: 0.38 } as const;

export function Pump({ id, position }: { id: string; position: Vec3 }) {
  const target = useAssetTarget(id);
  const fan = useRef<THREE.Group>(null);
  const motorMat = useRef<THREE.MeshStandardMaterial>(null);
  const lampMat = useRef<THREE.MeshBasicMaterial>(null);
  const valueEl = useRef<HTMLElement>(null);
  const rpm = useRef(0);
  const tmp = useMemo(() => new THREE.Color(), []);
  const dark = useMemo(() => new THREE.Color('#0b1220'), []);

  useFrame((_, dt) => {
    const { state, severity } = target.current;
    rpm.current = damp(rpm.current, state?.values.rpm ?? 0, 2.5, dt);
    if (fan.current) fan.current.rotation.y -= (rpm.current / 60) * Math.PI * 2 * VISUAL_RPM_FACTOR * dt;

    const running = rpm.current > RUNNING_RPM;
    const status = assetStatus(state, severity);
    if (motorMat.current) {
      tmp.set(STATUS_META[status].hex).lerp(dark, status === 'ok' ? 0.45 : 0.15);
      motorMat.current.color.lerp(tmp, 1 - Math.exp(-6 * dt));
    }
    lampMat.current?.color.set(running ? '#4ade80' : '#475569');
    const el = valueEl.current;
    if (el) {
      const text = formatMetric('rpm', state?.values.rpm);
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} position={position} ringRadius={1.5} labelPos={[0, 3.6, 0]} valueRef={valueEl}>
      {/* bancada */}
      <mesh position-y={0.07}>
        <boxGeometry args={[2.6, 0.14, 1.3]} />
        <meshStandardMaterial color="#475569" roughness={0.8} />
      </mesh>
      {/* pedestal de la voluta */}
      <mesh position-y={0.4}>
        <boxGeometry args={[0.8, 0.5, 0.7]} />
        <meshStandardMaterial color="#334155" roughness={0.7} />
      </mesh>
      {/* voluta (eje del flujo = x) */}
      <mesh position-y={PIPE_Y} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.56, 0.56, 0.62, 28]} />
        <meshStandardMaterial {...steel} />
      </mesh>
      {/* bridas de entrada y salida */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.8, PIPE_Y, 0]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.16, 0.16, 0.6, 16]} />
            <meshStandardMaterial {...steel} />
          </mesh>
          <mesh position={[s * 1.08, PIPE_Y, 0]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.27, 0.27, 0.09, 20]} />
            <meshStandardMaterial {...steel} />
          </mesh>
        </group>
      ))}
      {/* motor vertical */}
      <mesh position-y={1.75}>
        <cylinderGeometry args={[0.42, 0.42, 1.1, 28]} />
        <meshStandardMaterial ref={motorMat} color="#1d6f8f" metalness={0.12} roughness={0.5} />
      </mesh>
      {[1.35, 1.55, 1.75, 1.95, 2.15].map((y) => (
        <mesh key={y} position-y={y}>
          <cylinderGeometry args={[0.47, 0.47, 0.05, 28]} />
          <meshStandardMaterial {...steel} />
        </mesh>
      ))}
      <mesh position-y={1.1}>
        <cylinderGeometry args={[0.2, 0.3, 0.35, 20]} />
        <meshStandardMaterial {...steel} />
      </mesh>
      {/* ventilador visible (gira ∝ rpm) */}
      <group ref={fan} position-y={2.45}>
        <mesh>
          <cylinderGeometry args={[0.1, 0.1, 0.14, 12]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.12} roughness={0.4} />
        </mesh>
        {[0, 1, 2, 3].map((k) => (
          <mesh key={k} rotation-y={(k * Math.PI) / 2} position={[0, 0, 0]}>
            <boxGeometry args={[0.98, 0.04, 0.2]} />
            <meshStandardMaterial color="#e2e8f0" metalness={0.12} roughness={0.5} />
          </mesh>
        ))}
      </group>
      {/* piloto de marcha */}
      <mesh position={[0.55, 2.05, 0]}>
        <sphereGeometry args={[0.1, 14, 14]} />
        <meshBasicMaterial ref={lampMat} color="#475569" toneMapped={false} />
      </mesh>
    </Equipment>
  );
}
