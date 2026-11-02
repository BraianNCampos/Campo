import * as THREE from 'three';
import type { Quality, QualityProfile } from '../quality';
import { QUALITY_PROFILE } from '../quality';
import { concreteTexture, corrugatedTexture } from './textures';

/**
 * Materiales PBR compartidos del kit industrial (uno por nivel de calidad). Sin entorno (calidad baja) los metales
 * se atenúan: sin reflejos un metal puro se ve negro.
 */
export interface KitMaterials {
  steel: THREE.MeshStandardMaterial;
  steelDark: THREE.MeshStandardMaterial;
  galvanized: THREE.MeshStandardMaterial;
  paintGray: THREE.MeshStandardMaterial;
  paintBlue: THREE.MeshStandardMaterial;
  paintWhite: THREE.MeshStandardMaterial;
  safety: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  concreteLight: THREE.MeshStandardMaterial;
  cladding: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  shell: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial;
  roofPanel: THREE.MeshStandardMaterial;
  pipe: THREE.MeshStandardMaterial;
}

const cache = new Map<string, KitMaterials>();

function make(profile: QualityProfile): KitMaterials {
  const env = profile.environment;
  const metal = (m: number) => (env ? m : m * 0.35);
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const conc = profile.textures ? concreteTexture([2, 2]) : null;
  const wall = profile.textures ? corrugatedTexture([24, 1]) : null;
  return {
    steel: std({ color: '#aab4be', metalness: metal(0.85), roughness: 0.36 }),
    steelDark: std({ color: '#566069', metalness: metal(0.8), roughness: 0.5 }),
    galvanized: std({ color: '#c3ccd4', metalness: metal(0.75), roughness: 0.46 }),
    paintGray: std({ color: '#8d99a4', metalness: metal(0.35), roughness: 0.52, bumpMap: wall, bumpScale: wall ? 0.6 : 0 }),
    paintBlue: std({ color: '#2f6f93', metalness: metal(0.35), roughness: 0.45 }),
    paintWhite: std({ color: '#e4e8ec', metalness: metal(0.2), roughness: 0.5 }),
    safety: std({ color: '#e3b218', metalness: metal(0.1), roughness: 0.55 }),
    rubber: std({ color: '#1d2024', metalness: 0, roughness: 0.92 }),
    concrete: std({ color: '#565d67', metalness: 0, roughness: 0.96, map: conc }),
    concreteLight: std({ color: '#7a828c', metalness: 0, roughness: 0.94, map: conc }),
    cladding: std({ color: '#aeb7bf', metalness: metal(0.55), roughness: 0.5, bumpMap: wall, bumpScale: wall ? 0.8 : 0 }),
    roof: std({ color: '#8f9aa4', metalness: metal(0.6), roughness: 0.46, bumpMap: wall, bumpScale: wall ? 0.8 : 0 }),
    glass: std({ color: '#9bd3e6', metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false }),
    shell: std({ color: '#9fb3c6', metalness: metal(0.6), roughness: 0.34, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    panel: std({ color: '#b9c3cc', metalness: metal(0.4), roughness: 0.55, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    roofPanel: std({ color: '#98a3ad', metalness: metal(0.5), roughness: 0.5, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
    pipe: std({ color: '#a9bccf', metalness: metal(0.6), roughness: 0.32, transparent: true, opacity: 0.55, depthWrite: false }),
  };
}

/** Materiales del nivel dado (cacheados; no se liberan: son pocos y se reutilizan entre plantas). */
export function kitMaterials(q: Quality): KitMaterials {
  let m = cache.get(q);
  if (!m) {
    m = make(QUALITY_PROFILE[q]);
    cache.set(q, m);
  }
  return m;
}
