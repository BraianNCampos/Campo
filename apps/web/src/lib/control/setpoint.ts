import type { AssetDef } from '@campo/shared';
import type { Scale } from '@/lib/modules/scale';
import { parseNum } from '@/lib/admin/validation';

/** Validación del ajuste de setpoint (`PUT .../setpoints/:metric`): número dentro de la escala de la métrica (§14.2). */
export function validateSetpoint(raw: string, scale: Scale | undefined, current?: number, decimals = 1): { error?: string; value?: number } {
  const n = parseNum(raw);
  if (n === undefined) return { error: 'Ingresá el valor del setpoint.' };
  if (!Number.isFinite(n)) return { error: 'Ingresá un número.' };
  const fmt = (v: number) => String(v).replace('.', ',');
  if (scale && (n < scale.min || n > scale.max)) return { error: `Tiene que estar dentro de la escala de la métrica (de ${fmt(scale.min)} a ${fmt(scale.max)}).` };
  const v = Math.round(n * 10 ** decimals) / 10 ** decimals;
  if (current !== undefined && Math.abs(v - current) < 1e-9) return { error: 'Es el mismo valor que ya está configurado.' };
  return { value: v };
}

/** Copia del catálogo con el setpoint de la métrica actualizado (actualización optimista tras guardar). */
export function withSetpoint(def: AssetDef, metric: string, value: number): AssetDef {
  const prev = (def.metadata as { setpoints?: Record<string, number> }).setpoints ?? {};
  return { ...def, metadata: { ...def.metadata, setpoints: { ...prev, [metric]: value } } };
}
