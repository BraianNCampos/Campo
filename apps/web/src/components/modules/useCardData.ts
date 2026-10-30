'use client';

import { useMemo } from 'react';
import { ASSET_KINDS, METRICS, type AssetDef, type AssetState, type Limit, type Severity } from '@campo/shared';
import { resolveScale, type Scale } from '@/lib/modules/scale';
import { cardStatus, type CardStatus } from '@/lib/modules/status';
import { assetLabel } from '@/lib/assets';
import { useLiveStore } from '@/store/live-store';

const NO_LIMITS: Limit[] = [];

export interface CardData {
  id: string;
  def: AssetDef | undefined;
  name: string;
  state: AssetState | undefined;
  status: CardStatus;
  severity: Severity | undefined;
  metric: string;
  scale: Scale | undefined;
  /** límites de la métrica primaria */
  limits: Limit[];
  value: number | undefined;
  unit: string;
  decimals: number;
}

/** Datos de una tarjeta con selectores finos: sólo se re-renderiza cuando cambia ESTE activo. */
export function useCardData(id: string): CardData {
  const def = useLiveStore((s) => s.catalog[id]);
  const state = useLiveStore((s) => s.assets[id]);
  const severity = useLiveStore((s) => s.alarmSeverityByAsset[id]);
  const all = useLiveStore((s) => s.limitsByAsset[id]) ?? NO_LIMITS;
  const catalogReady = useLiveStore((s) => s.catalogReady);
  return useMemo(() => {
    const metric = def ? ASSET_KINDS[def.type].primaryMetric : 'value';
    const limits = all.filter((l) => l.metric === metric);
    const m = METRICS[metric];
    return {
      id,
      def,
      name: def?.name ?? assetLabel(id),
      state,
      severity,
      status: cardStatus({ def, catalogReady, state, alarmSeverity: severity, limits: all }),
      metric,
      scale: resolveScale(def, metric, limits),
      limits,
      value: state?.values[metric],
      unit: m?.unit ?? '',
      decimals: m?.decimals ?? 1,
    };
  }, [id, def, state, severity, all, catalogReady]);
}
