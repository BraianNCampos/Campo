import type { AnomalyLevel } from './anomaly';
import { ANOMALY_RANK } from './anomaly';

/**
 * Qué etiqueta 3D se ve y cómo (ISA-101: en la vista general sólo lo que importa). Puro y testeable.
 * - `name`: tag + nombre (+ valor / ficha holográfica si hay anomalía);
 * - `tag`: sólo el tag corto (o el nombre si el activo no tiene tag);
 * - `off`: oculta.
 * Prioridad: anomalía (magenta > roja > ámbar) > seleccionado / bajo el cursor > resto por cercanía. Las etiquetas que
 * se pisarían en pantalla se degradan (nombre → tag → oculta); una anomalía nunca desaparece del todo (como mínimo, tag).
 */
export type LabelMode = 'off' | 'tag' | 'name';

export interface Size {
  w: number;
  h: number;
}

export interface LabelCandidate {
  id: string;
  /** posición proyectada del ancla (px) */
  x: number;
  y: number;
  /** delante de la cámara y dentro (o casi) del lienzo */
  visible: boolean;
  /** distancia cámara → equipo */
  dist: number;
  decorative: boolean;
  anomaly: AnomalyLevel | null;
  /** seleccionado o bajo el cursor */
  focus: boolean;
  /** modo del tick anterior (histéresis: lo ya visible gana en los empates) */
  was: LabelMode;
  /** tamaño medido del rótulo en cada modo (px); si falta, se estima */
  size: (mode: 'tag' | 'name') => Size;
  /** desplazamiento vertical del rótulo respecto al ancla en ese modo (px; la ficha de anomalía sube) */
  dy: (mode: 'tag' | 'name') => number;
}

export interface LabelPlanOptions {
  /** muchos equipos: sólo se muestran tags al acercarse */
  crowded: boolean;
  /** distancia de la cámara del encuadre general (la que deja toda la planta en pantalla) */
  refDist: number;
  /** separación mínima entre rótulos (px) */
  pad?: number;
}

/** Plantas con más de este nº de equipos (no decorativos) se consideran «concurridas». */
export const CROWDED_ABOVE = 8;
/** Fracciones de la distancia de encuadre general: por debajo, tag / nombre (en plantas concurridas). */
export const TAG_WITHIN = 0.7;
export const NAME_WITHIN = 0.42;
/** Las estructuras decorativas sólo muestran su nombre muy de cerca. */
export const DECOR_WITHIN = 0.45;

function desired(c: LabelCandidate, o: LabelPlanOptions): LabelMode {
  if (!c.visible) return 'off';
  if (c.anomaly || c.focus) return 'name';
  const f = c.dist / Math.max(1e-6, o.refDist);
  if (c.decorative) return f < DECOR_WITHIN ? 'name' : 'off';
  if (!o.crowded) return 'name';
  return f < NAME_WITHIN ? 'name' : f < TAG_WITHIN ? 'tag' : 'off';
}

const priority = (c: LabelCandidate): number => (c.anomaly ? 100 + ANOMALY_RANK[c.anomaly] * 10 : 0) + (c.focus ? 50 : 0) + (c.decorative ? -10 : 0);

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Rect, b: Rect, pad: number): boolean => a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 + pad && a.y1 + pad > b.y0;

/** Modo de cada etiqueta (por id). */
export function planLabels(cands: readonly LabelCandidate[], opts: LabelPlanOptions): Map<string, LabelMode> {
  const pad = opts.pad ?? 4;
  const out = new Map<string, LabelMode>();
  const order = [...cands].sort(
    (a, b) => priority(b) - priority(a) || (b.was !== 'off' ? 1 : 0) - (a.was !== 'off' ? 1 : 0) || a.dist - b.dist || a.id.localeCompare(b.id),
  );
  const placed: Rect[] = [];
  const rectOf = (c: LabelCandidate, m: 'tag' | 'name'): Rect => {
    const s = c.size(m);
    const cy = c.y + c.dy(m);
    return { x0: c.x - s.w / 2, x1: c.x + s.w / 2, y0: cy - s.h / 2, y1: cy + s.h / 2 };
  };
  for (const c of order) {
    const want = desired(c, opts);
    if (want === 'off') {
      out.set(c.id, 'off');
      continue;
    }
    const forced = !!c.anomaly || c.focus;
    const tries: ('name' | 'tag')[] = want === 'name' ? ['name', 'tag'] : ['tag'];
    let chosen: LabelMode = 'off';
    for (const m of tries) {
      const r = rectOf(c, m);
      if (!placed.some((p) => overlaps(r, p, pad))) {
        chosen = m;
        placed.push(r);
        break;
      }
    }
    if (chosen === 'off' && forced) {
      chosen = 'tag'; // una anomalía o el equipo en foco nunca se oculta del todo
      placed.push(rectOf(c, 'tag'));
    }
    out.set(c.id, chosen);
  }
  return out;
}
