import { DEFAULT_TAG_PREFIX, TAG_PATTERN } from '@campo/shared';
import type { AssetDef, AssetType } from '@campo/shared';

/**
 * Nomenclatura de tags (docs/architecture.md §14.1): `TNK-101`, `PMP-102`… El tag es presentación: el id técnico y los
 * tópicos MQTT no cambian. Todo es puro.
 */

export const TAG_HELP = 'Formato PREFIJO-NÚMERO, por ejemplo TNK-101 (prefijos: TNK, PMP, VLV, MTR, XMTR, PID, COMP, CONV).';

/** Mayúsculas y sin espacios en los extremos (lo que se guarda). */
export const normalizeTag = (t: string): string => t.trim().toUpperCase();

export const isValidTag = (t: string | null | undefined): t is string => typeof t === 'string' && TAG_PATTERN.test(t);

/** Tag del catálogo, o `null` si no tiene o no es válido. */
export function tagOf(def: Pick<AssetDef, 'tag'> | undefined | null): string | null {
  const t = def?.tag;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}

/** Lo que se muestra junto al nombre: el tag si hay; si no, el id técnico. */
export const displayTag = (id: string, def: Pick<AssetDef, 'tag'> | undefined | null): string => tagOf(def) ?? id;

/** Segmento de URL de un activo: el tag en minúsculas (`tnk-101`); sin tag, su id. */
export const assetSlug = (def: Pick<AssetDef, 'id' | 'tag'>): string => (tagOf(def) ?? def.id).toLowerCase();

/** Activo que corresponde a un segmento de URL (tag sin distinguir mayúsculas; si no, el id). */
export function findAssetBySlug(catalog: Record<string, AssetDef> | readonly AssetDef[], slug: string): AssetDef | undefined {
  const list = Array.isArray(catalog) ? (catalog as readonly AssetDef[]) : Object.values(catalog as Record<string, AssetDef>);
  const s = decodeURIComponent(slug).trim().toLowerCase();
  if (!s) return undefined;
  return list.find((a) => tagOf(a)?.toLowerCase() === s) ?? list.find((a) => a.id.toLowerCase() === s);
}

/** `/m/<módulo>/<tag>` (nivel 3). */
export const assetHref = (module: string, def: Pick<AssetDef, 'id' | 'tag'>): string => `/m/${module}/${encodeURIComponent(assetSlug(def))}`;
/** `/m/<módulo>/<tag>/equipo` (nivel 4). */
export const equipmentHref = (module: string, def: Pick<AssetDef, 'id' | 'tag'>): string => `${assetHref(module, def)}/equipo`;

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Siguiente tag libre del prefijo del tipo: el número más alto usado con ese prefijo más uno (mínimo 101), con 3 cifras
 * como mínimo. `taken` son los tags ya usados en la planta (se ignoran los vacíos).
 */
export function nextFreeTag(type: AssetType, taken: readonly (string | null | undefined)[], prefix: string = DEFAULT_TAG_PREFIX[type]): string {
  const used = taken.filter((t): t is string => typeof t === 'string' && t !== '');
  let max = 100;
  const re = new RegExp(`^${prefix}-(\\d{3,4})[A-Z]?$`, 'i');
  for (const t of used) {
    const m = re.exec(t);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  const make = (k: number) => `${prefix}-${String(k).padStart(3, '0')}`;
  while (used.some((t) => sameTag(t, make(n))) && n < 9999) n++;
  return make(n);
}

/**
 * Error de un tag escrito a mano (`null` = correcto). El tag es opcional (vacío vale). `others` son los demás activos de
 * la planta (el propio, si se edita, se excluye con `selfId`).
 */
export function validateTag(
  raw: string,
  others: readonly Pick<AssetDef, 'id' | 'tag'>[] = [],
  selfId?: string,
): string | null {
  const t = normalizeTag(raw);
  if (!t) return null;
  if (!TAG_PATTERN.test(t)) return `El tag no tiene el formato correcto. ${TAG_HELP}`;
  const clash = others.find((o) => o.id !== selfId && o.tag && sameTag(o.tag, t));
  if (clash) return `El tag ${t} ya lo usa ${clash.id}. Elegí otro.`;
  return null;
}

/** Texto para buscar: tag + id. */
export const tagSearchText = (id: string, def: Pick<AssetDef, 'tag'> | undefined): string => [tagOf(def) ?? '', id].join(' ');
