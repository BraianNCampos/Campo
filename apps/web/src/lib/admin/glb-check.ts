/** Extensiones glTF requeridas admitidas (docs/architecture.md §10.2). */
export const ALLOWED_EXTENSIONS = new Set([
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
]);
const REJECTED_USED = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
export const GLB_MAX_VERTICES = 200_000;
export const GLB_MAX_NODES = 2000;

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

interface GltfJson {
  extensionsRequired?: unknown;
  extensionsUsed?: unknown;
  buffers?: { uri?: unknown }[];
  images?: { uri?: unknown }[];
  nodes?: unknown[];
  accessors?: { count?: unknown }[];
  meshes?: { primitives?: { attributes?: { POSITION?: unknown } }[] }[];
}

const external = (uri: unknown) => typeof uri === 'string' && !uri.startsWith('data:');

/**
 * Comprobación básica de un GLB con las mismas reglas que la API (cabecera, versión, longitud, JSON, URIs
 * externas, extensiones, límites). Devuelve el motivo (corto, en español; la API lo antepone con «GLB no válido: ») o `null` si es válido. Lo usa el mock de demo.
 */
export function checkGlb(buf: ArrayBuffer): string | null {
  if (buf.byteLength < 20) return 'archivo demasiado corto';
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) return 'falta la cabecera glTF (¿es realmente un .glb?)';
  if (dv.getUint32(4, true) !== 2) return 'sólo se admite glTF 2.0';
  if (dv.getUint32(8, true) !== buf.byteLength) return 'archivo truncado o corrupto (la longitud no coincide)';
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLen > buf.byteLength) return 'bloque JSON incorrecto';
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) as GltfJson;
  } catch {
    return 'JSON ilegible';
  }
  if (typeof json !== 'object' || json === null) return 'contenido inesperado';
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const bad = required.find((e) => typeof e === 'string' && !ALLOWED_EXTENSIONS.has(e));
  if (bad) return `extensión glTF no admitida: ${String(bad)}`;
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  const comp = used.find((e) => REJECTED_USED.includes(String(e)));
  if (comp) return 'no se admiten modelos comprimidos con Draco ni meshopt';
  if ((json.buffers ?? []).some((b) => external(b?.uri)) || (json.images ?? []).some((i) => external(i?.uri))) {
    return 'el modelo debe ser autocontenido: no se admiten archivos externos (URIs)';
  }
  if ((json.nodes?.length ?? 0) > GLB_MAX_NODES) return `demasiados nodos (máximo ${GLB_MAX_NODES})`;
  const positions = new Set<number>();
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) if (typeof p.attributes?.POSITION === 'number') positions.add(p.attributes.POSITION);
  let vertices = 0;
  for (const i of positions) {
    const count = json.accessors?.[i]?.count;
    if (typeof count === 'number') vertices += count;
  }
  if (vertices > GLB_MAX_VERTICES) return `demasiados vértices (máximo ${GLB_MAX_VERTICES.toLocaleString('es-ES')})`;
  return null;
}
