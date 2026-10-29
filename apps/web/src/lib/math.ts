export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Suavizado exponencial independiente del framerate: acerca `current` a `target`.
 * `lambda` ≈ 1/τ (s⁻¹). Con dt grande converge sin sobrepasar.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * Math.max(0, dt)));
}

/** Formato con decimales fijos; NaN/Infinity → '—'. */
export function formatNumber(v: number | undefined | null, decimals = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}

/** "hace 5 s", "hace 3 min", "hace 2 h" */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  return `hace ${Math.floor(s / 3600)} h`;
}
