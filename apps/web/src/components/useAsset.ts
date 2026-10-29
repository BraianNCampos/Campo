'use client';

import { assetKind } from '@/lib/assets';
import { assetStatus } from '@/lib/status';
import { useLiveStore } from '@/store/live-store';

export function useAsset(id: string) {
  const state = useLiveStore((s) => s.assets[id]);
  const severity = useLiveStore((s) => s.alarmSeverityByAsset[id]);
  return {
    state,
    kind: assetKind(id, state?.values),
    status: assetStatus(state, severity),
  };
}
