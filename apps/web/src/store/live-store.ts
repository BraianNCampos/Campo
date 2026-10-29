import { create } from 'zustand';
import type { AlarmEvent, AssetState, Severity } from '@campo/shared';
import type { Batch } from '@/lib/batcher';
import { sortAssetIds } from '@/lib/assets';
import { maxSeverity } from '@/lib/status';
import { pushAssetValues } from './history';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized';
export type DataMode = 'mock' | 'live';

export interface LiveData {
  plant: string;
  mode: DataMode;
  connection: ConnectionStatus;
  /** nº de reintentos consecutivos (0 si conectado) */
  attempt: number;
  lastMessageAt: number | null;
  /** true si los datos vienen de la caché local y aún no ha llegado un snapshot */
  fromCache: boolean;
  assets: Record<string, AssetState>;
  /** ids ordenados; la referencia sólo cambia si cambia el conjunto */
  assetIds: string[];
  /** alarmas activas por id */
  alarms: Record<string, AlarmEvent>;
  alarmSeverityByAsset: Record<string, Severity>;
  notice: string | null;
}

export interface LiveActions {
  applyBatch(batch: Batch, now?: number): void;
  setConnection(connection: ConnectionStatus, attempt?: number): void;
  setMode(mode: DataMode, plant: string): void;
  hydrate(assets: Record<string, AssetState>): void;
  ackLocal(id: string): void;
  setNotice(msg: string | null): void;
  reset(): void;
}

export type LiveStore = LiveData & LiveActions;

export const initialLiveData = (): LiveData => ({
  plant: 'demo',
  mode: 'mock',
  connection: 'idle',
  attempt: 0,
  lastMessageAt: null,
  fromCache: false,
  assets: {},
  assetIds: [],
  alarms: {},
  alarmSeverityByAsset: {},
  notice: null,
});

const MAX_ALARMS = 500;

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function severityByAsset(alarms: Record<string, AlarmEvent>): Record<string, Severity> {
  const out: Record<string, Severity> = {};
  for (const a of Object.values(alarms)) out[a.asset] = maxSeverity(out[a.asset], a.severity);
  return out;
}

/** Reductor puro: aplica un lote al estado. Devuelve sólo los campos que cambian. */
export function reduceBatch(
  s: Pick<LiveData, 'assets' | 'assetIds' | 'alarms' | 'alarmSeverityByAsset'>,
  batch: Batch,
): Partial<LiveData> {
  const patch: Partial<LiveData> = {};

  let assets = s.assets;
  let copied = false;
  const writable = () => {
    if (!copied) {
      assets = { ...assets };
      copied = true;
    }
    return assets;
  };

  if (batch.snapshot) {
    assets = { ...batch.snapshot.assets };
    copied = true;
  }
  for (const [id, st] of Object.entries(batch.telemetry)) {
    const prev = assets[id];
    if (prev && st.ts < prev.ts) continue; // dato viejo fuera de orden
    writable()[id] = prev
      ? { ts: st.ts, quality: st.quality, values: { ...prev.values, ...st.values } }
      : st;
  }
  if (copied) {
    patch.assets = assets;
    const ids = sortAssetIds(Object.keys(assets));
    if (!sameIds(ids, s.assetIds)) patch.assetIds = ids;
  }

  if (batch.alarms.length > 0) {
    const alarms = { ...s.alarms };
    for (const a of batch.alarms) {
      if (a.state === 'cleared') {
        delete alarms[a.id];
      } else {
        const prev = alarms[a.id];
        alarms[a.id] = a.acknowledged === undefined && prev?.acknowledged ? { ...a, acknowledged: true } : a;
      }
    }
    const ids = Object.keys(alarms);
    if (ids.length > MAX_ALARMS) {
      ids
        .sort((x, y) => (alarms[x]?.ts ?? 0) - (alarms[y]?.ts ?? 0))
        .slice(0, ids.length - MAX_ALARMS)
        .forEach((id) => delete alarms[id]);
    }
    patch.alarms = alarms;
    patch.alarmSeverityByAsset = severityByAsset(alarms);
  }
  return patch;
}

export const useLiveStore = create<LiveStore>()((set, get) => ({
  ...initialLiveData(),

  applyBatch(batch, now = Date.now()) {
    const patch = reduceBatch(get(), batch);
    // histórico para sparklines/curvas (fuera del estado reactivo)
    if (batch.snapshot) for (const [id, st] of Object.entries(batch.snapshot.assets)) pushAssetValues(id, st.ts, st.values);
    for (const [id, st] of Object.entries(batch.telemetry)) pushAssetValues(id, st.ts, st.values);
    set({ ...patch, lastMessageAt: now, ...(batch.snapshot ? { fromCache: false } : {}) });
  },

  setConnection(connection, attempt = 0) {
    set({ connection, attempt });
  },

  setMode(mode, plant) {
    set({ mode, plant });
  },

  hydrate(assets) {
    if (Object.keys(get().assets).length > 0) return;
    set({ assets, assetIds: sortAssetIds(Object.keys(assets)), fromCache: true });
  },

  ackLocal(id) {
    const a = get().alarms[id];
    if (!a || a.acknowledged) return;
    set({ alarms: { ...get().alarms, [id]: { ...a, acknowledged: true } } });
  },

  setNotice(notice) {
    set({ notice });
  },

  reset() {
    set(initialLiveData());
  },
}));

/** Alarmas activas ordenadas: críticas primero, sin reconocer primero, más recientes primero. */
export function sortAlarms(alarms: Record<string, AlarmEvent>): AlarmEvent[] {
  return Object.values(alarms).sort(
    (a, b) =>
      (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0) ||
      Number(!!a.acknowledged) - Number(!!b.acknowledged) ||
      b.ts - a.ts,
  );
}
