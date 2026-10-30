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
  for (const [id, position] of Object.entries(positionsFor(rest))) out[id] = { position, rotY: 0, scale: 1 };
  return out;
}

/** Radio aproximado de la huella de cada tipo (para recortar las tuberías y encuadrar la cámara). */
export const FOOTPRINT: Record<AssetType, number> = {
  tank: 1.5, pump: 1.4, valve: 0.8, sensor: 0.4, climate: 0.4, energy: 0.4, gas: 0.4, machine: 0.4, pressure: 0.4, flow: 0.4,
};
const MODEL_FOOTPRINT = 0.55; // modelo GLB normalizado a 1 unidad de lado

export function footprint(e: Pick<SceneEntry, 'type' | 'model3dRef'>, scale: number): number {
  return (modelIdOf(e.model3dRef) ? MODEL_FOOTPRINT : FOOTPRINT[e.type]) * scale;
}

export interface Bounds {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

/** Límites de la planta (centro y semiejes) incluyendo la huella de los activos. Vacía → los de la planta demo. */
export function sceneBounds(entries: readonly SceneEntry[], placements: Record<string, Placement>): Bounds {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const e of entries) {
    const p = placements[e.id];
    if (!p) continue;
    const r = footprint(e, p.scale) + 0.4;
    minX = Math.min(minX, p.position[0] - r);
    maxX = Math.max(maxX, p.position[0] + r);
    minZ = Math.min(minZ, p.position[2] - r);
    maxZ = Math.max(maxZ, p.position[2] + r);
  }
  if (!Number.isFinite(minX)) return { cx: -0.5, cz: 0, halfX: 8.9, halfZ: 4.9 };
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, halfX: Math.max(2, (maxX - minX) / 2), halfZ: Math.max(2, (maxZ - minZ) / 2) };
}

export interface CameraFit {
  target: Vec3;
  distance: number;
  /** dirección desde el objetivo hacia la cámara (normalizar) */
  dir: Vec3;
}

/** Encuadre de cámara: apaisado → vista frontal (la planta es ancha en x); retrato → vista lateral. */
export function fitView(b: Bounds, aspect: number): CameraFit {
  const a = Math.max(aspect, 0.2);
  const portrait = aspect < 0.9;
  const widthExt = 2 * b.halfX * 1.1 + 1.9;
  const depthExt = 2 * b.halfZ * 1.2 + 3.7;
  const ext = portrait ? Math.max(depthExt, widthExt * 0.5) : Math.max(widthExt, depthExt * 1.2);
  const floor = ext >= 18 ? 22 : 12;
  return {
    target: [b.cx, 1.3, b.cz],
    distance: Math.min(4000, Math.max(floor, ext / (0.689 * a))),
    dir: portrait ? [0.84, 0.55, 0.2] : [0.22, 0.5, 0.84],
  };
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
