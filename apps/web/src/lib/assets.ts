import type { AssetState } from '@campo/shared';

export type AssetKind = 'tank' | 'pump' | 'valve' | 'other';

const KIND_ORDER: Record<AssetKind, number> = { tank: 0, pump: 1, valve: 2, other: 3 };

export function assetKind(id: string, values?: Record<string, number>): AssetKind {
  if (/^(tk|tank|tanque)/i.test(id)) return 'tank';
  if (/^(pump|pmp|bomba)/i.test(id)) return 'pump';
  if (/^(valve|vlv|valvula)/i.test(id)) return 'valve';
  if (values) {
    if ('level' in values) return 'tank';
    if ('rpm' in values) return 'pump';
    if ('position' in values) return 'valve';
  }
  return 'other';
}

const KIND_LABEL: Record<AssetKind, string> = {
  tank: 'Tanque',
  pump: 'Bomba',
  valve: 'Válvula',
  other: 'Equipo',
};

export const kindLabel = (k: AssetKind) => KIND_LABEL[k];

/** tk-01 → "Tanque 01"; ids desconocidos se devuelven tal cual. */
export function assetLabel(id: string): string {
  const kind = assetKind(id);
  const m = /(\d+)$/.exec(id);
  return kind === 'other' || !m ? id : `${KIND_LABEL[kind]} ${m[1]}`;
}

/** Métrica principal por tipo de equipo. */
export function primaryMetric(kind: AssetKind): string {
  return kind === 'tank' ? 'level' : kind === 'pump' ? 'rpm' : kind === 'valve' ? 'position' : 'value';
}

/** Orden estable: tanques, bombas, válvulas, otros; luego natural por id. */
export function sortAssetIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const d = KIND_ORDER[assetKind(a)] - KIND_ORDER[assetKind(b)];
    return d !== 0 ? d : a.localeCompare(b, 'en', { numeric: true });
  });
}

export const RUNNING_RPM = 50;
export const pumpRunning = (values: Record<string, number> | undefined): boolean =>
  (values?.rpm ?? 0) > RUNNING_RPM;

export function primaryValue(id: string, state: AssetState | undefined): number | undefined {
  if (!state) return undefined;
  const key = primaryMetric(assetKind(id, state.values));
  return state.values[key] ?? Object.values(state.values)[0];
}
