import { createContext, useContext } from 'react';
import type { AssetState, Severity } from '@campo/shared';
import { useLiveStore } from '@/store/live-store';

/** Lo que el 3D lee de los datos en vivo. */
export interface SceneSnapshot {
  assets: Record<string, AssetState>;
  alarmSeverityByAsset: Record<string, Severity>;
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
