import type { Limit } from '@campo/shared';
import { compileAssetPattern } from '../alarms/alarm-evaluator';
import { AlarmRule, isLimitKind, resolveRule } from '../alarms/alarm.types';

/**
 * Límites de alarma visibles de una planta: cada regla ACTIVA se expande (patrón con `*`) a los activos que
 * existen hoy en el catálogo. Sólo cuentan las reglas de límite fijo (HH/HI/LO/LL): DEV y ROC no son un límite
 * (dependen del setpoint o de la velocidad) y se omiten. Resultado sin duplicados y en orden estable (activo, métrica, umbral, operador,
 * severidad), para que la web pueda compararlo sin sorpresas. Un id exacto que no existe no genera límite.
 */
export function resolveLimits(rules: AlarmRule[], assetIds: string[]): Limit[] {
  const out = new Map<string, Limit>();
  for (const raw of rules) {
    if (!raw.enabled) continue;
    const rule = resolveRule(raw);
    if (!isLimitKind(rule.kind)) continue;
    const re = compileAssetPattern(rule.asset);
    for (const asset of assetIds) {
      if (!re.test(asset)) continue;
      const limit: Limit = {
        asset,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
        kind: rule.kind,
      };
      out.set(
        JSON.stringify([
          asset,
          rule.metric,
          rule.operator,
          rule.threshold,
          rule.severity,
          rule.kind,
        ]),
        limit,
      );
    }
  }
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort(
    (a, b) =>
      cmp(a.asset, b.asset) ||
      cmp(a.metric, b.metric) ||
      cmp(a.threshold, b.threshold) ||
      cmp(a.operator, b.operator) ||
      cmp(a.severity, b.severity) ||
      cmp(a.kind ?? '', b.kind ?? ''),
  );
}
