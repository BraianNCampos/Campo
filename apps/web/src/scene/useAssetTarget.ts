import { useEffect, useRef } from 'react';
import type { AssetState, Severity } from '@campo/shared';
import type { LiveAlarm } from '@/lib/alarm-lifecycle';
import { anomalyBase, type AnomalyBase } from './anomaly';
import { useSceneData, type SceneSnapshot } from './scene-data';

export interface AssetTarget {
  state?: AssetState;
  severity?: Severity;
  /** anomalía del activo sin el reloj (ver `anomalyAt`); `null` = en rango */
  anomaly?: AnomalyBase | null;
}

// alarmas agrupadas por activo, una vez por identidad del mapa de alarmas del store
let groupedFor: Record<string, LiveAlarm> | undefined;
let grouped = new Map<string, LiveAlarm[]>();
const NONE: LiveAlarm[] = [];
function alarmsOf(alarms: Record<string, LiveAlarm> | undefined, id: string): LiveAlarm[] {
  if (!alarms) return NONE;
  if (groupedFor !== alarms) {
    groupedFor = alarms;
    grouped = new Map();
    for (const a of Object.values(alarms)) {
      const list = grouped.get(a.asset);
      if (list) list.push(a);
      else grouped.set(a.asset, [a]);
    }
  }
  return grouped.get(id) ?? NONE;
}

/**
 * Valor objetivo de un activo para la escena 3D. Se actualiza con la suscripción transitoria de la
 * fuente de datos (`SceneData`): NO provoca re-render de React. `useFrame` lee `ref.current` e interpola hacia él.
 */
export function useAssetTarget(id: string) {
  const data = useSceneData();
  const ref = useRef<AssetTarget>({});
  const seen = useRef<{ alarms?: unknown; limits?: unknown; def?: unknown }>({});
  useEffect(() => {
    const read = (s: SceneSnapshot) => {
      const state = s.assets[id];
      const severity = s.alarmSeverityByAsset[id];
      const limits = s.limitsByAsset?.[id];
      const def = s.catalog?.[id];
      const stale = seen.current.alarms !== s.alarms || seen.current.limits !== limits || seen.current.def !== def;
      if (ref.current.state !== state || ref.current.severity !== severity || stale) {
        seen.current = { alarms: s.alarms, limits, def };
        ref.current = {
          state,
          severity,
          anomaly: anomalyBase({ state, alarms: alarmsOf(s.alarms, id), limits: limits ?? [], def }),
        };
      }
    };
    read(data.get());
    return data.subscribe(read);
  }, [id, data]);
  return ref;
}
