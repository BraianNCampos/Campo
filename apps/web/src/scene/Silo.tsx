'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { clamp, damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { Equipment, type AssetNodeProps } from './Equipment';
import { GeoBuilder } from './kit/geo';
import { Merged, useBuilt } from './kit/Merged';
import { useQualityProfile } from './quality';
import { useAssetTarget } from './useAssetTarget';

export const SILO_R = 1.3;
export const SILO_LEG_H = 1.6;
export const SILO_BODY_H = 4.0;
export const SILO_ROOF_H = 0.95;
export const SILO_TOP = SILO_LEG_H + SILO_BODY_H + SILO_ROOF_H;
/** Indicador de nivel: tramo útil (de la base del cilindro a su techo). */
export const GAUGE_H = SILO_BODY_H - 0.4;
const GAUGE_Y0 = SILO_LEG_H + 0.2;
const GAUGE_X = SILO_R + 0.2;
const LADDER_ANGLE = Math.PI * 0.75;

/** Geometría estática del silo, fusionada por material (cuerpo con nervaduras, techo cónico, patas, escalera con jaula). */
export function buildSiloGeometry(radial: number, detail: number): Record<string, THREE.BufferGeometry> {
  const b = new GeoBuilder();
  const R = SILO_R;
  const Y0 = SILO_LEG_H;
  const Y1 = SILO_LEG_H + SILO_BODY_H;
  // bancada de hormigón
  b.cyl('concrete', R + 0.45, R + 0.5, 0.12, radial, { pos: [0, 0.06, 0] });
  // tolva cónica y boquilla de descarga
  b.cyl('paintGray', R, 0.22, 0.95, radial, { pos: [0, Y0 - 0.475, 0] });
  b.cyl('steelDark', 0.22, 0.22, 0.4, 16, { pos: [0, 0.4, 0] });
  b.cyl('steel', 0.3, 0.3, 0.07, 16, { pos: [0, 0.2, 0] });
  // patas con placas base y aro de arriostramiento
  const legs = detail >= 0.6 ? 6 : 4;
  const legR = R * 0.9;
  const legPos: [number, number][] = [];
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * Math.PI * 2 + Math.PI / legs;
    legPos.push([Math.cos(a) * legR, Math.sin(a) * legR]);
  }
  for (const [x, z] of legPos) {
    b.box('steelDark', 0.18, Y0 - 0.1, 0.18, { pos: [x, 0.12 + (Y0 - 0.1) / 2, z] });
    b.box('steel', 0.42, 0.05, 0.42, { pos: [x, 0.145, z] });
  }
  if (detail >= 0.6) {
    for (let i = 0; i < legs; i++) {
      const [x1, z1] = legPos[i] as [number, number];
      const [x2, z2] = legPos[(i + 1) % legs] as [number, number];
      b.bar('steelDark', [x1, 0.3, z1], [x2, 1.15, z2], 0.06);
      b.bar('steelDark', [x1, 1.15, z1], [x2, 0.3, z2], 0.06);
    }
  }
  b.torus('steelDark', legR, 0.05, 8, radial, { pos: [0, 1.15, 0], rot: [Math.PI / 2, 0, 0] });
  // cuerpo cilíndrico
  b.cyl('paintGray', R, R, SILO_BODY_H, radial, { pos: [0, Y0 + SILO_BODY_H / 2, 0] });
  // nervaduras horizontales (juntas de virolas) y verticales
  const rings = Math.max(3, Math.round(9 * detail));
  for (let i = 0; i <= rings; i++) {
    const y = Y0 + (i / rings) * SILO_BODY_H;
    b.torus('galvanized', R + 0.012, i === 0 || i === rings ? 0.045 : 0.025, 6, radial, { pos: [0, y, 0], rot: [Math.PI / 2, 0, 0] });
  }
  const stiff = detail >= 0.6 ? 16 : 8;
  for (let i = 0; i < stiff; i++) {
    const a = (i / stiff) * Math.PI * 2;
    b.box('galvanized', 0.07, SILO_BODY_H, 0.05, { pos: [Math.cos(a) * (R + 0.02), Y0 + SILO_BODY_H / 2, Math.sin(a) * (R + 0.02)], rot: [0, -a + Math.PI / 2, 0] });
  }
  // techo cónico con aro de alero, ventilación y registro
  b.cyl('paintGray', 0.18, R + 0.08, SILO_ROOF_H, radial, { pos: [0, Y1 + SILO_ROOF_H / 2, 0] });
  b.torus('galvanized', R + 0.08, 0.04, 6, radial, { pos: [0, Y1, 0], rot: [Math.PI / 2, 0, 0] });
  b.cyl('steel', 0.14, 0.14, 0.3, 14, { pos: [0, SILO_TOP + 0.1, 0] });
  b.cyl('steel', 0.26, 0.06, 0.12, 14, { pos: [0, SILO_TOP + 0.31, 0] });
  b.box('steelDark', 0.5, 0.12, 0.5, { pos: [0.75, Y1 + SILO_ROOF_H * 0.55, 0.25], rot: [0, 0, -0.5] });
  // escalera vertical con jaula de seguridad
  const rad: [number, number] = [Math.cos(LADDER_ANGLE), Math.sin(LADDER_ANGLE)];
  const tan: [number, number] = [-rad[1], rad[0]];
  const base = R + 0.32;
  const top = Y1 + 0.35;
  for (const side of [-0.2, 0.2]) {
    const x = rad[0] * base + tan[0] * side;
    const z = rad[1] * base + tan[1] * side;
    b.box('safety', 0.05, top - 0.12, 0.05, { pos: [x, 0.12 + (top - 0.12) / 2, z] });
  }
  const step = detail >= 0.6 ? 0.3 : 0.6;
  for (let y = 0.4; y < top - 0.1; y += step) {
    b.cyl('safety', 0.018, 0.018, 0.4, 6, { pos: [rad[0] * base, y, rad[1] * base], rot: rot90(tan) });
  }
  // soportes de la escalera a la pared
  for (let y = 0.9; y < top; y += 1.4) {
    b.bar('steelDark', [rad[0] * R, y, rad[1] * R], [rad[0] * base, y, rad[1] * base], 0.04);
  }
  // jaula: aros y varillas (desde 2,3 m)
  const cageC = base + 0.1;
  const hoops = detail >= 0.6 ? 0.9 : 1.4;
  for (let y = 2.3; y <= top - 0.2; y += hoops) {
    b.torus('safety', 0.42, 0.016, 6, 20, { pos: [rad[0] * cageC, y, rad[1] * cageC], rot: [Math.PI / 2, 0, 0] });
  }
  if (detail >= 0.6) {
    for (let k = -2; k <= 2; k++) {
      const phi = (k / 2) * 1.05;
      const x = rad[0] * cageC + (rad[0] * Math.cos(phi) + tan[0] * Math.sin(phi)) * 0.42;
      const z = rad[1] * cageC + (rad[1] * Math.cos(phi) + tan[1] * Math.sin(phi)) * 0.42;
      b.box('safety', 0.03, top - 2.4, 0.03, { pos: [x, 2.3 + (top - 2.4) / 2, z] });
    }
  }
  // plataforma superior con barandilla
  b.box('galvanized', 0.9, 0.05, 0.9, { pos: [rad[0] * (R + 0.15), top, rad[1] * (R + 0.15)], rot: [0, -LADDER_ANGLE, 0] });
  // indicador de nivel exterior: placa trasera, vidrio y escala cada 10 %
  b.box('steelDark', 0.07, GAUGE_H + 0.16, 0.24, { pos: [GAUGE_X + 0.02, GAUGE_Y0 + GAUGE_H / 2, 0] });
  b.cyl('steelDark', 0.1, 0.1, 0.08, 10, { pos: [GAUGE_X, GAUGE_Y0 - 0.12, 0] });
  b.box('steelDark', 0.04, 0.04, 0.3, { pos: [R + 0.05, GAUGE_Y0, 0] });
  b.box('steelDark', 0.04, 0.04, 0.3, { pos: [R + 0.05, GAUGE_Y0 + GAUGE_H, 0] });
  for (let i = 0; i <= 10; i++) {
    b.box('paintWhite', 0.03, i % 5 === 0 ? 0.035 : 0.02, i % 5 === 0 ? 0.2 : 0.12, { pos: [GAUGE_X + 0.06, GAUGE_Y0 + (i / 10) * GAUGE_H, 0] });
  }
  return b.build();
}

/** Giro 90° de la dirección tangente al plano XZ → ángulo Y para orientar cilindros horizontales (eje X local → tangente). */
function rot90(tan: [number, number]): [number, number, number] {
  // cilindro con eje Y: se tumba sobre Z (eje → X) y se gira en Y para alinear con la tangente
  return [0, -Math.atan2(tan[1], tan[0]), Math.PI / 2];
}

/** Silo: cuerpo cilíndrico nervado, techo cónico, escalera con jaula, patas e indicador de nivel con el nivel real. */
export function Silo({ id, name, placement }: AssetNodeProps) {
  const target = useAssetTarget(id);
  const prof = useQualityProfile();
  const geo = useBuilt(() => buildSiloGeometry(prof.radial, prof.detail), [prof.radial, prof.detail]);
  const fill = useRef<THREE.Mesh>(null);
  const valueEl = useRef<HTMLElement>(null);
  const level = useRef<number | null>(null);

  useFrame((_, dt) => {
    const state = target.current.state;
    const goal = state?.values.level ?? 0;
    level.current = level.current === null ? goal : damp(level.current, goal, 3.5, dt);
    const frac = clamp(level.current / 100, 0, 1);
    const m = fill.current;
    if (m) {
      const h = Math.max(frac * GAUGE_H, 0.001);
      m.scale.y = h;
      m.position.y = GAUGE_Y0 + h / 2;
      m.visible = frac > 0.004;
    }
    const el = valueEl.current;
    if (el) {
      const text = formatMetric('level', state?.values.level);
      if (el.textContent !== text) el.textContent = text;
    }
  });

  return (
    <Equipment id={id} name={name} type="silo" placement={placement} ringRadius={SILO_R + 0.7} labelPos={[0, SILO_TOP + 1.0, 0]} valueRef={valueEl}>
      <Merged geo={geo} />
      {/* columna de producto en el indicador (nivel real) */}
      <mesh ref={fill} position={[GAUGE_X + 0.04, GAUGE_Y0, 0]} visible={false} userData={{ noOutline: true }}>
        <boxGeometry args={[0.07, 1, 0.1]} />
        <meshBasicMaterial color="#38bdf8" toneMapped={false} />
      </mesh>
    </Equipment>
  );
}
