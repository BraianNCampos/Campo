import type { Limit } from '@campo/shared';
import { compileAssetPattern } from '../alarms/alarm-evaluator';
import type { AlarmRule } from '../alarms/alarm.types';

/**
 * Límites de alarma visibles de una planta: cada regla ACTIVA se expande (patrón con `*`) a los activos que
 * existen hoy en el catálogo. Resultado sin duplicados y en orden estable (activo, métrica, umbral, operador,
 * severidad), para que la web pueda compararlo sin sorpresas. Un id exacto que no existe no genera límite.
 */
export function resolveLimits(rules: AlarmRule[], assetIds: string[]): Limit[] {
  const out = new Map<string, Limit>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const re = compileAssetPattern(rule.asset);
    for (const asset of assetIds) {
      if (!re.test(asset)) continue;
      const limit: Limit = {
        asset,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
      };
      out.set(JSON.stringify([asset, rule.metric, rule.operator, rule.threshold, rule.severity]), limit);
    }
  }
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort(
    (a, b) =>
      cmp(a.asset, b.asset) ||
      cmp(a.metric, b.metric) ||
      cmp(a.threshold, b.threshold) ||
      cmp(a.operator, b.operator) ||
      cmp(a.severity, b.severity),
  );
}
