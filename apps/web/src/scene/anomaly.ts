import type { AlarmKind, AssetDef, AssetState, Limit, Severity } from '@campo/shared';
import { isActiveCondition, lifecycleOf, type LiveAlarm } from '@/lib/alarm-lifecycle';
import { formatMetric, metricMeta } from '@/lib/metrics';
import { beyondLimit, isNearLimit, limitsByMetric, setpointOf } from '@/lib/modules/status';
import { resolveScale } from '@/lib/modules/scale';

/**
 * Anomalías sobre el modelo 3D (ISA-101, docs/architecture.md §13). Funciones puras (sin React ni WebGL):
 * - `attention` (ámbar): alarma de prioridad media, normalizada sin reconocer, o valor cerca del límite (regla del 90 %);
 * - `critical` (rojo): alarma crítica activa;
 * - `stale` (magenta): alarma sin reconocer desde hace más de 5 min (escalada; gana sobre las otras).
 */
export type AnomalyLevel = 'attention' | 'critical' | 'stale';

export const ANOMALY_HEX: Record<AnomalyLevel, string> = { attention: '#ffb020', critical: '#ff3b30', stale: '#ff2bd6' };
export const ANOMALY_LABEL: Record<AnomalyLevel, string> = { attention: 'Atención', critical: 'Alarma crítica', stale: 'Sin reconocer +5 min' };
/** Prioridad (mayor = más urgente) para repartir las luces puntuales. */
export const ANOMALY_RANK: Record<AnomalyLevel, number> = { attention: 1, critical: 2, stale: 3 };
export const STALE_UNACKED_MS = 5 * 60_000;

/** Lo que no depende del reloj: se recalcula sólo cuando cambian el estado, las alarmas o los límites. */
export interface AnomalyBase {
  /** peor condición activa o normalizada sin reconocer */
  severity: Severity | null;
  /** alarma crítica activa (condición presente) */
  activeCritical: boolean;
  /** alarma activa de prioridad media (condición presente) */
  activeWarning: boolean;
  /** ts de la alarma sin reconocer más antigua (activa o normalizada); null si no hay */
  unackedSince: number | null;
  /** cerca (o pasado) del límite sin alarma todavía */
  near: boolean;
  metric: string;
  limit: number | null;
  kind?: AlarmKind;
  /** valor de la alarma (por si no hay telemetría) */
  alarmValue: number | null;
}

export interface Anomaly extends AnomalyBase {
  level: AnomalyLevel;
}

export interface AnomalyInput {
  state: AssetState | undefined;
  /** alarmas del activo (el resto se ignora) */
  alarms: readonly LiveAlarm[];
  limits: readonly Limit[];
  def: Pick<AssetDef, 'metadata' | 'type'> | undefined;
  primaryMetric?: string;
}

/** Parte estática de la anomalía de un activo; `null` si está en rango y sin alarmas. */
export function anomalyBase(i: AnomalyInput): AnomalyBase | null {
  let primary: LiveAlarm | undefined;
  let severity: Severity | null = null;
  let activeCritical = false;
  let activeWarning = false;
  let unackedSince: number | null = null;
  for (const a of i.alarms) {
    const l = lifecycleOf(a);
    if (l !== 'unacked' && l !== 'acked' && l !== 'rtn_unacked') continue;
    if (isActiveCondition(a)) {
      if (a.severity === 'critical') activeCritical = true;
      else activeWarning = true;
    }
    if (l === 'unacked' || l === 'rtn_unacked') unackedSince = unackedSince === null ? a.ts : Math.min(unackedSince, a.ts);
    // la alarma que se muestra: crítica antes que media, condición presente antes que normalizada, sin reconocer antes que reconocida
    const score = (x: LiveAlarm) => (x.severity === 'critical' ? 4 : 0) + (isActiveCondition(x) ? 2 : 0) + (lifecycleOf(x) === 'acked' ? 0 : 1);
    if (!primary || score(a) > score(primary) || (score(a) === score(primary) && a.ts > primary.ts)) primary = a;
    severity = severity === 'critical' || a.severity === 'critical' ? 'critical' : 'warning';
  }
  if (primary) {
    return {
      severity, activeCritical, activeWarning, unackedSince, near: false,
      metric: primary.metric, limit: Number.isFinite(primary.threshold) ? primary.threshold : null, kind: primary.kind, alarmValue: Number.isFinite(primary.value) ? primary.value : null,
    };
  }
  // sin alarma: ¿cerca del límite? (mismas reglas que la tarjeta del módulo: cerca = ≥ 90 % del camino setpoint → límite)
  const st = i.state;
  if (!st || st.quality === 'bad' || i.limits.length === 0) return null;
  for (const [metric, ls] of Object.entries(limitsByMetric(i.limits))) {
    const v = st.values[metric];
    if (v === undefined) continue;
    const crossed = ls.find((l) => beyondLimit(v, l));
    const near = crossed ?? (isNearLimit(v, ls, resolveScale(i.def, metric, ls), setpointOf(i.def, st.values, metric)) ? nearest(ls, v) : undefined);
    if (near) {
      return { severity: null, activeCritical: false, activeWarning: false, unackedSince: null, near: true, metric, limit: near.threshold, kind: near.kind, alarmValue: null };
    }
  }
  return null;
}

const nearest = <T extends Pick<Limit, 'threshold'>>(ls: readonly T[], v: number): T | undefined =>
  [...ls].sort((a, b) => Math.abs(a.threshold - v) - Math.abs(b.threshold - v))[0];

/** Nivel visible en el instante `now` (el paso a magenta depende del reloj). `null` = sin anomalía. */
export function anomalyAt(base: AnomalyBase | null, now: number): Anomaly | null {
  if (!base) return null;
  const level: AnomalyLevel =
    base.unackedSince !== null && now - base.unackedSince > STALE_UNACKED_MS ? 'stale' : base.activeCritical ? 'critical' : 'attention';
  return { ...base, level };
}

export interface AnomalyText {
  /** primera línea: tag · tipo de alarma (HH, HI…) */
  head: string;
  /** valor actual con unidad */
  value: string;
  /** límite con unidad, o '' si se desconoce */
  limit: string;
  /** texto compuesto para el rótulo: «TNK-101 · HH — 94,2 % · límite 90 %» */
  line: string;
}

/** Texto del marcador holográfico: tag, valor y límite (§13). El valor sale de la telemetría viva y, si falta, de la alarma. */
export function anomalyText(a: Pick<Anomaly, 'metric' | 'limit' | 'kind' | 'alarmValue'>, values: Record<string, number> | undefined, tag: string | null | undefined, name: string): AnomalyText {
  const live = values?.[a.metric];
  const v = live ?? a.alarmValue ?? undefined;
  const meta = metricMeta(a.metric);
  const head = `${tag || name}${a.kind ? ` · ${a.kind}` : ''}`;
  const value = `${meta.label} ${formatMetric(a.metric, v)}`;
  const limit = a.limit !== null ? `límite ${formatMetric(a.metric, a.limit)}` : '';
  return { head, value, limit, line: `${head} — ${value}${limit ? ` · ${limit}` : ''}` };
}

/** Grosor del contorno en píxeles: más grueso con contraste alto; pico de brillo si se pulsa. */
export function outlineWidthPx(level: AnomalyLevel, highContrast: boolean): number {
  const base = level === 'attention' ? 2 : 2.5;
  return highContrast ? base + 2.5 : base;
}

/** Pulso 0..1 (1 = brillo pleno); sin movimiento (`prefers-reduced-motion`) es constante. */
export function pulseAt(t: number, still: boolean, level: AnomalyLevel): number {
  if (still) return 1;
  const hz = level === 'attention' ? 0.8 : level === 'critical' ? 1.6 : 2.4;
  return 0.78 + 0.22 * Math.sin(t * Math.PI * 2 * hz);
}
