import { METRICS, type AssetDef, type Limit } from '@campo/shared';

export interface Scale {
  min: number;
  max: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `metadata.scale[metric]` válido (`min < max`) o `undefined`. */
export function metadataScale(metadata: unknown, metric: string): Scale | undefined {
  const all = isObj(metadata) ? metadata.scale : undefined;
  const s = isObj(all) ? all[metric] : undefined;
  return isObj(s) && fin(s.min) && fin(s.max) && s.min < s.max ? { min: s.min, max: s.max } : undefined;
}

/**
 * Escala de la barra de una métrica:
 * 1. `metadata.scale[metric]`, tal cual (la fija quien administra el activo);
 * 2. si no, la de `METRICS`, ampliada para que quepan la potencia contratada (energía) y los umbrales de los límites
 *    (con un 10 % de margen), de modo que las marcas nunca queden fuera de la barra;
 * 3. métrica desconocida: `undefined` (no se puede dibujar una escala).
 */
export function resolveScale(
  def: Pick<AssetDef, 'metadata'> | undefined,
  metric: string,
  limits: readonly Pick<Limit, 'threshold'>[] = [],
): Scale | undefined {
  const own = metadataScale(def?.metadata, metric);
  if (own) return own;
  const base = METRICS[metric]?.scale;
  if (!base) return undefined;
  let { min, max } = base;
  const contracted = isObj(def?.metadata) ? def.metadata.contractedKw : undefined;
  const top = [...limits.map((l) => l.threshold), ...(metric === 'kw' && fin(contracted) && contracted > 0 ? [contracted] : [])];
  for (const t of top) {
    if (t > max) max = Math.ceil((t * 1.1) / 10) * 10;
    if (t < min) min = Math.floor((t - Math.abs(t) * 0.1) / 10) * 10;
  }
  return { min, max };
}

/** Posición (0–100 %) de un valor en la escala, acotada. */
export function scalePct(value: number, scale: Scale): number {
  return Math.min(100, Math.max(0, ((value - scale.min) / (scale.max - scale.min)) * 100));
}
