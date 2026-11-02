import type { AssetType } from '@campo/shared';
import { assetKind, sortAssetIds } from '@/lib/assets';
import { modelIdOf, type SceneEntry } from '@/lib/catalog';

export type Vec3 = [number, number, number];

/** Altura del eje de las tuberías sobre el suelo. */
export const PIPE_Y = 0.8;

/** Posiciones de la planta demo (tk-01..04, pump-01..02, valve-01..02). */
export const LAYOUT: Record<string, Vec3> = {
  'tk-01': [-8, 0, -3.5],
  'tk-02': [-8, 0, 3.5],
  'tk-03': [7, 0, -3.5],
  'tk-04': [7, 0, 3.5],
  'valve-01': [-4.6, 0, -3.5],
  'valve-02': [-4.6, 0, 3.5],
  'pump-01': [-1.8, 0, -3.5],
  'pump-02': [-1.8, 0, 3.5],
};

/** Activos que no están en LAYOUT se colocan en una fila trasera, por tipo. */
export function positionFor(id: string, index: number): Vec3 {
  const known = LAYOUT[id];
  if (known) return known;
  const kind = assetKind(id);
  const row = kind === 'tank' ? 0 : kind === 'pump' ? 1 : 2;
  return [-9 + (index % 7) * 3, 0, 8 + row * 2.6 + Math.floor(index / 7) * 8];
}

/** ¿Alguno de los activos tiene posición propia en el layout de la planta demo? */
export const hasKnownLayout = (ids: readonly string[]): boolean => ids.some((id) => id in LAYOUT);

/**
 * Posiciones de todos los activos. Si la planta no tiene layout propio (cualquier planta distinta de
 * `demo`), se centran en filas por tipo dentro del suelo; si no, los desconocidos van a la fila trasera.
 */
export function positionsFor(ids: readonly string[]): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  if (hasKnownLayout(ids)) {
    ids.forEach((id, i) => (out[id] = positionFor(id, i)));
    return out;
  }
  // cuadrícula centrada: tanques, bombas, válvulas y resto en orden, hasta 5 por fila
  const sorted = sortAssetIds([...ids]);
  const cols = Math.min(5, Math.max(1, sorted.length));
  const rows = Math.ceil(sorted.length / cols);
  sorted.forEach((id, i) => {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? sorted.length - r * cols : cols;
    out[id] = [-0.5 + ((i % cols) - (inRow - 1) / 2) * 4.2, 0, (r - (rows - 1) / 2) * 4.5];
  });
  return out;
}

/** Semiejes (x, z) de la huella para empaquetar activos sin layout: cintas largas, silos anchos, naves enormes. */
function halfExtents(e: SceneEntry): [number, number] {
  switch (e.type) {
    case 'conveyor': return [3.3, 1.0];
    case 'silo': return [1.8, 1.8];
    case 'tank': return [1.7, 1.7];
    case 'pump': return [1.5, 1.1];
    case 'valve': return [0.9, 0.9];
    case 'structure': {
      const sp = structureSpec(e);
      return [sp.w / 2, sp.d / 2];
    }
    default: return [0.7, 0.7];
  }
}

const needsPacking = (entries: readonly SceneEntry[]): boolean => entries.some((e) => e.type === 'silo' || e.type === 'conveyor' || e.type === 'structure');

/**
 * Autoposición cuando hay piezas grandes (silos, cintas, naves): filas por tipo (orden de `sortAssetIds`), cada fila
 * con el ancho real de sus piezas y centrada; las estructuras decorativas van en una franja trasera para no
 * tapar el equipo.
 */
export function packPlacements(entries: readonly SceneEntry[]): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  const byId = new Map(entries.map((e) => [e.id, e]));
  const order = sortAssetIds(entries.map((e) => e.id), (id) => byId.get(id)?.type);
  const equipment = order.map((id) => byId.get(id) as SceneEntry).filter((e) => e.type !== 'structure');
  const structures = order.map((id) => byId.get(id) as SceneEntry).filter((e) => e.type === 'structure');
  const GAP = 1.2;
  const MAX_W = 24;
  const rows: { items: { e: SceneEntry; rx: number; rz: number }[]; w: number; d: number }[] = [];
  let cur: (typeof rows)[number] = { items: [], w: 0, d: 0 };
  for (const e of equipment) {
    const [rx, rz] = halfExtents(e);
    if (cur.items.length > 0 && cur.w + GAP + 2 * rx > MAX_W) {
      rows.push(cur);
      cur = { items: [], w: 0, d: 0 };
    }
    cur.w += (cur.items.length > 0 ? GAP : 0) + 2 * rx;
    cur.d = Math.max(cur.d, 2 * rz);
    cur.items.push({ e, rx, rz });
  }
  if (cur.items.length > 0) rows.push(cur);
  const rowGap = 1.6;
  const total = rows.reduce((a, r) => a + r.d, 0) + rowGap * Math.max(0, rows.length - 1);
  let z = -total / 2;
  for (const r of rows) {
    let x = -r.w / 2;
    for (const it of r.items) {
      out[it.e.id] = [x + it.rx, 0, z + r.d / 2];
      x += 2 * it.rx + GAP;
    }
    z += r.d + rowGap;
  }
  // franja trasera de estructuras
  const sw = structures.reduce((a, e) => a + 2 * halfExtents(e)[0], 0) + GAP * Math.max(0, structures.length - 1);
  const maxD = structures.reduce((a, e) => Math.max(a, 2 * halfExtents(e)[1]), 0);
  const backZ = (rows.length > 0 ? -total / 2 - 2 : 0) - maxD / 2;
  let sx = -sw / 2;
  for (const e of structures) {
    const [rx] = halfExtents(e);
    out[e.id] = [sx + rx, 0, backZ];
    sx += 2 * rx + GAP;
  }
  return out;
}

/** Posición, giro (rad) y escala de un activo en la planta. */
export interface Placement {
  position: Vec3;
  rotY: number;
  scale: number;
}

const DEG = Math.PI / 180;

/**
 * Dónde va cada activo (§10.3): su `metadata.layout`; si no la tiene, la posición hecha a mano de los ids
 * conocidos de `demo`; si no, la cuadrícula automática (con los demás sin layout propio).
 */
export function resolvePlacements(entries: readonly SceneEntry[]): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  const rest: string[] = [];
  for (const e of entries) {
    if (e.layout) {
      out[e.id] = { position: [e.layout.x, e.layout.y ?? 0, e.layout.z], rotY: (e.layout.rotY ?? 0) * DEG, scale: e.layout.scale ?? 1 };
    } else rest.push(e.id);
  }
  const restEntries = entries.filter((e) => rest.includes(e.id));
  const positions = needsPacking(restEntries) && !hasKnownLayout(rest) ? packPlacements(restEntries) : positionsFor(rest);
  for (const [id, position] of Object.entries(positions)) out[id] = { position, rotY: 0, scale: 1 };
  return out;
}

/** Radio aproximado de la huella de cada tipo (para recortar las tuberías y encuadrar la cámara). */
export const FOOTPRINT: Record<AssetType, number> = {
  tank: 1.5, pump: 1.4, valve: 0.8, sensor: 0.4, climate: 0.4, energy: 0.4, gas: 0.4, machine: 0.4, pressure: 0.4, flow: 0.4,
  silo: 1.7, conveyor: 3.2, structure: 5,
};

/** Variantes de las estructuras decorativas (§13): nave a dos aguas, bastidor de tuberías y losa de hormigón. */
export type StructureVariant = 'hall' | 'rack' | 'slab';
export interface StructureSpec {
  variant: StructureVariant;
  /** ancho (x), fondo (z) y alto (y) en unidades de escena (≈ metros) */
  w: number;
  d: number;
  h: number;
}

const STRUCTURE_DEFAULTS: Record<StructureVariant, { w: number; d: number; h: number }> = {
  hall: { w: 10, d: 7, h: 4.5 },
  rack: { w: 9, d: 1.6, h: 3.6 },
  slab: { w: 10, d: 8, h: 0.25 },
};

const finiteIn = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

/**
 * Forma de una estructura: `metadata.structure = {kind: 'hall'|'rack'|'slab', width?, depth?, height?}`; sin `kind`
 * se deduce del nombre/id (rack/tubería → bastidor; losa/suelo/piso → losa) y por defecto es una nave.
 */
export function structureSpec(e: { id?: string; name?: string; metadata?: Record<string, unknown> }): StructureSpec {
  const meta = e.metadata?.structure;
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  const text = `${e.id ?? ''} ${e.name ?? ''}`;
  const kind = m.kind ?? m.variant;
  const variant: StructureVariant =
    kind === 'hall' || kind === 'rack' || kind === 'slab' ? kind : /rack|tuber|bastidor/i.test(text) ? 'rack' : /losa|suelo|piso|slab|floor/i.test(text) ? 'slab' : 'hall';
  const d = STRUCTURE_DEFAULTS[variant];
  return {
    variant,
    w: finiteIn(m.width, 2, 80) ?? d.w,
    d: finiteIn(m.depth, 1, 80) ?? d.d,
    h: finiteIn(m.height, 0.1, 20) ?? d.h,
  };
}
const MODEL_FOOTPRINT = 0.55; // modelo GLB normalizado a 1 unidad de lado

export function footprint(e: Pick<SceneEntry, 'type' | 'model3dRef'> & Partial<Pick<SceneEntry, 'id' | 'name' | 'metadata'>>, scale: number): number {
  if (e.type === 'structure') {
    const sp = structureSpec(e);
    return (Math.max(sp.w, sp.d) / 2) * scale;
  }
  return (modelIdOf(e.model3dRef) ? MODEL_FOOTPRINT : FOOTPRINT[e.type]) * scale;
}

export interface Bounds {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  /** altura máxima de los activos (incluye el rótulo y la cubierta de las naves); por defecto 5 */
  top?: number;
}

/** Altura aproximada de cada tipo (para encuadrar la cámara con la planta entera y sin aire de sobra). */
const HEIGHT: Record<AssetType, number> = {
  tank: 5, silo: 7.6, pump: 3.4, valve: 2.4, sensor: 2.4, climate: 2.4, energy: 2.4, gas: 2.4, machine: 2.4, pressure: 2.4, flow: 2.4,
  conveyor: 2.6, structure: 4,
};

function heightOf(e: Pick<SceneEntry, 'type' | 'id' | 'name' | 'metadata'>, scale: number): number {
  if (e.type === 'structure') {
    const sp = structureSpec(e);
    return (sp.variant === 'hall' ? sp.h + (sp.d / 2) * 0.27 + 0.4 : sp.h + 0.9) * scale;
  }
  return HEIGHT[e.type] * scale;
}

/** Límites de la planta (centro y semiejes) incluyendo la huella de los activos. Vacía → los de la planta demo. */
export function sceneBounds(entries: readonly SceneEntry[], placements: Record<string, Placement>): Bounds {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = 0;
  for (const e of entries) {
    const p = placements[e.id];
    if (!p) continue;
    top = Math.max(top, p.position[1] + heightOf(e, p.scale));
    // piezas alargadas (naves, bastidores, cintas): su rectángulo real (girado si hace falta), no un círculo
    let rx = footprint(e, p.scale) + 0.4, rz = rx;
    if (e.type === 'structure' || e.type === 'conveyor') {
      const [hx, hz] = halfExtents(e);
      const turned = Math.abs(Math.sin(p.rotY)) > 0.7;
      rx = (turned ? hz : hx) * p.scale + 0.4;
      rz = (turned ? hx : hz) * p.scale + 0.4;
    }
    minX = Math.min(minX, p.position[0] - rx);
    maxX = Math.max(maxX, p.position[0] + rx);
    minZ = Math.min(minZ, p.position[2] - rz);
    maxZ = Math.max(maxZ, p.position[2] + rz);
  }
  if (!Number.isFinite(minX)) return { cx: -0.5, cz: 0, halfX: 8.9, halfZ: 4.9 };
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, halfX: Math.max(2, (maxX - minX) / 2), halfZ: Math.max(2, (maxZ - minZ) / 2), top: Math.max(3, top) };
}

export interface CameraFit {
  target: Vec3;
  distance: number;
  /** dirección desde el objetivo hacia la cámara (normalizar) */
  dir: Vec3;
}

/** Fracción del lienzo tapada por paneles superpuestos (0..0.5 por lado); la planta se encuadra en lo que queda libre. */
export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const CAMERA_FOV = 38;
/** Fracción del lienzo libre que ocupa la planta (el resto es margen). */
export const FIT_FILL = 0.94;

/**
 * Encuadre de cámara: apaisado → vista frontal (la planta es ancha en x); retrato → vista lateral. La distancia se
 * calcula proyectando la caja real de la planta (huellas + altura máxima) sobre el frustum, de modo que ocupe la
 * pantalla con un margen pequeño; el objetivo se recentra para que la caja quede centrada en lo que dejan libre los
 * paneles (`insets`). El desplazamiento de imagen correspondiente lo aplica `FitCamera` con `setViewOffset`.
 */
export function fitView(b: Bounds, aspect: number, insets: Partial<ViewInsets> = {}): CameraFit {
  const a = Math.max(aspect, 0.2);
  const portrait = aspect < 0.9;
  const dir: Vec3 = portrait ? [0.84, 0.55, 0.2] : [0.22, 0.5, 0.84];
  const n = Math.hypot(...dir);
  const D: Vec3 = [dir[0] / n, dir[1] / n, dir[2] / n]; // hacia la cámara
  const F: Vec3 = [-D[0], -D[1], -D[2]];
  // base de cámara: derecha = F × arriba, arriba' = derecha × F
  const R0: Vec3 = [-F[2], 0, F[0]];
  const rl = Math.hypot(...R0);
  const R: Vec3 = [R0[0] / rl, 0, R0[2] / rl];
  const U: Vec3 = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
  const tanV = Math.tan((CAMERA_FOV * DEG) / 2);
  const availX = Math.max(0.2, 1 - (insets.left ?? 0) - (insets.right ?? 0));
  const availY = Math.max(0.2, 1 - (insets.top ?? 0) - (insets.bottom ?? 0));
  const hx = tanV * a * availX * FIT_FILL;
  const hy = tanV * availY * FIT_FILL;
  const top = b.top ?? 5;
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, top]) corners.push([b.cx + sx * b.halfX, y, b.cz + sz * b.halfZ]);
  const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  let target: Vec3 = [b.cx, top * 0.4, b.cz];
  let distance = 6;
  for (let iter = 0; iter < 3; iter++) {
    // distancia mínima para que todas las esquinas queden dentro de la ventana libre
    distance = 6;
    for (const c of corners) {
      const p: Vec3 = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
      distance = Math.max(distance, dot(p, D) + Math.abs(dot(p, R)) / hx, dot(p, D) + Math.abs(dot(p, U)) / hy);
    }
    // recentra: lleva el centro de la caja proyectada al centro de la ventana
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const c of corners) {
      const p: Vec3 = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
      const depth = distance - dot(p, D);
      uMin = Math.min(uMin, dot(p, R) / depth);
      uMax = Math.max(uMax, dot(p, R) / depth);
      vMin = Math.min(vMin, dot(p, U) / depth);
      vMax = Math.max(vMax, dot(p, U) / depth);
    }
    const du = (uMin + uMax) / 2, dv = (vMin + vMax) / 2;
    target = [
      target[0] + (R[0] * du + U[0] * dv) * distance,
      target[1] + (R[1] * du + U[1] * dv) * distance,
      target[2] + (R[2] * du + U[2] * dv) * distance,
    ];
  }
  return { target, distance: Math.min(4000, distance), dir };
}

/** Fuente de caudal de una tubería: una línea bomba+válvula de demo, o el propio activo origen. */
export type FlowSpec = { kind: 'line'; pump: string; valve: string } | { kind: 'asset'; id: string; type: AssetType };

export interface PipeDef {
  id: string;
  points: Vec3[];
  /** claves de `PipeSet.flows` cuyo caudal alimenta esta tubería (se suma, máx. 1) */
  sources: string[];
}

export interface PipeSet {
  /** cambia cuando cambia la geometría (fuerza a reconstruir las instancias) */
  key: string;
  pipes: PipeDef[];
  flows: Record<string, FlowSpec>;
}

/** Línea de proceso: la bomba (y su válvula) gobiernan el caudal de las tuberías asociadas. */
export interface Line {
  pump: string;
  valve: string;
}
export const LINES: Line[] = [
  { pump: 'pump-01', valve: 'valve-01' },
  { pump: 'pump-02', valve: 'valve-02' },
];

const y = PIPE_Y;
export const PIPES: PipeDef[] = [
  { id: 'in-1a', sources: ['pump-01'], points: [[-6.6, y, -3.5], [-5.2, y, -3.5]] },
  { id: 'in-1b', sources: ['pump-01'], points: [[-4.0, y, -3.5], [-2.9, y, -3.5]] },
  { id: 'in-2a', sources: ['pump-02'], points: [[-6.6, y, 3.5], [-5.2, y, 3.5]] },
  { id: 'in-2b', sources: ['pump-02'], points: [[-4.0, y, 3.5], [-2.9, y, 3.5]] },
  { id: 'out-1', sources: ['pump-01'], points: [[-0.7, y, -3.5], [2.2, y, -3.5], [2.2, y, 0]] },
  { id: 'out-2', sources: ['pump-02'], points: [[-0.7, y, 3.5], [2.2, y, 3.5], [2.2, y, 0]] },
  { id: 'trunk', sources: ['pump-01', 'pump-02'], points: [[2.2, y, 0], [4.4, y, 0]] },
  { id: 'br-3', sources: ['pump-01', 'pump-02'], points: [[4.4, y, 0], [4.4, y, -3.5], [5.6, y, -3.5]] },
  { id: 'br-4', sources: ['pump-01', 'pump-02'], points: [[4.4, y, 0], [4.4, y, 3.5], [5.6, y, 3.5]] },
];

/** Tuberías manuales de la planta demo (con sus bombas y válvulas). */
export const DEMO_PIPES: PipeSet = {
  key: 'demo',
  pipes: PIPES,
  flows: Object.fromEntries(LINES.map((l) => [l.pump, { kind: 'line', pump: l.pump, valve: l.valve } as FlowSpec])),
};

/** Recorta `trimStart` y `trimEnd` de los extremos de una polilínea. `null` si no queda tramo visible. */
export function trimPolyline(points: Vec3[], trimStart: number, trimEnd: number): Vec3[] | null {
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as Vec3, b = points[i + 1] as Vec3;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lens.push(l);
    total += l;
  }
  if (total - trimStart - trimEnd < 0.3) return null;
  const at = (d: number): { p: Vec3; seg: number } => {
    let acc = 0;
    for (let i = 0; i < lens.length; i++) {
      const l = lens[i] as number;
      if (d <= acc + l || i === lens.length - 1) {
        const t = l === 0 ? 0 : (d - acc) / l;
        const a = points[i] as Vec3, b = points[i + 1] as Vec3;
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], seg: i };
      }
      acc += l;
    }
    return { p: points[points.length - 1] as Vec3, seg: lens.length - 1 };
  };
  const s = at(trimStart);
  const e = at(total - trimEnd);
  return [s.p, ...points.slice(s.seg + 1, e.seg + 1), e.p];
}

/** Ruta ortogonal (en L) entre dos posiciones: primero por el eje de mayor separación. */
export function orthogonalRoute(a: Vec3, b: Vec3): Vec3[] {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  if (Math.abs(dx) < 0.05 || Math.abs(dz) < 0.05) return [[a[0], y, a[2]], [b[0], y, b[2]]];
  const corner: Vec3 = Math.abs(dx) >= Math.abs(dz) ? [b[0], y, a[2]] : [a[0], y, b[2]];
  return [[a[0], y, a[2]], corner, [b[0], y, b[2]]];
}

/**
 * Tuberías declaradas con `metadata.connectsTo` (§10.3): una por par (origen → destino), ortogonal y
 * recortada por la huella de ambos activos. `null` si ningún activo declara conexiones; los pares con un extremo
 * inexistente o repetidos (A→B y B→A) se ignoran.
 */
export function connectionPipes(entries: readonly SceneEntry[], placements: Record<string, Placement>): PipeSet | null {
  if (!entries.some((e) => e.connectsTo.length > 0)) return null;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const pipes: PipeDef[] = [];
  const flows: Record<string, FlowSpec> = {};
  const seen = new Set<string>();
  for (const src of entries) {
    for (const dstId of src.connectsTo) {
      const dst = byId.get(dstId);
      const pa = placements[src.id], pb = placements[dstId];
      const pair = [src.id, dstId].sort().join('|');
      if (!dst || !pa || !pb || dstId === src.id || seen.has(pair)) continue;
      seen.add(pair);
      const route = trimPolyline(orthogonalRoute(pa.position, pb.position), footprint(src, pa.scale), footprint(dst, pb.scale));
      if (!route) continue;
      pipes.push({ id: `${src.id}->${dstId}`, points: route, sources: [src.id] });
      flows[src.id] = { kind: 'asset', id: src.id, type: src.type };
    }
  }
  const key = pipes.map((p) => `${p.id}:${p.points.map((q) => q.map((n) => n.toFixed(2)).join(',')).join(';')}`).join('|');
  return { key: `conn:${key}`, pipes, flows };
}

/**
 * Qué tuberías dibuja la planta: las de `connectsTo` si algún activo las declara; si no, las manuales de demo
 * mientras sus activos conserven la posición hecha a mano; si no, ninguna.
 */
export function pipeSetFor(entries: readonly SceneEntry[], placements: Record<string, Placement>): PipeSet | null {
  const conn = connectionPipes(entries, placements);
  if (conn) return conn;
  const demoMoved = entries.some((e) => e.id in LAYOUT && e.layout);
  return !demoMoved && hasKnownLayout(entries.map((e) => e.id)) ? DEMO_PIPES : null;
}
