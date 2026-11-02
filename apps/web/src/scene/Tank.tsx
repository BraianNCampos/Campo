'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp, damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { assetStatus } from '@/lib/status';
import { Equipment, type AssetNodeProps } from './Equipment';
import { GeoBuilder } from './kit/geo';
import { Merged, useBuilt } from './kit/Merged';
import { useQualityProfile } from './quality';
import { useAssetTarget } from './useAssetTarget';

export const TANK_R = 1.4;
export const TANK_H = 3.4;
const BASE = 0.15;
/** Medio lado de la bandeja de contención (cubeto). */
export const BUND_HALF = TANK_R + 0.6;
const BUND_H = 0.3;

const WATER = new THREE.Color('#38bdf8');
const NOSIGNAL = new THREE.Color('#6b7a8c');

/** Tanque: zócalo, cuerpo con aros y refuerzos, boca con barandilla, indicador de nivel, tomas y bandeja de contención. */
export function buildTankGeometry(radial: number, detail: number, toward: 1 | -1): Record<string, THREE.BufferGeometry> {
  const b = new GeoBuilder();
  const R = TANK_R;
  const H = TANK_H;
  // bandeja de contención: solera, muros con coronación amarilla, sumidero
  b.box('concrete', BUND_HALF * 2, 0.08, BUND_HALF * 2, { pos: [0, 0.04, 0] });
  for (const s of [-1, 1]) {
    b.box('concreteLight', BUND_HALF * 2 + 0.2, BUND_H, 0.14, { pos: [0, BUND_H / 2, s * (BUND_HALF + 0.03)] });
    b.box('concreteLight', 0.14, BUND_H, BUND_HALF * 2, { pos: [s * (BUND_HALF + 0.03), BUND_H / 2, 0] });
    b.box('safety', BUND_HALF * 2 + 0.24, 0.03, 0.18, { pos: [0, BUND_H + 0.015, s * (BUND_HALF + 0.03)] });
    b.box('safety', 0.18, 0.03, BUND_HALF * 2, { pos: [s * (BUND_HALF + 0.03), BUND_H + 0.015, 0] });
  }
  b.box('steelDark', 0.4, 0.02, 0.4, { pos: [BUND_HALF - 0.45, 0.09, -BUND_HALF + 0.45] });
  // zócalo anular
  b.cyl('steelDark', R + 0.12, R + 0.18, BASE, radial, { pos: [0, BASE / 2 + 0.08, 0] });
  // cuerpo translúcido (deja ver el líquido), aros de refuerzo y refuerzos verticales
  b.cyl('shell', R, R, H - BASE, radial, { pos: [0, 0.08 + BASE + (H - BASE) / 2, 0] }, true);
  const rings = detail >= 0.6 ? [0.02, 0.34, 0.67, 1] : [0.02, 1];
  for (const f of rings) b.torus('galvanized', R + 0.01, f === 1 || f === 0.02 ? 0.06 : 0.035, 8, radial, { pos: [0, 0.08 + BASE + f * (H - BASE), 0], rot: [Math.PI / 2, 0, 0] });
  if (detail >= 0.6) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.box('galvanized', 0.05, H - BASE, 0.04, { pos: [Math.cos(a) * (R + 0.02), 0.08 + BASE + (H - BASE) / 2, Math.sin(a) * (R + 0.02)], rot: [0, -a + Math.PI / 2, 0] });
    }
  }
  // barandilla perimetral en la boca
  if (detail >= 0.6) {
    const rail = R + 0.12;
    const top = 0.08 + H;
    b.torus('safety', rail, 0.02, 6, radial, { pos: [0, top + 0.5, 0], rot: [Math.PI / 2, 0, 0] });
    b.torus('safety', rail, 0.015, 6, radial, { pos: [0, top + 0.25, 0], rot: [Math.PI / 2, 0, 0] });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      b.box('safety', 0.03, 0.5, 0.03, { pos: [Math.cos(a) * rail, top + 0.25, Math.sin(a) * rail] });
    }
  }
  // registro de hombre y toma lateral hacia la tubería (origen: lado +x; destino: lado -x)
  b.cyl('steel', 0.22, 0.22, 0.12, 16, { pos: [0, 0.08 + H * 0.62, R + 0.04], rot: [Math.PI / 2, 0, 0] });
  b.torus('steelDark', 0.22, 0.02, 6, 16, { pos: [0, 0.08 + H * 0.62, R + 0.1] });
  b.cyl('steel', 0.2, 0.2, 0.25, 16, { pos: [toward * R, 0.88, 0], rot: [0, 0, Math.PI / 2] });
  b.cyl('steel', 0.27, 0.27, 0.07, 16, { pos: [toward * (R + 0.14), 0.88, 0], rot: [0, 0, Math.PI / 2] });
  return b.build();
}

export function Tank({ id, name, tag, placement }: AssetNodeProps) {
  const target = useAssetTarget(id);
  const prof = useQualityProfile();
  const toward: 1 | -1 = placement.position[0] < 0 ? 1 : -1;
  const geo = useBuilt(() => buildTankGeometry(prof.radial, prof.detail, toward), [prof.radial, prof.detail, toward]);
  const liquid = useRef<THREE.Mesh>(null);
  const liquidMat = useRef<THREE.MeshStandardMaterial>(null);
  const valueEl = useRef<HTMLElement>(null);
  const level = useRef<number | null>(null);
  const tmp = useMemo(() => new THREE.Color(), []);
  const y0 = 0.08 + BASE;

  useFrame((_, dt) => {
    const { state, severity } = target.current;
    const goal = state?.values.level ?? 0;
    level.current = level.current === null ? goal : damp(level.current, goal, 3.5, dt);
    const frac = clamp(level.current / 100, 0, 1);

    const mesh = liquid.current;
    if (mesh) {
      const h = Math.max(frac * (TANK_H - BASE - 0.15), 0.001);
      mesh.scale.y = h;
      mesh.position.y = y0 + h / 2;
      mesh.visible = frac > 0.004;
    }
    const mat = liquidMat.current;
    if (mat) {
      // el líquido sólo se apaga sin señal; las anomalías se señalan con el contorno y el marcador, no tiñendo el modelo
      const status = assetStatus(state, severity);
      tmp.copy(status === 'nodata' || status === 'bad' ? NOSIGNAL : WATER);
      mat.color.lerp(tmp, 1 - Math.exp(-6 * dt));
    }
    const el = valueEl.current;
    if (el) {
      const text = formatMetric('level', state?.values.level);
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} name={name} tag={tag} type="tank" placement={placement} ringRadius={BUND_HALF + 0.2} labelPos={[0, TANK_H + 0.75, 0]} valueRef={valueEl}>
      <Merged geo={geo} />
      {/* líquido */}
      <mesh ref={liquid} receiveShadow userData={{ noOutline: true }}>
        <cylinderGeometry args={[TANK_R - 0.07, TANK_R - 0.07, 1, prof.radial]} />
        <meshStandardMaterial ref={liquidMat} color="#38bdf8" roughness={0.18} metalness={0.05} emissive="#0a3a52" />
      </mesh>
      {/* marcas de umbral 10% y 90% */}
      {[0.1, 0.9].map((f) => (
        <mesh key={f} position-y={y0 + f * (TANK_H - BASE)} rotation-x={Math.PI / 2} userData={{ noOutline: true }}>
          <torusGeometry args={[TANK_R + 0.02, 0.018, 6, prof.radial]} />
          <meshBasicMaterial color="#ff6b6b" toneMapped={false} />
        </mesh>
      ))}
    </Equipment>
  );
}
