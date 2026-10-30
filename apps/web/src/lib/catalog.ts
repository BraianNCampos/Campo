import { MODEL_REF_PATTERN } from '@campo/shared';
import type { AssetDef, AssetLayout, AssetState, AssetType } from '@campo/shared';
import { assetKind, assetLabel, sortAssetIds } from './assets';

/** Rangos de `metadata.layout` (docs/architecture.md §10.3). */
export const LAYOUT_LIMITS = { pos: 1000, scaleMin: 0.05, scaleMax: 50, maxConnections: 32 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inPos = (v: number) => Math.abs(v) <= LAYOUT_LIMITS.pos;

/** `metadata.layout` válido o `undefined` (entonces se usa el layout de demo o la cuadrícula). */
export function parseLayout(metadata: unknown): AssetLayout | undefined {
  const raw = isObj(metadata) ? metadata.layout : undefined;
  if (!isObj(raw) || !fin(raw.x) || !fin(raw.z) || !inPos(raw.x) || !inPos(raw.z)) return undefined;
  const out: AssetLayout = { x: raw.x, z: raw.z };
  if (raw.y !== undefined) {
    if (!fin(raw.y) || !inPos(raw.y)) return undefined;
    out.y = raw.y;
  }
  if (raw.rotY !== undefined) {
    if (!fin(raw.rotY)) return undefined;
    out.rotY = raw.rotY;
  }
  if (raw.scale !== undefined) {
    if (!fin(raw.scale) || raw.scale < LAYOUT_LIMITS.scaleMin || raw.scale > LAYOUT_LIMITS.scaleMax) return undefined;
    out.scale = raw.scale;
  }
  return out;
}

/** `metadata.connectsTo` saneado: sólo cadenas únicas, sin vacías. */
export function parseConnectsTo(metadata: unknown): string[] {
  const raw = isObj(metadata) ? metadata.connectsTo : undefined;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x !== ''))].slice(0, LAYOUT_LIMITS.maxConnections);
}

/** `model:<uuid>` → `<uuid>`; cualquier otra cosa (null, tipo procedural heredado…) → null. */
export function modelIdOf(ref: string | null | undefined): string | null {
  return ref && MODEL_REF_PATTERN.test(ref) ? ref.slice('model:'.length) : null;
}

export const catalogMap = (list: readonly AssetDef[]): Record<string, AssetDef> => Object.fromEntries(list.map((a) => [a.id, a]));

/** Mismo contenido (evita rehacer la escena si el catálogo recargado no ha cambiado). */
export function sameCatalog(a: Record<string, AssetDef>, b: Record<string, AssetDef>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return !!x && !!y && x.name === y.name && x.type === y.type && x.model3dRef === y.model3dRef && JSON.stringify(x.metadata) === JSON.stringify(y.metadata);
  });
}

/** Ids visibles = catálogo ∪ telemetría, ordenados por tipo y luego id. */
export function mergeAssetIds(catalog: Record<string, AssetDef>, assets: Record<string, AssetState>): string[] {
  const ids = new Set([...Object.keys(catalog), ...Object.keys(assets)]);
  return sortAssetIds([...ids], (id) => catalog[id]?.type);
}

/** Un activo con telemetría que no está en el catálogo (sólo se afirma con el catálogo ya cargado). */
export const isUncataloged = (id: string, catalog: Record<string, AssetDef>, catalogReady: boolean): boolean =>
  catalogReady && !(id in catalog);

/** Lo que el 3D necesita de cada activo. */
export interface SceneEntry {
  id: string;
  type: AssetType;
  name: string;
  model3dRef: string | null;
  layout?: AssetLayout;
  connectsTo: string[];
}

export function entryOf(def: AssetDef): SceneEntry {
  return {
    id: def.id,
    type: def.type,
    name: def.name,
    model3dRef: def.model3dRef,
    layout: parseLayout(def.metadata),
    connectsTo: parseConnectsTo(def.metadata),
  };
}

/**
 * Activos que se dibujan: los del catálogo por su `type`; los que sólo tienen telemetría, por el tipo que
 * sugiere su id (tanque/bomba/válvula) como hasta ahora; el resto no se dibuja.
 */
export function sceneEntries(ids: readonly string[], catalog: Record<string, AssetDef>): SceneEntry[] {
  const out: SceneEntry[] = [];
  for (const id of ids) {
    const def = catalog[id];
    if (def) {
      out.push(entryOf(def));
      continue;
    }
    const kind = assetKind(id);
    if (kind === 'tank' || kind === 'pump' || kind === 'valve') {
      out.push({ id, type: kind, name: assetLabel(id), model3dRef: null, connectsTo: [] });
    }
  }
  return out;
}
