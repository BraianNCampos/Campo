import type { AlarmKpis } from '@campo/shared';

/** Lógica pura de la pantalla de salud de alarmas (EEMUA 191 / ISA-18.2). */

export type HealthState = 'ok' | 'warning' | 'critical';

/** Mismo criterio que la API: ok si cumple la política; warning hasta 1,5×; critical por encima. */
export function meterState(value: number, limit: number): HealthState {
  if (!(limit > 0)) return 'ok';
  const r = value / limit;
  return r <= 1 ? 'ok' : r <= 1.5 ? 'warning' : 'critical';
}

/** Posición (0–1) del valor y del umbral en un medidor cuya escala llega a 1,5× el umbral. */
export function meterPositions(value: number, limit: number): { fill: number; mark: number } {
  const max = limit * 1.5;
  if (!(max > 0)) return { fill: 0, mark: 0 };
  return { fill: Math.min(1, Math.max(0, value / max)), mark: limit / max };
}

export const STATE_LABEL: Record<HealthState, string> = { ok: 'Dentro de lo recomendado', warning: 'Cerca de pasarse', critical: 'Por encima de lo recomendado' };

export const STATE_EXPLAIN: Record<HealthState, string> = {
  ok: 'La cantidad de alarmas es manejable para quien opera la planta.',
  warning: 'Hay más alarmas de las recomendadas: conviene revisar las que más se repiten.',
  critical: 'Son demasiadas alarmas para atenderlas bien: se corre el riesgo de ignorar una importante.',
};

export const WINDOW_LABEL: Record<AlarmKpis['window'], string> = { '24h': 'Últimas 24 h', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días' };
export const WINDOW_SHORT: Record<AlarmKpis['window'], string> = { '24h': '24 h', '7d': '7 días', '30d': '30 días' };

/** Cuántas veces más (o menos) que el límite, para el texto del medidor. */
export function ratioText(value: number, limit: number): string {
  if (!(limit > 0)) return '';
  const r = value / limit;
  if (r <= 1) return `${Math.round(r * 100)} % del máximo recomendado`;
  return `${r.toFixed(1).replace('.', ',')} veces el máximo recomendado`;
}

/** Proporciones (0–1) para la barra de prioridades; con total 0, todo en cero. */
export function priorityShare(p: AlarmKpis['byPriority']): { critical: number; warning: number } {
  const t = p.critical + p.warning;
  return t === 0 ? { critical: 0, warning: 0 } : { critical: p.critical / t, warning: p.warning / t };
}

export function formatPerDay(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',').replace(/,0$/, '');
}

/** Duración corta: «27 h», «2 d 3 h». */
export function sinceText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
