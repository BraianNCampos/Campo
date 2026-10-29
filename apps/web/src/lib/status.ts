import type { AssetState, Severity } from '@campo/shared';

export type AssetStatus = 'ok' | 'warning' | 'critical' | 'uncertain' | 'bad';

export interface StatusMeta {
  label: string;
  /** clases Tailwind (texto, fondo suave, borde) */
  text: string;
  soft: string;
  border: string;
  /** hex para la escena 3D */
  hex: string;
}

export const STATUS_META: Record<AssetStatus, StatusMeta> = {
  ok: { label: 'Normal', text: 'text-ok', soft: 'bg-ok/15', border: 'border-ok/60', hex: '#38bdf8' },
  warning: { label: 'Advertencia', text: 'text-warn', soft: 'bg-warn/15', border: 'border-warn/70', hex: '#fbbf24' },
  critical: { label: 'Crítica', text: 'text-crit', soft: 'bg-crit/15', border: 'border-crit/80', hex: '#ff4d4d' },
  uncertain: { label: 'Dato dudoso', text: 'text-warn', soft: 'bg-warn/15', border: 'border-warn/70', hex: '#c9a227' },
  bad: { label: 'Sin señal', text: 'text-bad', soft: 'bg-bad/15', border: 'border-bad/60', hex: '#6b7a8c' },
};

/** Estado de un activo: alarma activa > calidad del dato > normal. */
export function assetStatus(state: AssetState | undefined, alarmSeverity?: Severity): AssetStatus {
  if (!state || state.quality === 'bad') return 'bad';
  if (alarmSeverity === 'critical') return 'critical';
  if (alarmSeverity === 'warning') return 'warning';
  if (state.quality === 'uncertain') return 'uncertain';
  return 'ok';
}

export const SEVERITY_RANK: Record<Severity, number> = { warning: 1, critical: 2 };

export function maxSeverity(a: Severity | undefined, b: Severity): Severity {
  return a && SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
