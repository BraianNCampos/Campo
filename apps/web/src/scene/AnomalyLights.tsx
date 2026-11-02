'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { anomalyLights, topRequests } from './anomaly-registry';

const REF_INTENSITY = 14;

function assign(light: THREE.PointLight | null, req: ReturnType<typeof topRequests>[number] | undefined): void {
  if (!light) return;
  if (!req) {
    light.intensity = 0;
    return;
  }
  light.position.copy(req.pos);
  light.color.copy(req.color);
  light.intensity = REF_INTENSITY * (0.6 + 0.4 * req.pulse);
}

/**
 * Pool fijo de luces puntuales de anomalía (siempre presentes: cambiar su número recompilaría los materiales). Las
 * `active` (según la calidad) anomalías más urgentes (magenta > roja > ámbar) toman una luz de su color sobre el equipo; el resto de luces
 * queda a intensidad 0.
 */
export function AnomalyLights({ pool, active }: { pool: number; active: number }) {
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  useFrame(() => {
    const top = topRequests(anomalyLights, Math.min(active, pool));
    for (let i = 0; i < pool; i++) assign(lights.current[i] ?? null, top[i]);
  });
  return (
    <>
      {Array.from({ length: pool }, (_, i) => (
        <pointLight
          key={i}
          ref={(l) => {
            lights.current[i] = l;
          }}
          intensity={0}
          distance={9}
          decay={2}
        />
      ))}
    </>
  );
}
