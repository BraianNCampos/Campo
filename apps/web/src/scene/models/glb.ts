import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MODEL_MAX_BYTES } from '@/lib/admin/models';
import { GLB_MAX_NODES, GLB_MAX_VERTICES } from '@/lib/admin/glb-check';

/** Un GLB ya analizado, compartido por todos los activos que lo usan (no se modifica nunca). */
export interface LoadedModel {
  scene: THREE.Group;
  /** caja envolvente original */
  size: THREE.Vector3;
  center: THREE.Vector3;
  minY: number;
  vertices: number;
}

const MAGIC = 0x46546c67;

const materialsOf = (m: THREE.Material | THREE.Material[] | undefined): THREE.Material[] => (Array.isArray(m) ? m : m ? [m] : []);

/**
 * Analiza un GLB autocontenido. Sin Draco/meshopt/KTX2 (el cargador los rechaza al no tener decodificadores)
 * y sin cargas externas: sólo se admiten URIs `blob:`/`data:` (texturas embebidas). Lanza `Error` con un motivo
 * legible ante cualquier problema (cabecera, límites, caja vacía…): quien llama cae al modelo procedural.
 */
export async function parseGlb(bytes: ArrayBuffer): Promise<LoadedModel> {
  if (bytes.byteLength > MODEL_MAX_BYTES) throw new Error('El modelo supera el tamaño máximo.');
  if (bytes.byteLength < 20 || new DataView(bytes).getUint32(0, true) !== MAGIC) throw new Error('No es un archivo GLB.');

  const blocked: string[] = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob|data):/i.test(url)) return url;
    blocked.push(url);
    return 'data:,';
  });
  const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
  const scene = gltf.scene;
  if (blocked.length > 0) {
    disposeObject(scene);
    throw new Error('El modelo referencia archivos externos.');
  }

  let nodes = 0;
  let vertices = 0;
  const extras: THREE.Object3D[] = [];
  scene.traverse((o) => {
    nodes++;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
    if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) extras.push(o);
  });
  if (nodes > GLB_MAX_NODES || vertices > GLB_MAX_VERTICES) {
    disposeObject(scene);
    throw new Error('El modelo es demasiado complejo.');
  }
  for (const o of extras) o.removeFromParent(); // luces y cámaras del archivo: la escena pone las suyas

  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  if (box.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite) || Math.max(size.x, size.y, size.z) < 1e-6) {
    disposeObject(scene);
    throw new Error('El modelo no tiene geometría visible.');
  }
  return { scene, size, center: box.getCenter(new THREE.Vector3()), minY: box.min.y, vertices };
}

/** Libera geometrías, materiales y texturas de un árbol de objetos. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    for (const m of materialsOf(mesh.material)) disposeMaterial(m, true);
  });
}

function disposeMaterial(m: THREE.Material, withTextures: boolean): void {
  if (withTextures) {
    for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
  }
  m.dispose();
}

export const disposeModel = (m: LoadedModel): void => disposeObject(m.scene);

/** Copia de un modelo para un activo: comparte geometrías y texturas, pero con materiales propios (se tiñen sin contaminar la caché). */
export interface ModelInstance {
  object: THREE.Object3D;
  /** libera los materiales clonados (no las geometrías/texturas compartidas) */
  dispose(): void;
}

export function createInstance(model: LoadedModel): ModelInstance {
  const object = cloneSkinned(model.scene);
  const clones = new Map<THREE.Material, THREE.Material>();
  const own = (m: THREE.Material) => {
    let c = clones.get(m);
    if (!c) clones.set(m, (c = m.clone()));
    return c;
  };
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    mesh.frustumCulled = true;
  });
  return { object, dispose: () => clones.forEach((c) => disposeMaterial(c, false)) };
}

/** Escala y desplazamiento que ajustan el modelo a una caja de 1 unidad de lado, centrado en x/z y apoyado en y=0. */
export function normalization(model: Pick<LoadedModel, 'size' | 'center' | 'minY'>): { k: number; offset: [number, number, number] } {
  const k = 1 / Math.max(model.size.x, model.size.y, model.size.z);
  return { k, offset: [-model.center.x * k, -model.minY * k, -model.center.z * k] };
}
