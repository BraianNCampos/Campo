import * as THREE from 'three';

/** Juntas de dilatación de una losa: líneas cada `spacing` unidades dentro de [cx±w/2, cz±d/2] a altura `y`. */
export function jointLines(cx: number, cz: number, w: number, d: number, spacing: number, y: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  for (let x = x0 + spacing; x < x1 - 0.01; x += spacing) pts.push(x, y, z0, x, y, z1);
  for (let z = z0 + spacing; z < z1 - 0.01; z += spacing) pts.push(x0, y, z, x1, y, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
