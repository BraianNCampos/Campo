import { useEffect, useRef } from 'react';
import type { AssetState, Severity } from '@campo/shared';
import { useSceneData, type SceneSnapshot } from './scene-data';

export interface AssetTarget {
  state?: AssetState;
  severity?: Severity;
}

/**
 * Valor objetivo de un activo para la escena 3D. Se actualiza con la suscripción transitoria de la
 * fuente de datos (`SceneData`): NO provoca re-render de React. `useFrame` lee `ref.current` e interpola hacia él.
 */
export function useAssetTarget(id: string) {
  const data = useSceneData();
  const ref = useRef<AssetTarget>({});
  useEffect(() => {
    const read = (s: SceneSnapshot) => {
      const state = s.assets[id];
      const severity = s.alarmSeverityByAsset[id];
      if (ref.current.state !== state || ref.current.severity !== severity) ref.current = { state, severity };
    };
    read(data.get());
    return data.subscribe(read);
  }, [id, data]);
  return ref;
}
