import type { AssetDef } from '@campo/shared';
import { compileAssetPattern } from './alarm-evaluator';
import type { ResolvedRule } from './alarm.types';

/** `ok`: se evalúa; `disabled`: fuera de servicio; `no_setpoint`: regla DEV sin ningún setpoint disponible. */
export type RuleStatus = 'ok' | 'disabled' | 'no_setpoint';

export interface RuleHealth {
  evaluable: boolean;
  status: RuleStatus;
  /** DEV: activos del catálogo cubiertos por la regla que todavía no tienen setpoint (esos no se evalúan). */
  assetsWithoutSetpoint?: string[];
}

/** Setpoint de `metadata.setpoints[metric]` de un activo, si es un número finito. */
export function metadataSetpoint(
  asset: Pick<AssetDef, 'metadata'>,
  metric: string,
): number | undefined {
  const sp = asset.metadata?.['setpoints'];
  if (typeof sp !== 'object' || sp === null || Array.isArray(sp)) return undefined;
  const v = (sp as Record<string, unknown>)[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Estado de una regla (§12.1: "sin SP la regla DEV no se evalúa y el estado de la regla lo informa").
 * `liveSetpoint(asset)` = setpoint recibido por telemetría (`<métrica>_sp`), que manda sobre el del catálogo.
 */
export function ruleHealth(
  rule: ResolvedRule,
  assets: Pick<AssetDef, 'id' | 'metadata'>[],
  liveSetpoint: (asset: string) => number | undefined = () => undefined,
): RuleHealth {
  if (!rule.enabled) return { evaluable: false, status: 'disabled' };
  if (rule.kind !== 'DEV') return { evaluable: true, status: 'ok' };
  const re = compileAssetPattern(rule.asset);
  const covered = assets.filter((a) => re.test(a.id));
  const without = covered
    .filter((a) => (liveSetpoint(a.id) ?? metadataSetpoint(a, rule.metric)) === undefined)
    .map((a) => a.id);
  // Un id exacto que aún no está en el catálogo sólo puede evaluarse con SP por telemetría.
  const liveOnly =
    !rule.asset.includes('*') && covered.length === 0 && liveSetpoint(rule.asset) !== undefined;
  const evaluable = liveOnly || covered.length > without.length;
  return {
    evaluable,
    status: evaluable ? 'ok' : 'no_setpoint',
    ...(without.length > 0 ? { assetsWithoutSetpoint: without } : {}),
  };
}
