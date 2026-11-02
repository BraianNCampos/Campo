import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type V3 = [number, number, number];

export interface Xf {
  pos?: V3;
  /** rotación Euler XYZ (rad) */
  rot?: V3;
  scale?: V3 | number;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const p = new THREE.Vector3();
const s = new THREE.Vector3();

/**
 * Constructor de geometría estática por material: acumula primitivas con su transformación y las fusiona en UNA
 * geometría por clave de material. Un activo con muchas piezas (nervaduras, peldaños, rodillos…) se dibuja con
 * unas pocas mallas en vez de cientos (menos draw calls y mejor rendimiento por software).
 */
export class GeoBuilder {
  private parts = new Map<string, THREE.BufferGeometry[]>();

  add(key: string, geo: THREE.BufferGeometry, xf: Xf = {}): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const sc = typeof xf.scale === 'number' ? ([xf.scale, xf.scale, xf.scale] as V3) : (xf.scale ?? [1, 1, 1]);
    q.setFromEuler(e.set(...(xf.rot ?? [0, 0, 0])));
    m4.compose(p.set(...(xf.pos ?? [0, 0, 0])), q, s.set(...sc));
    g.applyMatrix4(m4);
    // sólo los atributos comunes (position/normal/uv) para que la fusión no falle
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    const list = this.parts.get(key) ?? [];
    list.push(g);
    this.parts.set(key, list);
    return this;
  }

  box(key: string, w: number, h: number, d: number, xf?: Xf): this {
    return this.add(key, new THREE.BoxGeometry(w, h, d), xf);
  }
  /** cilindro/cono truncado (eje Y) */
  cyl(key: string, rTop: number, rBottom: number, h: number, radial: number, xf?: Xf, openEnded = false): this {
    return this.add(key, new THREE.CylinderGeometry(rTop, rBottom, h, radial, 1, openEnded), xf);
  }
  torus(key: string, r: number, tube: number, radial: number, tubular: number, xf?: Xf, arc = Math.PI * 2): this {
    return this.add(key, new THREE.TorusGeometry(r, tube, radial, tubular, arc), xf);
  }
  sphere(key: string, r: number, w: number, h: number, xf?: Xf): this {
    return this.add(key, new THREE.SphereGeometry(r, w, h), xf);
  }
  /** barra entre dos puntos (sección rectangular w×t) */
  bar(key: string, a: V3, b: V3, w: number, t = w): this {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    if (len < 1e-6) return this;
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const eul = new THREE.Euler().setFromQuaternion(quat);
    return this.box(key, w, len, t, { pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], rot: [eul.x, eul.y, eul.z] });
  }
  /** tubo entre dos puntos */
  pipe(key: string, a: V3, b: V3, r: number, radial = 12): this {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    if (len < 1e-6) return this;
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const eul = new THREE.Euler().setFromQuaternion(quat);
    return this.cyl(key, r, r, len, radial, { pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], rot: [eul.x, eul.y, eul.z] });
  }

  /** Una geometría fusionada por clave (vacía → omitida). */
  build(): Record<string, THREE.BufferGeometry> {
    const out: Record<string, THREE.BufferGeometry> = {};
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (merged) {
        merged.computeBoundingSphere();
        out[key] = merged;
      }
    }
    this.parts.clear();
    return out;
  }
}

export const disposeAll = (g: Record<string, THREE.BufferGeometry>): void => {
  for (const k of Object.keys(g)) g[k]?.dispose();
};
