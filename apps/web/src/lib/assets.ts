import { ASSET_KINDS } from '@campo/shared';
import type { AssetState, AssetType } from '@campo/shared';

export type AssetKind = AssetType | 'other';

const KIND_ORDER: Record<AssetKind, number> = {
  tank: 0, silo: 1, pump: 2, valve: 3, climate: 4, energy: 5, gas: 6, machine: 7, conveyor: 8, pressure: 9, flow: 10, sensor: 11, structure: 12, other: 13,
};

/** Tanques y silos se tratan igual: nivel, capacidad, llenado (docs §13-14). */
export const isTankLike = (k: AssetKind | undefined): k is 'tank' | 'silo' => k === 'tank' || k === 'silo';
/** Máquinas y cintas transportadoras: estado en marcha / detenida. */
export const isMachineLike = (k: AssetKind | undefined): k is 'machine' | 'conveyor' => k === 'machine' || k === 'conveyor';
/** Las estructuras son decorativas: sin telemetría ni métrica. */
export const isStructure = (k: AssetKind | undefined): boolean => k === 'structure';

export function assetKind(id: string, values?: Record<string, number>): AssetKind {
  if (/^(silo)/i.test(id)) return 'silo';
  if (/^(conv|cinta)/i.test(id)) return 'conveyor';
  if (/^(nave|struct|estructura)/i.test(id)) return 'structure';
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
  silo: 'Silo',
  conveyor: 'Cinta transportadora',
  structure: 'Estructura',
  pump: 'Bomba',
  valve: 'Válvula',
  sensor: 'Sensor',
  climate: 'Sensor de clima',
  energy: 'Medidor de energía',
  gas: 'Medidor de gas',
  machine: 'Máquina',
  pressure: 'Sensor de presión',
  flow: 'Caudalímetro',
  other: 'Equipo',
};
const KIND_PLURAL: Record<AssetKind, string> = {
  tank: 'Tanques',
  silo: 'Silos',
  conveyor: 'Cintas transportadoras',
  structure: 'Estructuras',
  pump: 'Bombas',
  valve: 'Válvulas',
  sensor: 'Sensores',
  climate: 'Sensores de clima',
  energy: 'Medidores de energía',
  gas: 'Medidores de gas',
  machine: 'Máquinas',
  pressure: 'Sensores de presión',
  flow: 'Caudalímetros',
  other: 'Equipos',
};

export const kindLabel = (k: AssetKind) => KIND_LABEL[k];
export const kindPlural = (k: AssetKind) => KIND_PLURAL[k];

/** Tipo efectivo: el del catálogo manda; sin catálogo se deduce del id y de las métricas. */
export function resolveKind(id: string, values?: Record<string, number>, type?: AssetType): AssetKind {
  return type ?? assetKind(id, values);
}

/** tk-01 → "Tanque 01"; ids desconocidos se devuelven tal cual. */
export function assetLabel(id: string): string {
  const kind = assetKind(id);
  const m = /(\d+)$/.exec(id);
  return kind === 'other' || !m ? id : `${KIND_LABEL[kind]} ${m[1]}`;
}

/** Métrica principal por tipo de equipo. */
export function primaryMetric(kind: AssetKind): string {
  return kind === 'other' ? 'value' : ASSET_KINDS[kind].primaryMetric;
}

/** Orden estable: tanques, bombas, válvulas, sensores, otros; luego natural por id. `typeOf` aporta el tipo del catálogo. */
export function sortAssetIds(ids: string[], typeOf?: (id: string) => AssetType | undefined): string[] {
  const kind = (id: string) => resolveKind(id, undefined, typeOf?.(id));
  return [...ids].sort((a, b) => {
    const d = KIND_ORDER[kind(a)] - KIND_ORDER[kind(b)];
    return d !== 0 ? d : a.localeCompare(b, 'en', { numeric: true });
  });
}

export const RUNNING_RPM = 50;
export const pumpRunning = (values: Record<string, number> | undefined): boolean =>
  (values?.rpm ?? 0) > RUNNING_RPM;

export function primaryValue(id: string, state: AssetState | undefined, type?: AssetType): number | undefined {
  if (!state) return undefined;
  const key = primaryMetric(resolveKind(id, state.values, type));
  return state.values[key] ?? Object.values(state.values)[0];
}
