'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Equipment, type AssetNodeProps } from './Equipment';
import { GeoBuilder } from './kit/geo';
import { jointLines } from './kit/lines';
import { Merged, useBuilt } from './kit/Merged';
import { useQualityProfile } from './quality';
import type { StructureSpec } from './layout';

/** Nave industrial: pórticos, cubierta a dos aguas (translúcida para ver el interior), cerramientos, puertas y claraboyas. */
export function buildHallGeometry(w: number, d: number, h: number, detail: number): Record<string, THREE.BufferGeometry> {
  const b = new GeoBuilder();
  const pitch = 0.27; // pendiente (≈15°)
  const ridge = h + (d / 2) * pitch;
  const bays = Math.max(2, Math.round(w / 3));
  const hz = d / 2;
  // zócalo de hormigón
  b.box('concreteLight', w + 0.5, 0.12, d + 0.5, { pos: [0, 0.06, 0] });
  // pórticos: pilares y cerchas
  for (let i = 0; i <= bays; i++) {
    const x = -w / 2 + (i / bays) * w;
    for (const s of [-1, 1]) {
      b.box('steelDark', 0.22, h, 0.22, { pos: [x, 0.12 + h / 2, s * hz] });
      b.bar('steelDark', [x, 0.12 + h, s * hz], [x, 0.12 + ridge, 0], 0.16, 0.14);
    }
    if (detail >= 0.6) {
      // tirante y montantes de la cercha
      b.bar('steelDark', [x, 0.12 + h, -hz], [x, 0.12 + h, hz], 0.06);
      b.bar('steelDark', [x, 0.12 + h, 0], [x, 0.12 + ridge, 0], 0.06);
      for (const s of [-1, 1]) b.bar('steelDark', [x, 0.12 + h, s * hz * 0.5], [x, 0.12 + h + (ridge - h) * 0.5, s * hz * 0.5], 0.04);
    }
  }
  // correas de cubierta y de fachada (carriles horizontales)
  const purlinRows = detail >= 0.6 ? 4 : 2;
  for (const s of [-1, 1]) {
    for (let k = 0; k <= purlinRows; k++) {
      const t = k / purlinRows;
      b.box('galvanized', w, 0.07, 0.07, { pos: [0, 0.12 + h + (ridge - h) * t + 0.05, s * hz * (1 - t)] });
    }
    for (const y of [1.3, 2.6, 3.9]) if (y < h) b.box('galvanized', w, 0.06, 0.06, { pos: [0, 0.12 + y, s * (hz + 0.12)] });
  }
  b.box('galvanized', w + 0.5, 0.12, 0.14, { pos: [0, 0.12 + ridge + 0.08, 0] }); // cumbrera
  for (const s of [-1, 1]) b.cyl('galvanized', 0.06, 0.06, w + 0.5, 8, { pos: [0, 0.12 + h - 0.02, s * (hz + 0.28)], rot: [0, 0, Math.PI / 2] }); // canalones
  // cerramientos: zócalo opaco de 0,9 m y chapa translúcida encima
  b.box('concreteLight', w, 0.9, 0.16, { pos: [0, 0.12 + 0.45, -hz] });
  b.box('concreteLight', 0.16, 0.9, d, { pos: [-w / 2, 0.12 + 0.45, 0] });
  b.box('concreteLight', 0.16, 0.9, d, { pos: [w / 2, 0.12 + 0.45, 0] });
  const wallH = h - 0.9;
  b.box('panel', w, wallH, 0.08, { pos: [0, 0.12 + 0.9 + wallH / 2, -hz] });
  b.box('panel', 0.08, wallH, d, { pos: [-w / 2, 0.12 + 0.9 + wallH / 2, 0] });
  b.box('panel', 0.08, wallH, d, { pos: [w / 2, 0.12 + 0.9 + wallH / 2, 0] });
  // fachada frontal (+z): zócalo a ambos lados de las puertas y chapa por encima
  const doorW = 3.4, doorH = Math.min(3.6, h - 0.4);
  const dx = -w * 0.18;
  const pw = 1.0, ph = 2.1, px = w * 0.3;
  const gap = (x: number, ww: number) => [x - ww / 2, x + ww / 2] as const;
  const [d0, d1] = gap(dx, doorW);
  const [p0, p1] = gap(px, pw);
  const segs: [number, number][] = [[-w / 2, d0], [d1, p0], [p1, w / 2]];
  for (const [a, c] of segs) {
    if (c - a < 0.05) continue;
    b.box('concreteLight', c - a, 0.9, 0.16, { pos: [(a + c) / 2, 0.12 + 0.45, hz] });
    b.box('panel', c - a, wallH, 0.08, { pos: [(a + c) / 2, 0.12 + 0.9 + wallH / 2, hz] });
  }
  // dinteles sobre las puertas
  b.box('panel', doorW, h - doorH, 0.08, { pos: [dx, 0.12 + doorH + (h - doorH) / 2, hz] });
  b.box('panel', pw, h - ph, 0.08, { pos: [px, 0.12 + ph + (h - ph) / 2, hz] });
  // portón enrollable: marco y lamas
  b.box('safety', 0.12, doorH, 0.14, { pos: [d0 - 0.06, 0.12 + doorH / 2, hz] });
  b.box('safety', 0.12, doorH, 0.14, { pos: [d1 + 0.06, 0.12 + doorH / 2, hz] });
  b.box('safety', doorW + 0.24, 0.14, 0.16, { pos: [dx, 0.12 + doorH + 0.05, hz] });
  const slats = Math.round(doorH / (detail >= 0.6 ? 0.16 : 0.4));
  for (let i = 0; i < slats; i++) b.box('galvanized', doorW, (doorH / slats) * 0.82, 0.05, { pos: [dx, 0.12 + (i + 0.5) * (doorH / slats), hz + 0.02] });
  // puerta de personal
  b.box('paintBlue', pw - 0.1, ph - 0.1, 0.06, { pos: [px, 0.12 + ph / 2, hz + 0.02] });
  b.box('steelDark', 0.04, 0.04, 0.1, { pos: [px + 0.3, 0.12 + 1.0, hz + 0.08] });
  b.box('steelDark', pw + 0.12, 0.08, 0.12, { pos: [px, 0.12 + ph + 0.04, hz] });
  // hastiales translúcidos (triángulos) en ±x
  const tri = new THREE.Shape();
  tri.moveTo(-hz, 0);
  tri.lineTo(hz, 0);
  tri.lineTo(0, ridge - h);
  tri.closePath();
  for (const s of [-1, 1]) b.add('panel', new THREE.ShapeGeometry(tri), { pos: [s * (w / 2), 0.12 + h, 0], rot: [0, Math.PI / 2, 0] });
  // cubierta: dos faldones translúcidos con claraboyas
  const run = hz, rise = ridge - h;
  const slope = Math.hypot(run, rise);
  const ang = Math.atan2(rise, run);
  for (const s of [-1, 1]) {
    const mid: [number, number, number] = [0, 0.12 + h + rise / 2 + 0.09, s * (hz / 2)];
    b.box('roofPanel', w + 0.5, 0.05, slope + 0.5, { pos: mid, rot: [s * ang, 0, 0] });
    const skyN = Math.max(1, Math.round(w / 5));
    for (let i = 0; i < skyN; i++) {
      const sx = -w / 2 + ((i + 0.5) / skyN) * w;
      b.box('glass', Math.min(2.2, w / skyN - 0.8), 0.06, slope * 0.4, { pos: [sx, mid[1] + 0.04, mid[2]], rot: [s * ang, 0, 0] });
    }
  }
  return b.build();
}

/** Bastidor de tuberías (pipe rack): pilares y vigas en dos niveles con tuberías de distinto diámetro y bandeja de cables. */
export function buildRackGeometry(w: number, d: number, h: number, detail: number): Record<string, THREE.BufferGeometry> {
  const b = new GeoBuilder();
  const bays = Math.max(1, Math.round(w / 3));
  const hz = d / 2;
  const t1 = h * 0.62;
  b.box('concreteLight', w + 0.3, 0.1, d + 0.3, { pos: [0, 0.05, 0] });
  for (let i = 0; i <= bays; i++) {
    const x = -w / 2 + (i / bays) * w;
    for (const s of [-1, 1]) {
      b.box('steelDark', 0.16, h, 0.16, { pos: [x, 0.1 + h / 2, s * hz] });
      b.box('steel', 0.34, 0.04, 0.34, { pos: [x, 0.12, s * hz] });
    }
    for (const y of [t1, h]) b.box('steelDark', 0.12, 0.14, d + 0.3, { pos: [x, 0.1 + y, 0] });
    if (detail >= 0.6 && i < bays) {
      const nx = -w / 2 + ((i + 1) / bays) * w;
      b.bar('steelDark', [x, 0.1 + t1 * 0.3, hz], [nx, 0.1 + t1 * 0.95, hz], 0.05);
      b.bar('steelDark', [x, 0.1 + t1 * 0.95, -hz], [nx, 0.1 + t1 * 0.3, -hz], 0.05);
    }
  }
  const pipes: [string, number, number, number][] = [
    ['steel', 0.16, 0.12 + t1 + 0.2, -hz * 0.6],
    ['paintBlue', 0.11, 0.1 + t1 + 0.14, -hz * 0.1],
    ['safety', 0.09, 0.1 + t1 + 0.12, hz * 0.3],
    ['paintWhite', 0.13, 0.1 + t1 + 0.17, hz * 0.7],
    ['steel', 0.07, 0.1 + h + 0.1, -hz * 0.5],
    ['paintBlue', 0.09, 0.1 + h + 0.12, hz * 0.2],
  ];
  for (const [key, r, y, z] of pipes) {
    b.cyl(key, r, r, w + 0.3, detail >= 0.6 ? 14 : 8, { pos: [0, y, z], rot: [0, 0, Math.PI / 2] });
    for (let i = 0; i <= bays; i++) b.torus(key, r + 0.01, 0.025, 6, 12, { pos: [-w / 2 + (i / bays) * w, y, z], rot: [0, Math.PI / 2, 0] });
  }
  // bandeja de cables en el nivel superior
  b.box('galvanized', w, 0.04, 0.5, { pos: [0, 0.1 + h + 0.32, hz * 0.85] });
  for (const s of [-1, 1]) b.box('galvanized', w, 0.12, 0.03, { pos: [0, 0.1 + h + 0.36, hz * 0.85 + s * 0.25] });
  return b.build();
}

/** Losa de hormigón con juntas. */
export function buildSlabGeometry(w: number, d: number, h: number): Record<string, THREE.BufferGeometry> {
  return new GeoBuilder().box('concreteLight', w, h, d, { pos: [0, h / 2, 0] }).build();
}

/** Estructura decorativa (sin telemetría): nave, bastidor de tuberías o losa. No es seleccionable. */
export function Structure({ id, name, placement, spec }: AssetNodeProps & { spec: StructureSpec }) {
  const prof = useQualityProfile();
  const { variant, w, d, h } = spec;
  const geo = useBuilt(() => (variant === 'hall' ? buildHallGeometry(w, d, h, prof.detail) : variant === 'rack' ? buildRackGeometry(w, d, h, prof.detail) : buildSlabGeometry(w, d, h)), [variant, w, d, h, prof.detail]);
  // aristas de los paneles de la nave: la dibujan como edificio aunque los cerramientos sean translúcidos
  const edges = useMemo(() => {
    if (variant !== 'hall') return null;
    return ['panel', 'roofPanel'].flatMap((k) => (geo[k] ? [new THREE.EdgesGeometry(geo[k], 20)] : []));
  }, [variant, geo]);
  useEffect(() => () => edges?.forEach((g) => g.dispose()), [edges]);
  const joints = useMemo(() => (variant === 'slab' ? jointLines(0, 0, w, d, 4, h + 0.004) : null), [variant, w, d, h]);
  useEffect(() => () => joints?.dispose(), [joints]);
  const top = variant === 'hall' ? h + (d / 2) * 0.27 + 0.6 : h + 0.9;
  return (
    <Equipment id={id} name={name} type="structure" placement={placement} ringRadius={Math.max(w, d) / 2} labelPos={[0, top, 0]} valueRef={{ current: null }} decorative>
      <Merged geo={geo} />
      {edges?.map((g, i) => (
        <lineSegments key={i} geometry={g} userData={{ noOutline: true }}>
          <lineBasicMaterial color={i === 0 ? '#8fa6bb' : '#b4c6d8'} transparent opacity={0.9} />
        </lineSegments>
      ))}
      {joints && (
        <lineSegments geometry={joints} userData={{ noOutline: true }}>
          <lineBasicMaterial color="#3b4047" />
        </lineSegments>
      )}
    </Equipment>
  );
}
