import { useEffect, useRef } from 'react';
import type { AssetState, Severity } from '@campo/shared';
import { useLiveStore, type LiveStore } from '@/store/live-store';

export interface AssetTarget {
  state?: AssetState;
  severity?: Severity;
}

/**
 * Valor objetivo de un activo para la escena 3D. Se actualiza con
 * `useLiveStore.subscribe` (transitorio): NO provoca re-render de React.
 * `useFrame` lee `ref.current` e interpola hacia él.
 */
export function useAssetTarget(id: string) {
  const ref = useRef<AssetTarget>({});
  useEffect(() => {
    const read = (s: LiveStore) => {
      const state = s.assets[id];
      const severity = s.alarmSeverityByAsset[id];
      if (ref.current.state !== state || ref.current.severity !== severity) ref.current = { state, severity };
    };
    read(useLiveStore.getState());
    return useLiveStore.subscribe(read);
  }, [id]);
  return ref;
}
