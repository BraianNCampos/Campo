'use client';

import { assetLabel, resolveKind } from '@/lib/assets';
import { isUncataloged } from '@/lib/catalog';
import { assetStatus } from '@/lib/status';
import { useLiveStore } from '@/store/live-store';

/** Nombre a mostrar: el del catálogo; sin catálogo, deducido del id (tk-01 → "Tanque 01"). */
export function useAssetName(id: string): string {
  return useLiveStore((s) => s.catalog[id]?.name ?? assetLabel(id));
}

export function useAsset(id: string) {
  const state = useLiveStore((s) => s.assets[id]);
  const severity = useLiveStore((s) => s.alarmSeverityByAsset[id]);
  const def = useLiveStore((s) => s.catalog[id]);
  const uncataloged = useLiveStore((s) => isUncataloged(id, s.catalog, s.catalogReady));
  return {
    state,
    def,
    name: def?.name ?? assetLabel(id),
    kind: resolveKind(id, state?.values, def?.type),
    status: assetStatus(state, severity),
    /** envía telemetría pero no figura en el catálogo */
    uncataloged,
  };
}
