'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RUNNING_RPM } from '@/lib/assets';
import { clamp, damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { Equipment, type AssetNodeProps } from './Equipment';
import { GeoBuilder } from './kit/geo';
import { Merged, useBuilt } from './kit/Merged';
import { beltTexture } from './kit/textures';
import { useQualityProfile } from './quality';
import { useAssetTarget } from './useAssetTarget';

export const CONV_L = 6;
export const CONV_W = 0.9;
const TOP = 0.95;
const DRUM_R = 0.19;
/** Velocidad visual de la banda a rpm nominal (1450), en unidades/s. */
export const BELT_V_MAX = 1.1;
const TILE = 1.2; // longitud de banda que cubre una repetición de la textura

/**
 * Velocidad visual de la banda (unidades/s) según `rpm` y `state`: detenida si `state` < 0,5 (o, sin `state`, rpm
 * por debajo del umbral de marcha); en marcha, proporcional a `rpm`/1450 (con `state` pero sin `rpm`, un 70 % del nominal).
 */
export function conveyorSpeed(values: Record<string, number> | undefined): number {
  if (!values) return 0;
  const { rpm, state } = values;
  const running = state !== undefined ? state >= 0.5 : (rpm ?? 0) > RUNNING_RPM;
  if (!running) return 0;
  if (rpm !== undefined && rpm > 0) return clamp(rpm / 1450, 0.05, 1.3) * BELT_V_MAX;
  return BELT_V_MAX * 0.7;
}

/** Texto del rótulo: rpm si hay; si no, el estado. */
export function conveyorLabel(values: Record<string, number> | undefined): string {
  if (!values) return '—';
  if (values.rpm !== undefined) return formatMetric('rpm', values.rpm);
  if (values.state !== undefined) return values.state >= 0.5 ? 'En marcha' : 'Detenida';
  return '—';
}

/** Bastidor, rodillos, tambores, tolva, motorreductor y protecciones (estático, fusionado por material). */
export function buildConveyorGeometry(detail: number): Record<string, THREE.BufferGeometry> {
  const b = new GeoBuilder();
  const hw = CONV_W / 2;
  const zr = hw + 0.06;
  // largueros (perfil en U) y travesaños
  for (const s of [-1, 1]) {
    b.box('steelDark', CONV_L, 0.22, 0.06, { pos: [0, TOP - 0.2, s * zr] });
    b.box('galvanized', CONV_L, 0.04, 0.12, { pos: [0, TOP - 0.09, s * zr] });
  }
  const cross = Math.round(CONV_L / (detail >= 0.6 ? 0.6 : 1.2));
  for (let i = 0; i <= cross; i++) b.box('steelDark', 0.06, 0.06, CONV_W + 0.2, { pos: [-CONV_L / 2 + (i / cross) * CONV_L, TOP - 0.27, 0] });
  // patas con base y arriostramiento
  const legs = 4;
  for (let i = 0; i < legs; i++) {
    const x = -CONV_L / 2 + 0.4 + (i / (legs - 1)) * (CONV_L - 0.8);
    for (const s of [-1, 1]) {
      b.box('steelDark', 0.1, TOP - 0.3, 0.1, { pos: [x, (TOP - 0.3) / 2 + 0.03, s * zr] });
      b.box('steel', 0.26, 0.04, 0.26, { pos: [x, 0.02, s * zr] });
    }
    b.box('steelDark', 0.06, 0.06, CONV_W + 0.2, { pos: [x, 0.32, 0] });
    if (detail >= 0.6) {
      b.bar('steelDark', [x, 0.3, zr], [x + 0.5, TOP - 0.3, zr], 0.05);
      b.bar('steelDark', [x, 0.3, -zr], [x + 0.5, TOP - 0.3, -zr], 0.05);
    }
  }
  // rodillos portantes (justo bajo la banda; asoman por los lados) y de retorno
  const pitch = detail >= 0.6 ? 0.5 : 0.9;
  for (let x = -CONV_L / 2 + 0.5; x < CONV_L / 2 - 0.4; x += pitch) {
    b.cyl('galvanized', 0.04, 0.04, CONV_W + 0.1, 10, { pos: [x, TOP - 0.1, 0], rot: [Math.PI / 2, 0, 0] });
  }
  for (let x = -CONV_L / 2 + 1; x < CONV_L / 2 - 0.5; x += 1.6) {
    b.cyl('galvanized', 0.04, 0.04, CONV_W + 0.1, 10, { pos: [x, TOP - 0.43, 0], rot: [Math.PI / 2, 0, 0] });
  }
  // tambores de cabeza y cola con ejes y soportes de rodamiento
  for (const s of [-1, 1]) {
    const x = s * (CONV_L / 2);
    b.cyl('rubber', DRUM_R + 0.02, DRUM_R + 0.02, CONV_W + 0.02, 20, { pos: [x, TOP - DRUM_R - 0.02, 0], rot: [Math.PI / 2, 0, 0] });
    b.cyl('steel', 0.05, 0.05, CONV_W + 0.5, 10, { pos: [x, TOP - DRUM_R - 0.02, 0], rot: [Math.PI / 2, 0, 0] });
    for (const t of [-1, 1]) b.box('steelDark', 0.16, 0.16, 0.12, { pos: [x, TOP - DRUM_R - 0.02, t * (hw + 0.2)] });
  }
  // motorreductor en la cabeza (+x) con protector amarillo
  const mx = CONV_L / 2 + 0.05;
  b.box('paintBlue', 0.34, 0.3, 0.3, { pos: [mx, TOP - 0.22, hw + 0.38] });
  b.cyl('paintBlue', 0.15, 0.15, 0.5, 18, { pos: [mx + 0.4, TOP - 0.22, hw + 0.38], rot: [0, 0, Math.PI / 2] });
  b.box('safety', 0.3, 0.34, 0.1, { pos: [mx, TOP - 0.2, hw + 0.24] });
  // tolva de carga en la cola (-x) sobre cuatro apoyos
  const hx = -CONV_L / 2 + 0.9;
  b.cyl('paintGray', 0.62, 0.38, 0.8, 4, { pos: [hx, TOP + 0.55, 0], rot: [0, Math.PI / 4, 0] });
  b.box('steelDark', 0.04, 1.0, 0.04, { pos: [hx - 0.45, TOP + 0.45, hw + 0.35] });
  b.box('steelDark', 0.04, 1.0, 0.04, { pos: [hx + 0.45, TOP + 0.45, hw + 0.35] });
  b.box('steelDark', 0.04, 1.0, 0.04, { pos: [hx - 0.45, TOP + 0.45, -hw - 0.35] });
  b.box('steelDark', 0.04, 1.0, 0.04, { pos: [hx + 0.45, TOP + 0.45, -hw - 0.35] });
  // faldones de goma a ambos lados bajo la tolva
  for (const s of [-1, 1]) b.box('rubber', 1.6, 0.14, 0.03, { pos: [hx + 0.3, TOP + 0.07, s * (hw - 0.02)] });
  // cable de paro de emergencia con postes
  if (detail >= 0.6) {
    const z = -(hw + 0.45);
    const posts = [-2.4, 0, 2.4];
    for (const x of posts) b.box('safety', 0.05, 1.1, 0.05, { pos: [x, 0.55, z] });
    b.bar('safety', [posts[0] as number, 1.0, z], [posts[2] as number, 1.0, z], 0.015);
  }
  return b.build();
}

/** Cinta transportadora: bastidor, rodillos y banda con textura animada cuya velocidad sigue `rpm`/`state`. */
export function Conveyor({ id, name, placement }: AssetNodeProps) {
  const target = useAssetTarget(id);
  const prof = useQualityProfile();
  const geo = useBuilt(() => buildConveyorGeometry(prof.detail), [prof.detail]);
  const belt = useMemo(() => {
    const tex = prof.textures ? beltTexture() : null;
    const ret = tex ? tex.clone() : null;
    if (tex) tex.repeat.set(CONV_L / TILE, 1);
    if (ret) {
      ret.repeat.set(CONV_L / TILE, 1);
      ret.needsUpdate = true;
    }
    const mat = (map: THREE.Texture | null) => new THREE.MeshStandardMaterial({ color: map ? '#ffffff' : '#2a2d33', map, roughness: 0.88, metalness: 0 });
    return { tex, ret, top: mat(tex), bottom: mat(ret) };
  }, [prof.textures]);
  useEffect(
    () => () => {
      belt.tex?.dispose();
      belt.ret?.dispose();
      belt.top.dispose();
      belt.bottom.dispose();
    },
    [belt],
  );
  const cargoN = prof.detail >= 1 ? 9 : prof.detail >= 0.6 ? 6 : 3;
  const cargo = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => Array.from({ length: cargoN }, (_, i) => ({ z: Math.sin(i * 12.9898) * 0.22, s: 0.8 + ((i * 37) % 10) / 25, k: (i + 0.3) / cargoN })), [cargoN]);
  const speed = useRef(0);
  const phase = useRef(0);
  const valueEl = useRef<HTMLElement>(null);

  useFrame((_, dt) => {
    const values = target.current.state?.values;
    speed.current = damp(speed.current, conveyorSpeed(values), 2.5, dt);
    const v = speed.current;
    phase.current = (phase.current + v * dt) % CONV_L;
    if (belt.tex) belt.tex.offset.x = (belt.tex.offset.x - (v * dt) / TILE) % 1;
    if (belt.ret) belt.ret.offset.x = (belt.ret.offset.x + (v * dt) / TILE) % 1;
    const im = cargo.current;
    if (im) {
      const run = v > 0.03;
      const span = CONV_L - 1.2;
      seeds.forEach((sd, i) => {
        const x = -CONV_L / 2 + 1.3 + ((sd.k * span + phase.current) % span);
        dummy.position.set(x, TOP + 0.1 * sd.s, sd.z);
        dummy.scale.setScalar(run ? sd.s : 0);
        dummy.rotation.y = i;
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
    }
    const el = valueEl.current;
    if (el) {
      const text = conveyorLabel(values);
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} name={name} type="conveyor" placement={placement} ringRadius={CONV_L / 2 + 0.7} labelPos={[0, 2.3, 0]} valueRef={valueEl}>
      <Merged geo={geo} />
      {/* banda superior y retorno */}
      <mesh position={[0, TOP - 0.02, 0]} material={belt.top} castShadow receiveShadow>
        <boxGeometry args={[CONV_L, 0.04, CONV_W]} />
      </mesh>
      <mesh position={[0, TOP - DRUM_R * 2 - 0.06, 0]} material={belt.bottom} receiveShadow>
        <boxGeometry args={[CONV_L, 0.03, CONV_W - 0.04]} />
      </mesh>
      {/* material transportado */}
      <instancedMesh ref={cargo} args={[undefined, undefined, cargoN]} frustumCulled={false} castShadow userData={{ noOutline: true }}>
        <boxGeometry args={[0.32, 0.2, 0.3]} />
        <meshStandardMaterial color="#8a6a40" roughness={0.95} metalness={0} />
      </instancedMesh>
    </Equipment>
  );
}
