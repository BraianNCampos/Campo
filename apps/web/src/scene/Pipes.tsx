'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AssetState } from '@campo/shared';
import { clamp, damp } from '@/lib/math';
import { RUNNING_RPM } from '@/lib/assets';
import type { FlowSpec, PipeSet } from './layout';
import { buildPipe, pointAt } from './pipe-geometry';
import { useSceneData } from './scene-data';

const PIPE_R = 0.13;
const PARTICLE_SPACING = 0.6;
const FLOW_SPEED = 2.4; // unidades/s a caudal 1
const FLOW_MIN = 0.03;

/** Caudal normalizado 0..1 de una línea: rpm/1450 × apertura de válvula. Puro y testeable. */
export function lineFlow(rpm: number | undefined, valvePos: number | undefined): number {
  if ((rpm ?? 0) <= RUNNING_RPM) return 0;
  return clamp((rpm ?? 0) / 1450, 0, 1) * clamp((valvePos ?? 0) / 100, 0, 1);
}

/** Caudal 0..1 de un activo origen declarado con `connectsTo`: bomba con rpm>0 o válvula con apertura>0. */
export function connectionFlow(type: string, values: Record<string, number> | undefined): number {
  if (type === 'pump') return (values?.rpm ?? 0) > 0 ? clamp((values?.rpm ?? 0) / 1450, 0, 1) : 0;
  if (type === 'valve') return (values?.position ?? 0) > 0 ? clamp((values?.position ?? 0) / 100, 0, 1) : 0;
  return 0;
}

export function flowOf(spec: FlowSpec, assets: Record<string, AssetState>): number {
  return spec.kind === 'line'
    ? lineFlow(assets[spec.pump]?.values.rpm, assets[spec.valve]?.values.position)
    : connectionFlow(spec.type, assets[spec.id]?.values);
}

/**
 * Tuberías (cilindros compartidos) + partículas de flujo en UN solo InstancedMesh.
 * El caudal sale de la bomba y válvula de cada línea, leídos del store en useFrame.
 */
export function Pipes({ set }: { set: PipeSet }) {
  const data = useSceneData();
  const built = useMemo(() => set.pipes.map((p) => ({ def: p, geo: buildPipe(p.points) })), [set]);
  const counts = useMemo(() => built.map((b) => Math.max(2, Math.round(b.geo.length / PARTICLE_SPACING))), [built]);
  const total = useMemo(() => counts.reduce((a, b) => a + b, 0), [counts]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const offsets = useRef<number[]>(built.map(() => 0));
  const flows = useRef<Record<string, number>>({});
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, dt) => {
    const im = mesh.current;
    if (!im) return;
    const { assets } = data.get();
    for (const [key, spec] of Object.entries(set.flows)) {
      flows.current[key] = damp(flows.current[key] ?? 0, flowOf(spec, assets), 3, dt);
    }
    let k = 0;
    built.forEach((b, pi) => {
      const flow = clamp(b.def.sources.reduce((a, k) => a + (flows.current[k] ?? 0), 0), 0, 1);
      offsets.current[pi] = ((offsets.current[pi] ?? 0) + flow * FLOW_SPEED * dt) % b.geo.length;
      const n = counts[pi] as number;
      for (let i = 0; i < n; i++) {
        const s = ((i / n) * b.geo.length + (offsets.current[pi] ?? 0)) % b.geo.length;
        pointAt(b.geo, s, tmp);
        dummy.position.copy(tmp);
        dummy.scale.setScalar(flow > FLOW_MIN ? 0.7 + 0.3 * flow : 0);
        dummy.updateMatrix();
        im.setMatrixAt(k++, dummy.matrix);
      }
    });
    im.instanceMatrix.needsUpdate = true;
  });

  if (built.length === 0) return null;
  return (
    <group>
      {built.map(({ def, geo }) => (
        <group key={def.id}>
          {geo.segments.map((seg, i) => (
            <mesh key={i} position={seg.mid} quaternion={seg.quat}>
              <cylinderGeometry args={[PIPE_R, PIPE_R, seg.length, 16]} />
              <meshStandardMaterial color="#9fb2c6" metalness={0.12} roughness={0.35} transparent opacity={0.5} depthWrite={false} />
            </mesh>
          ))}
          {geo.points.slice(1, -1).map((p, i) => (
            <mesh key={`j${i}`} position={p}>
              <sphereGeometry args={[PIPE_R * 1.02, 14, 12]} />
              <meshStandardMaterial color="#9fb2c6" metalness={0.12} roughness={0.35} transparent opacity={0.5} depthWrite={false} />
            </mesh>
          ))}
        </group>
      ))}
      <instancedMesh ref={mesh} args={[undefined, undefined, total]} frustumCulled={false}>
        <sphereGeometry args={[0.08, 10, 8]} />
        <meshBasicMaterial color="#7dd3fc" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
