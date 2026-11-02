import { createContext, useContext } from 'react';
import type { AssetDef, AssetState, Limit, Severity } from '@campo/shared';
import type { LiveAlarm } from '@/lib/alarm-lifecycle';
import { useLiveStore } from '@/store/live-store';

/** Lo que el 3D lee de los datos en vivo. */
export interface SceneSnapshot {
  assets: Record<string, AssetState>;
  alarmSeverityByAsset: Record<string, Severity>;
  /** alarmas del store (para el contorno/marcador de anomalías); ausente en la vista previa de administración */
  alarms?: Record<string, LiveAlarm>;
  /** límites por activo («cerca del límite») */
  limitsByAsset?: Record<string, Limit[]>;
  catalog?: Record<string, AssetDef>;
}

/** Origen de datos de la escena: acceso transitorio (get/subscribe) para no re-renderizar React por mensaje. */
export interface SceneData {
  get(): SceneSnapshot;
  subscribe(fn: (s: SceneSnapshot) => void): () => void;
}

/** Datos vivos del store (dashboard). */
export const liveSceneData: SceneData = {
  get: () => useLiveStore.getState(),
  subscribe: (fn) => useLiveStore.subscribe((s) => fn(s)),
};

const EMPTY: SceneSnapshot = { assets: {}, alarmSeverityByAsset: {} };

/** Sin telemetría (vista previa de administración): todos los activos salen "sin datos". */
export const emptySceneData: SceneData = { get: () => EMPTY, subscribe: () => () => {} };

export const SceneDataContext = createContext<SceneData>(liveSceneData);
export const useSceneData = () => useContext(SceneDataContext);
