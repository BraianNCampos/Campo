import { moduleForAssetType, type AssetDef, type AssetState, type Limit, type ModuleId, type Severity } from '@campo/shared';
import { sortAssetIds } from '../assets';
import { cardStatus, needsAttention, type CardStatus } from './status';

/** Lo que hace falta del estado vivo para resumir un módulo (todo ya presente en `useLiveStore`). */
export interface LiveSnapshot {
  catalog: Record<string, AssetDef>;
  catalogReady: boolean;
  assets: Record<string, AssetState>;
  alarmSeverityByAsset: Record<string, Severity>;
  limitsByAsset: Record<string, Limit[]>;
}

export interface ModuleItem {
  id: string;
  def: AssetDef;
  state: AssetState | undefined;
  status: CardStatus;
}

/** Activos del catálogo que pertenecen al módulo, ordenados por tipo y luego id. */
export function moduleAssetIds(module: ModuleId, catalog: Record<string, AssetDef>): string[] {
  const ids = Object.keys(catalog).filter((id) => moduleForAssetType(catalog[id]!.type) === module);
  return sortAssetIds(ids, (id) => catalog[id]?.type);
}

export function moduleItems(module: ModuleId, s: LiveSnapshot): ModuleItem[] {
  return moduleAssetIds(module, s.catalog).map((id) => {
    const def = s.catalog[id]!;
    const state = s.assets[id];
    return {
      id,
      def,
      state,
      status: cardStatus({ def, catalogReady: s.catalogReady, state, alarmSeverity: s.alarmSeverityByAsset[id], limits: s.limitsByAsset[id] ?? [] }),
    };
  });
}

export interface Counts {
  all: number;
  attention: number;
  alarm: number;
  near: number;
  nodata: number;
}

export function countItems(items: readonly Pick<ModuleItem, 'status'>[]): Counts {
  const c: Counts = { all: items.length, attention: 0, alarm: 0, near: 0, nodata: 0 };
  for (const i of items) {
    if (needsAttention(i.status)) c.attention++;
    if (i.status === 'alarm') c.alarm++;
    if (i.status === 'near') c.near++;
    if (i.status === 'nodata') c.nodata++;
  }
  return c;
}

/** Contadores de atención de cada módulo (insignias de la navegación). `crit`: alguna alarma crítica en el módulo. */
export interface ModuleBadge {
  attention: number;
  alarm: number;
  critical: boolean;
}

export function moduleBadges(modules: readonly ModuleId[], s: LiveSnapshot): Record<string, ModuleBadge> {
  const out: Record<string, ModuleBadge> = {};
  for (const m of modules) {
    const items = moduleItems(m, s);
    const c = countItems(items);
    out[m] = { attention: c.attention, alarm: c.alarm, critical: items.some((i) => s.alarmSeverityByAsset[i.id] === 'critical') };
  }
  return out;
}

export function sameBadges(a: Record<string, ModuleBadge>, b: Record<string, ModuleBadge>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => {
    const x = a[k], y = b[k];
    return !!x && !!y && x.attention === y.attention && x.alarm === y.alarm && x.critical === y.critical;
  });
}
