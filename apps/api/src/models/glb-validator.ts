/**
 * Validador de GLB (glTF 2.0 binario) para docs/architecture.md §10.2. Módulo PURO: sin Nest, sin E/S.
 * Comprueba el contenedor (cabecera, longitudes, bloques), el JSON (con límites contra JSON malicioso) y la
 * coherencia estructural (índices en rango, buffers/bufferViews/accesores contra el BIN, jerarquía de nodos
 * sin ciclos ni nodos con varios padres) y aplica los límites de contenido del contrato.
 * Los mensajes de error están en español y dicen qué falla y dónde (p. ej. `accessors[3]`).
 */

export const GLB_LIMITS = {
  /** Tamaño máximo del archivo (bytes). */
  maxBytes: 10 * 1024 * 1024,
  maxNodes: 2000,
  /** Suma de `count` de los accesores POSITION de las mallas referenciadas. */
  maxVertices: 200_000,
  /**
   * Bloque JSON: un glTF legítimo ocupa decenas de KB (las texturas y la geometría van en el BIN). JSON.parse
   * es síncrono y un JSON de millones de objetos vacíos bloquea el proceso y gasta cientos de MB: 1 MiB acota
   * ese coste a ~0,1 s y ~25 MB por subida (medido con 4 MiB: 0,35 s y ~90 MB).
   */
  maxJsonBytes: 1024 * 1024,
  maxJsonDepth: 64,
} as const;

/** Extensiones que pueden ser *requeridas* (las demás se rechazan). */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
];

const COMPRESSION: Readonly<Record<string, string>> = {
  KHR_draco_mesh_compression: 'Draco',
  EXT_meshopt_compression: 'meshopt',
};

export interface GlbStats {
  nodes: number;
  meshes: number;
  vertices: number;
}

export type GlbValidation = { ok: true; stats: GlbStats } | { ok: false; error: string };

class GlbError extends Error {}
const fail = (msg: string): never => {
  throw new GlbError(msg);
};

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/** Valida un GLB completo. Nunca lanza: devuelve el primer problema encontrado. */
export function validateGlb(data: Uint8Array): GlbValidation {
  try {
    if (data.length > GLB_LIMITS.maxBytes) {
      return fail(
        `El archivo ocupa ${data.length} bytes y el máximo es ${GLB_LIMITS.maxBytes} (10 MB)`,
      );
    }
    const { json, bin } = readContainer(data);
    return { ok: true, stats: checkDocument(json, bin) };
  } catch (err) {
    if (err instanceof GlbError) return { ok: false, error: err.message };
    return { ok: false, error: `GLB no procesable: ${(err as Error).message.slice(0, 120)}` };
  }
}

// ---- Contenedor -----------------------------------------------------------------------------------------

function readContainer(data: Uint8Array): { json: Obj; bin: Uint8Array | null } {
  if (data.length < 12) {
    fail(`El archivo es demasiado corto para ser un GLB (${data.length} bytes)`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) {
    const text = data[0] === 0x7b; // '{'
    fail(
      text
        ? 'Parece un glTF de texto (.gltf); sólo se admite GLB binario autocontenido (cabecera "glTF")'
        : 'No es un GLB: la cabecera no empieza por "glTF"',
    );
  }
  const version = dv.getUint32(4, true);
  if (version !== 2) {
    fail(`Versión de contenedor GLB no soportada (${version}); se requiere la 2`);
  }
  const declared = dv.getUint32(8, true);
  if (declared !== data.length) {
    fail(
      `La longitud declarada en la cabecera (${declared} bytes) no coincide con el tamaño real ` +
        `(${data.length} bytes): archivo truncado, ampliado o corrupto`,
    );
  }

  let json: Obj | null = null;
  let bin: Uint8Array | null = null;
  let pos = 12;
  for (let index = 0; pos < data.length; index++) {
    if (pos + 8 > data.length) fail(`Bloque ${index} truncado: faltan bytes de su cabecera`);
    const length = dv.getUint32(pos, true);
    const type = dv.getUint32(pos + 4, true);
    pos += 8;
    if (length > data.length - pos) {
      fail(`El bloque ${index} declara ${length} bytes pero sólo quedan ${data.length - pos}`);
    }
    const body = data.subarray(pos, pos + length);
    pos += length;
    if (index === 0) {
      if (type !== CHUNK_JSON) fail('El primer bloque del GLB debe ser el JSON');
      json = parseJsonChunk(body);
    } else if (type === CHUNK_BIN && bin === null) {
      if (index !== 1) fail('El bloque BIN debe ir justo después del JSON');
      bin = body;
    } else if (type === CHUNK_JSON) {
      fail(`El bloque ${index} es un segundo bloque JSON`);
    } // bloques desconocidos o BIN repetidos: la especificación manda ignorarlos
  }
  if (!json) fail('El GLB no contiene ningún bloque JSON');
  return { json: json as Obj, bin };
}

function parseJsonChunk(raw: Uint8Array): Obj {
  if (raw.length > GLB_LIMITS.maxJsonBytes) {
    fail(
      `El bloque JSON ocupa ${raw.length} bytes y el máximo es ${GLB_LIMITS.maxJsonBytes}: ` +
        'incruste las texturas en el bloque BIN, no como data URI',
    );
  }
  let end = raw.length; // el relleno de alineación son espacios (o NUL en algunos exportadores)
  while (end > 0 && (raw[end - 1] === 0x20 || raw[end - 1] === 0x00)) end--;
  if (end === 0) fail('El bloque JSON está vacío');
  const body = raw.subarray(0, end);
  if (exceedsDepth(body, GLB_LIMITS.maxJsonDepth)) {
    fail(`El bloque JSON anida más de ${GLB_LIMITS.maxJsonDepth} niveles`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (err) {
    return fail(`El bloque JSON no es válido: ${(err as Error).message.slice(0, 120)}`);
  }
  if (!isObj(parsed)) fail('El bloque JSON debe ser un objeto');
  return parsed as Obj;
}

/** ¿Anidación de [] / {} por encima de `max`? Recorrido lineal que ignora el contenido de las cadenas. */
export function exceedsDepth(bytes: Uint8Array, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (inString) {
      if (c === 0x5c)
        i++; // barra invertida: salta el carácter escapado
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return false;
}

// ---- Documento glTF --------------------------------------------------------------------------------------

function list(root: Obj, key: string): unknown[] {
  const v = root[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${key} debe ser una lista`);
  return v as unknown[];
}

function objAt(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(`${path} debe ser un objeto`);
  return v as Obj;
}

/** Entero >= min. */
function intAt(v: unknown, path: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    fail(`${path} debe ser un entero >= ${min} (recibido ${show(v)})`);
  }
  return v as number;
}

/** Índice válido para una lista de `len` elementos. */
function refAt(v: unknown, len: number, path: string): number {
  const i = intAt(v, path);
  if (i >= len) fail(`${path}: el índice ${i} está fuera de rango (hay ${len})`);
  return i;
}

function checkDocument(root: Obj, bin: Uint8Array | null): GlbStats {
  const asset = objAt(root['asset'], 'asset');
  if (asset['version'] !== '2.0') {
    fail(
      `asset.version debe ser "2.0" (recibido ${show(asset['version'])}); no se admite glTF 1.x`,
    );
  }
  checkExtensions(root);

  const nodes = list(root, 'nodes');
  if (nodes.length > GLB_LIMITS.maxNodes) {
    fail(`El modelo tiene ${nodes.length} nodos y el máximo es ${GLB_LIMITS.maxNodes}`);
  }
  const buffers = list(root, 'buffers');
  const views = list(root, 'bufferViews');
  const accessors = list(root, 'accessors');
  const meshes = list(root, 'meshes');
  const images = list(root, 'images');
  const textures = list(root, 'textures');
  const materials = list(root, 'materials');
  const samplers = list(root, 'samplers');

  const bufferLength = checkBuffers(buffers, bin);
  const viewInfo = checkViews(views, bufferLength);
  const counts = checkAccessors(accessors, viewInfo);
  checkImages(images, views.length);
  checkTextures(textures, images.length, samplers.length);
  checkMaterials(materials, textures.length);
  const positions = checkMeshes(meshes, accessors.length, materials.length);
  checkNodes(nodes, meshes.length, list(root, 'skins').length, list(root, 'cameras').length);
  checkScenes(root, nodes.length);
  checkSkins(list(root, 'skins'), nodes.length, accessors.length);
  checkAnimations(list(root, 'animations'), nodes.length, accessors.length);

  // Vértices: accesores POSITION distintos de las mallas que algún nodo referencia.
  const used = new Set<number>();
  for (const n of nodes) {
    const m = (n as Obj)['mesh'];
    if (typeof m === 'number') used.add(m);
  }
  if (used.size === 0) fail('El modelo no contiene ninguna malla referenciada por un nodo');
  const accessorsUsed = new Set<number>();
  for (const m of used) for (const a of positions[m]) accessorsUsed.add(a);
  let vertices = 0;
  for (const a of accessorsUsed) vertices += counts[a];
  if (vertices > GLB_LIMITS.maxVertices) {
    fail(`El modelo tiene ${vertices} vértices y el máximo es ${GLB_LIMITS.maxVertices}`);
  }
  return { nodes: nodes.length, meshes: used.size, vertices };
}

function checkExtensions(root: Obj): void {
  const names = (key: string): string[] =>
    list(root, key).map((e, i) => {
      if (typeof e !== 'string') fail(`${key}[${i}] debe ser una cadena`);
      return e as string;
    });
  const required = names('extensionsRequired');
  const used = names('extensionsUsed');
  for (const ext of [...required, ...used]) {
    const kind = COMPRESSION[ext];
    if (kind) {
      fail(`Compresión ${kind} (${ext}) no soportada: exporte el modelo sin comprimir geometría`);
    }
  }
  for (const ext of required) {
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      fail(
        `La extensión requerida "${show(ext)}" no está permitida (permitidas: ${ALLOWED_EXTENSIONS.join(', ')})`,
      );
    }
  }
}

/** Comprueba las extensiones de compresión escondidas en un objeto aunque no figuren en extensionsUsed. */
function noCompression(o: Obj, path: string): void {
  const ext = o['extensions'];
  if (!isObj(ext)) return;
  for (const name of Object.keys(ext)) {
    if (COMPRESSION[name]) {
      fail(`${path} usa compresión ${COMPRESSION[name]} (${name}), no soportada`);
    }
  }
}

/** Un uri sólo puede ser un data URI: nada de recursos externos. */
function embeddedUri(uri: unknown, path: string): void {
  if (typeof uri !== 'string') fail(`${path}.uri debe ser una cadena`);
  if (!/^data:/i.test(uri as string)) {
    fail(`${path}.uri apunta a un recurso externo ("${show(uri)}"): el GLB debe ser autocontenido`);
  }
}

function checkBuffers(buffers: unknown[], bin: Uint8Array | null): number[] {
  return buffers.map((b, i) => {
    const path = `buffers[${i}]`;
    const buf = objAt(b, path);
    const byteLength = intAt(buf['byteLength'], `${path}.byteLength`, 1);
    if (buf['uri'] !== undefined) {
      embeddedUri(buf['uri'], path);
    } else {
      if (i !== 0) fail(`${path} no tiene uri y sólo el buffer 0 puede apuntar al bloque BIN`);
      if (!bin) fail(`${path} no tiene uri pero el GLB no contiene bloque BIN`);
      const binLength = (bin as Uint8Array).length;
      if (byteLength > binLength) {
        fail(`${path}.byteLength (${byteLength}) supera el bloque BIN (${binLength} bytes)`);
      }
      if (binLength - byteLength >= 4) {
        fail(
          `${path}.byteLength (${byteLength}) no coincide con el bloque BIN (${binLength} bytes): ` +
            'sobran más de 3 bytes',
        );
      }
    }
    return byteLength;
  });
}

interface ViewInfo {
  length: number;
  stride?: number;
}

function checkViews(views: unknown[], bufferLength: number[]): ViewInfo[] {
  return views.map((v, i) => {
    const path = `bufferViews[${i}]`;
    const view = objAt(v, path);
    noCompression(view, path);
    const buffer = refAt(view['buffer'], bufferLength.length, `${path}.buffer`);
    const offset =
      view['byteOffset'] === undefined ? 0 : intAt(view['byteOffset'], `${path}.byteOffset`);
    const length = intAt(view['byteLength'], `${path}.byteLength`, 1);
    if (offset + length > bufferLength[buffer]) {
      fail(
        `${path} se sale de su buffer (termina en el byte ${offset + length} y buffers[${buffer}] ` +
          `tiene ${bufferLength[buffer]})`,
      );
    }
    let stride: number | undefined;
    if (view['byteStride'] !== undefined) {
      stride = intAt(view['byteStride'], `${path}.byteStride`, 4);
      if (stride > 252 || stride % 4 !== 0) {
        fail(`${path}.byteStride (${stride}) debe ser múltiplo de 4 entre 4 y 252`);
      }
    }
    return { length, stride };
  });
}

/** Devuelve el `count` de cada accesor. */
function checkAccessors(accessors: unknown[], views: ViewInfo[]): number[] {
  return accessors.map((a, i) => {
    const path = `accessors[${i}]`;
    const acc = objAt(a, path);
    const count = intAt(acc['count'], `${path}.count`, 1);
    const componentBytes = COMPONENT_BYTES[acc['componentType'] as number];
    if (componentBytes === undefined) {
      fail(`${path}.componentType no válido (${show(acc['componentType'])})`);
    }
    const components = TYPE_COMPONENTS[acc['type'] as string];
    if (components === undefined) fail(`${path}.type no válido (${show(acc['type'])})`);
    const offset =
      acc['byteOffset'] === undefined ? 0 : intAt(acc['byteOffset'], `${path}.byteOffset`);
    const element = componentBytes * components;

    if (acc['bufferView'] !== undefined) {
      const idx = refAt(acc['bufferView'], views.length, `${path}.bufferView`);
      const view = views[idx];
      const needed = offset + (view.stride ?? element) * (count - 1) + element;
      if (needed > view.length) {
        fail(
          `${path} se sale de su bufferView (necesita ${needed} bytes y bufferViews[${idx}] tiene ${view.length})`,
        );
      }
    } else if (count > GLB_LIMITS.maxVertices) {
      fail(`${path} no tiene bufferView y su count (${count}) es excesivo`);
    }
    if (acc['sparse'] !== undefined) {
      const sparse = objAt(acc['sparse'], `${path}.sparse`);
      const n = intAt(sparse['count'], `${path}.sparse.count`, 1);
      if (n > count) fail(`${path}.sparse.count (${n}) supera el count del accesor (${count})`);
      for (const part of ['indices', 'values']) {
        refAt(
          objAt(sparse[part], `${path}.sparse.${part}`)['bufferView'],
          views.length,
          `${path}.sparse.${part}.bufferView`,
        );
      }
    }
    return count;
  });
}

function checkImages(images: unknown[], viewCount: number): void {
  images.forEach((im, i) => {
    const path = `images[${i}]`;
    const img = objAt(im, path);
    if (img['uri'] !== undefined) embeddedUri(img['uri'], path);
    else if (img['bufferView'] === undefined) fail(`${path} no tiene uri ni bufferView`);
    if (img['bufferView'] !== undefined) refAt(img['bufferView'], viewCount, `${path}.bufferView`);
  });
}

function checkTextures(textures: unknown[], imageCount: number, samplerCount: number): void {
  textures.forEach((t, i) => {
    const path = `textures[${i}]`;
    const tex = objAt(t, path);
    if (tex['source'] !== undefined) refAt(tex['source'], imageCount, `${path}.source`);
    if (tex['sampler'] !== undefined) refAt(tex['sampler'], samplerCount, `${path}.sampler`);
  });
}

function checkMaterials(materials: unknown[], textureCount: number): void {
  materials.forEach((m, i) => {
    const path = `materials[${i}]`;
    const mat = objAt(m, path);
    const pbr =
      mat['pbrMetallicRoughness'] === undefined
        ? {}
        : objAt(mat['pbrMetallicRoughness'], `${path}.pbrMetallicRoughness`);
    const slots: [string, Obj, string][] = [
      ['pbrMetallicRoughness.baseColorTexture', pbr, 'baseColorTexture'],
      ['pbrMetallicRoughness.metallicRoughnessTexture', pbr, 'metallicRoughnessTexture'],
      ['normalTexture', mat, 'normalTexture'],
      ['occlusionTexture', mat, 'occlusionTexture'],
      ['emissiveTexture', mat, 'emissiveTexture'],
    ];
    for (const [label, holder, key] of slots) {
      if (holder[key] === undefined) continue;
      const info = objAt(holder[key], `${path}.${label}`);
      refAt(info['index'], textureCount, `${path}.${label}.index`);
    }
  });
}

/** Devuelve, por malla, los índices de sus accesores POSITION. */
function checkMeshes(meshes: unknown[], accessorCount: number, materialCount: number): number[][] {
  return meshes.map((m, i) => {
    const path = `meshes[${i}]`;
    const mesh = objAt(m, path);
    const prims = mesh['primitives'];
    if (!Array.isArray(prims) || prims.length === 0)
      fail(`${path}.primitives debe ser una lista no vacía`);
    const positions: number[] = [];
    (prims as unknown[]).forEach((p, j) => {
      const pp = `${path}.primitives[${j}]`;
      const prim = objAt(p, pp);
      noCompression(prim, pp);
      const attributes = objAt(prim['attributes'], `${pp}.attributes`);
      for (const [name, idx] of Object.entries(attributes)) {
        const a = refAt(idx, accessorCount, `${pp}.attributes.${name}`);
        if (name === 'POSITION') positions.push(a);
      }
      if (prim['indices'] !== undefined) refAt(prim['indices'], accessorCount, `${pp}.indices`);
      if (prim['material'] !== undefined) refAt(prim['material'], materialCount, `${pp}.material`);
      if (prim['mode'] !== undefined) {
        const mode = intAt(prim['mode'], `${pp}.mode`);
        if (mode > 6) fail(`${pp}.mode no válido (${mode})`);
      }
      if (prim['targets'] !== undefined) {
        if (!Array.isArray(prim['targets'])) fail(`${pp}.targets debe ser una lista`);
        (prim['targets'] as unknown[]).forEach((t, k) => {
          for (const [name, idx] of Object.entries(objAt(t, `${pp}.targets[${k}]`))) {
            refAt(idx, accessorCount, `${pp}.targets[${k}].${name}`);
          }
        });
      }
    });
    return positions;
  });
}

function checkNodes(
  nodes: unknown[],
  meshCount: number,
  skinCount: number,
  cameraCount: number,
): void {
  const parent = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    const path = `nodes[${i}]`;
    const node = objAt(n, path);
    if (node['mesh'] !== undefined) refAt(node['mesh'], meshCount, `${path}.mesh`);
    if (node['skin'] !== undefined) refAt(node['skin'], skinCount, `${path}.skin`);
    if (node['camera'] !== undefined) refAt(node['camera'], cameraCount, `${path}.camera`);
    if (node['children'] === undefined) return;
    if (!Array.isArray(node['children'])) fail(`${path}.children debe ser una lista`);
    (node['children'] as unknown[]).forEach((c, k) => {
      const child = refAt(c, nodes.length, `${path}.children[${k}]`);
      if (child === i) fail(`Ciclo en la jerarquía: el nodo ${i} es hijo de sí mismo`);
      if (parent[child] !== -1) {
        fail(
          `El nodo ${child} tiene más de un padre (nodos ${parent[child]} y ${i}): la jerarquía debe ser un árbol`,
        );
      }
      parent[child] = i;
    });
  });
  // Con un único padre por nodo, un ciclo es seguir los padres sin llegar nunca a una raíz.
  const state = new Uint8Array(nodes.length); // 0 = sin visitar, 1 = en el camino actual, 2 = resuelto
  for (let s = 0; s < nodes.length; s++) {
    const path: number[] = [];
    let cur = s;
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      path.push(cur);
      cur = parent[cur];
    }
    if (cur !== -1 && state[cur] === 1)
      fail(`Ciclo en la jerarquía de nodos (incluye el nodo ${cur})`);
    for (const p of path) state[p] = 2;
  }
}

function checkScenes(root: Obj, nodeCount: number): void {
  const scenes = list(root, 'scenes');
  scenes.forEach((s, i) => {
    const scene = objAt(s, `scenes[${i}]`);
    if (scene['nodes'] === undefined) return;
    if (!Array.isArray(scene['nodes'])) fail(`scenes[${i}].nodes debe ser una lista`);
    (scene['nodes'] as unknown[]).forEach((n, k) =>
      refAt(n, nodeCount, `scenes[${i}].nodes[${k}]`),
    );
  });
  if (root['scene'] !== undefined) refAt(root['scene'], scenes.length, 'scene');
}

function checkSkins(skins: unknown[], nodeCount: number, accessorCount: number): void {
  skins.forEach((s, i) => {
    const path = `skins[${i}]`;
    const skin = objAt(s, path);
    if (!Array.isArray(skin['joints'])) fail(`${path}.joints debe ser una lista`);
    (skin['joints'] as unknown[]).forEach((j, k) => refAt(j, nodeCount, `${path}.joints[${k}]`));
    if (skin['skeleton'] !== undefined) refAt(skin['skeleton'], nodeCount, `${path}.skeleton`);
    if (skin['inverseBindMatrices'] !== undefined) {
      refAt(skin['inverseBindMatrices'], accessorCount, `${path}.inverseBindMatrices`);
    }
  });
}

function checkAnimations(animations: unknown[], nodeCount: number, accessorCount: number): void {
  animations.forEach((a, i) => {
    const path = `animations[${i}]`;
    const anim = objAt(a, path);
    const samplers = anim['samplers'] === undefined ? [] : (anim['samplers'] as unknown[]);
    if (!Array.isArray(samplers)) fail(`${path}.samplers debe ser una lista`);
    samplers.forEach((s, k) => {
      const sp = objAt(s, `${path}.samplers[${k}]`);
      refAt(sp['input'], accessorCount, `${path}.samplers[${k}].input`);
      refAt(sp['output'], accessorCount, `${path}.samplers[${k}].output`);
    });
    const channels = anim['channels'] === undefined ? [] : (anim['channels'] as unknown[]);
    if (!Array.isArray(channels)) fail(`${path}.channels debe ser una lista`);
    channels.forEach((c, k) => {
      const cp = `${path}.channels[${k}]`;
      const ch = objAt(c, cp);
      refAt(ch['sampler'], samplers.length, `${cp}.sampler`);
      const target = objAt(ch['target'], `${cp}.target`);
      if (target['node'] !== undefined) refAt(target['node'], nodeCount, `${cp}.target.node`);
    });
  });
}
