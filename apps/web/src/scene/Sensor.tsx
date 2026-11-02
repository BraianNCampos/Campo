'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { formatMetric } from '@/lib/metrics';
import { assetStatus, STATUS_META } from '@/lib/status';
import { Equipment, type AssetNodeProps } from './Equipment';
import { useAssetTarget } from './useAssetTarget';

const HEIGHT = 1.1;

/** Marcador de sensor: mástil con cabezal esférico teñido por estado; el rótulo muestra su primera métrica. */
export function Sensor({ id, name, tag, placement }: AssetNodeProps) {
  const target = useAssetTarget(id);
  const headMat = useRef<THREE.MeshStandardMaterial>(null);
  const valueEl = useRef<HTMLElement>(null);
  const tmp = useMemo(() => new THREE.Color(), []);

  useFrame((_, dt) => {
    const { state, severity } = target.current;
    const status = assetStatus(state, severity);
    const mat = headMat.current;
    if (mat) {
      // sólo se apaga sin señal; las anomalías se señalan con contorno y marcador
      tmp.set(status === 'nodata' || status === 'bad' ? STATUS_META[status].hex : STATUS_META.ok.hex);
      mat.color.lerp(tmp, 1 - Math.exp(-6 * dt));
      mat.emissive.copy(mat.color).multiplyScalar(status === 'nodata' || status === 'bad' ? 0.12 : 0.25);
    }
    const el = valueEl.current;
    if (el) {
      const metric = state ? Object.keys(state.values)[0] : undefined;
      const text = metric ? formatMetric(metric, state?.values[metric]) : '—';
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} name={name} tag={tag} type="sensor" placement={placement} ringRadius={0.55} labelPos={[0, HEIGHT + 0.9, 0]} valueRef={valueEl}>
      <mesh position-y={0.06}>
        <cylinderGeometry args={[0.28, 0.32, 0.12, 20]} />
        <meshStandardMaterial color="#475569" roughness={0.8} />
      </mesh>
      <mesh position-y={HEIGHT / 2}>
        <cylinderGeometry args={[0.04, 0.04, HEIGHT, 10]} />
        <meshStandardMaterial color="#aab4be" metalness={0.8} roughness={0.36} />
      </mesh>
      <mesh position-y={HEIGHT + 0.18}>
        <sphereGeometry args={[0.22, 20, 16]} />
        <meshStandardMaterial ref={headMat} color="#38bdf8" roughness={0.35} metalness={0.05} />
      </mesh>
      <mesh position-y={HEIGHT + 0.18} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.34, 0.02, 8, 32]} />
        <meshBasicMaterial color="#a6b5c7" toneMapped={false} />
      </mesh>
    </Equipment>
  );
}
