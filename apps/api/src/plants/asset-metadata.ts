import { ID_PATTERN } from '@campo/shared';

/** Límites de `metadata.layout` y `metadata.connectsTo` (§10.3) y de los metadatos de dominio `scale` (§11.2). */
export const LAYOUT_LIMITS = {
  maxCoord: 1000, // |x|, |z|, |y| en metros
  maxRotY: 3600, // grados (10 vueltas: de sobra, y acota valores absurdos)
  minScale: 0.05,
  maxScale: 50,
  maxConnections: 32,
  maxScaleMetrics: 32,
} as const;

const METRIC_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const LAYOUT_KEYS = ['x', 'z', 'y', 'rotY', 'scale'] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function layoutError(layout: unknown): string | null {
  if (!isObject(layout)) return 'metadata.layout debe ser un objeto {x, z, y?, rotY?, scale?}';
  for (const key of Object.keys(layout)) {
    if (!(LAYOUT_KEYS as readonly string[]).includes(key)) {
      return `metadata.layout.${key} no es un campo válido (admitidos: ${LAYOUT_KEYS.join(', ')})`;
    }
  }
  const { maxCoord, maxRotY, minScale, maxScale } = LAYOUT_LIMITS;
  for (const key of ['x', 'z'] as const) {
    if (!isNumber(layout[key]) || Math.abs(layout[key]) > maxCoord) {
      return `metadata.layout.${key} es obligatorio y debe ser un número entre -${maxCoord} y ${maxCoord} (metros)`;
    }
  }
  const y = layout['y'];
  if (y !== undefined && (!isNumber(y) || Math.abs(y) > maxCoord)) {
    return `metadata.layout.y debe ser un número entre -${maxCoord} y ${maxCoord} (metros)`;
  }
  const rotY = layout['rotY'];
  if (rotY !== undefined && (!isNumber(rotY) || Math.abs(rotY) > maxRotY)) {
    return `metadata.layout.rotY debe ser un número entre -${maxRotY} y ${maxRotY} (grados)`;
  }
  const scale = layout['scale'];
  if (scale !== undefined && (!isNumber(scale) || scale < minScale || scale > maxScale)) {
    return `metadata.layout.scale debe ser un número entre ${minScale} y ${maxScale}`;
  }
  return null;
}

function connectsToError(list: unknown, selfId: string): string | null {
  if (!Array.isArray(list)) return 'metadata.connectsTo debe ser una lista de ids de activos';
  if (list.length > LAYOUT_LIMITS.maxConnections) {
    return `metadata.connectsTo admite como máximo ${LAYOUT_LIMITS.maxConnections} activos (recibidos ${list.length})`;
  }
  const seen = new Set<string>();
  for (const [i, id] of list.entries()) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return `metadata.connectsTo[${i}] debe ser un id de activo válido (^[a-z0-9][a-z0-9_-]{0,63}$)`;
    }
    if (id === selfId)
      return `metadata.connectsTo[${i}]: un activo no puede conectarse consigo mismo`;
    if (seen.has(id)) return `metadata.connectsTo[${i}]: "${id}" está repetido`;
    seen.add(id);
  }
  return null;
}

/** `capacityM3` / `contractedKw`: número finito > 0. */
function positiveError(key: string, v: unknown): string | null {
  return isNumber(v) && v > 0 ? null : `metadata.${key} debe ser un número finito mayor que 0`;
}

/** `scale: {[métrica]: {min, max}}` con min < max (rango de la barra de la web). */
function scaleError(scale: unknown): string | null {
  if (!isObject(scale)) return 'metadata.scale debe ser un objeto {métrica: {min, max}}';
  const metrics = Object.keys(scale);
  if (metrics.length > LAYOUT_LIMITS.maxScaleMetrics) {
    return `metadata.scale admite como máximo ${LAYOUT_LIMITS.maxScaleMetrics} métricas`;
  }
  for (const metric of metrics) {
    const range = scale[metric];
    if (!METRIC_KEY.test(metric)) return `metadata.scale: métrica "${metric}" inválida`;
    if (!isObject(range) || Object.keys(range).some((k) => k !== 'min' && k !== 'max')) {
      return `metadata.scale.${metric} debe ser {min, max}`;
    }
    if (!isNumber(range['min']) || !isNumber(range['max']) || range['min'] >= range['max']) {
      return `metadata.scale.${metric}: min y max deben ser números finitos con min < max`;
    }
  }
  return null;
}

/**
 * Valida las claves conocidas de `metadata` (el resto es libre). Devuelve el primer error en español o null.
 * `selfId` = id del activo, para impedir que se conecte consigo mismo.
 */
export function assetMetadataError(
  metadata: Record<string, unknown>,
  selfId: string,
): string | null {
  if (metadata['layout'] !== undefined) {
    const e = layoutError(metadata['layout']);
    if (e) return e;
  }
  for (const key of ['capacityM3', 'contractedKw'] as const) {
    if (metadata[key] !== undefined) {
      const e = positiveError(key, metadata[key]);
      if (e) return e;
    }
  }
  if (metadata['scale'] !== undefined) {
    const e = scaleError(metadata['scale']);
    if (e) return e;
  }
  if (metadata['connectsTo'] !== undefined) return connectsToError(metadata['connectsTo'], selfId);
  return null;
}

/** Ids de `connectsTo` (ya validado) que no están en `known`. */
export function unknownConnections(
  metadata: Record<string, unknown>,
  known: Set<string>,
): string[] {
  const list = metadata['connectsTo'];
  return Array.isArray(list) ? (list as string[]).filter((id) => !known.has(id)) : [];
}
