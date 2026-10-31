/**
 * Store en vivo (Zustand) de la planta elegida. Lo actualiza el WebSocket (o el simulador demo) por lotes.
 *
 * ALARMAS (ISA-18.2, docs/architecture.md §12.2) — contrato para quien consuma el store:
 * - `alarms` es un upsert por `id` del último `AlarmEvent` recibido (tipo `LiveAlarm` = AlarmEvent + `clearedAt`).
 *   Conserva `kind`, `lifecycle`, `rationale`, `shelvedUntil`, `shelvedReason`, `acknowledged`; si un evento nuevo
 *   no trae `kind`/`rationale` se mantienen los anteriores. Un evento más viejo (`ts` menor) que el guardado se ignora.
 * - Ciclo de vida efectivo: `lifecycleOf(a)` (si falta `lifecycle` se deriva de `state`/`acknowledged`).
 *   Las alarmas `closed` se eliminan del mapa. Las `shelved` quedan en el mapa pero fuera de la lista activa.
 * - Selectores (memoizados por la identidad de `alarms`; seguros para `useLiveStore(selector)`):
 *     selectAlarmList(s)    → lista activa: lifecycle unacked | acked | rtn_unacked, por importancia
 *     selectShelved(s)      → postergadas, por vencimiento
 *     selectAlarmCounts(s)  → contadores por ciclo de vida y prioridad (`{critical, warning, total}` cada uno)
 *     selectAssetNotices(s) → aviso por activo (`{severity, lifecycle}`), para tarjetas y 3D
 * - Acciones: `ackLocal(id)` (unacked→acked; rtn_unacked→cerrada) devuelve la alarma previa; `restoreAlarm(prev)`
 *   revierte un ack optimista fallido; `upsertAlarms(list)` aplica alarmas sueltas (p. ej. la lista REST).
 * - `alarmSeverityByAsset` sólo cuenta condiciones activas (unacked/acked); las normalizadas sin reconocer se ven
 *   en `selectAssetNotices`.
 */
import { create } from 'zustand';
import type { AlarmEvent, AssetDef, AssetState, Limit, Severity } from '@campo/shared';
import type { Batch } from '@/lib/batcher';
import { catalogMap, mergeAssetIds, sameCatalog } from '@/lib/catalog';
import { groupLimitsByAsset } from '@/lib/modules/status';
import { maxSeverity } from '@/lib/status';
import {
  countAlarms, isActiveCondition, isListed, lifecycleOf, noticeByAsset, rankAlarms,
  type AlarmCounts, type AssetAlarmNotice, type LiveAlarm,
} from '@/lib/alarm-lifecycle';
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
  /** catálogo de la planta (`GET /api/plants/:plant/assets`) por id */
  catalog: Record<string, AssetDef>;
  /** true cuando el catálogo ya se ha cargado al menos una vez */
  catalogReady: boolean;
  /** la última carga del catálogo falló */
  catalogError: boolean;
  /** límites de alarma de la planta (`GET /api/plants/:plant/limits`) por activo */
  limitsByAsset: Record<string, Limit[]>;
  limitsReady: boolean;
  /** catálogo ∪ telemetría, ordenados; la referencia sólo cambia si cambia el conjunto */
  assetIds: string[];
  /** alarmas activas por id */
  alarms: Record<string, LiveAlarm>;
  alarmSeverityByAsset: Record<string, Severity>;
  notice: string | null;
}

export interface LiveActions {
  applyBatch(batch: Batch, now?: number): void;
  setConnection(connection: ConnectionStatus, attempt?: number): void;
  setMode(mode: DataMode, plant: string): void;
  hydrate(assets: Record<string, AssetState>): void;
  setCatalog(list: readonly AssetDef[]): void;
  setCatalogError(failed: boolean): void;
  setLimits(list: readonly Limit[]): void;
  ackLocal(id: string): LiveAlarm | undefined;
  restoreAlarm(prev: LiveAlarm): void;
  upsertAlarms(list: readonly AlarmEvent[]): void;
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
  catalog: {},
  catalogReady: false,
  catalogError: false,
  limitsByAsset: {},
  limitsReady: false,
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
  for (const a of Object.values(alarms)) if (isActiveCondition(a)) out[a.asset] = maxSeverity(out[a.asset], a.severity);
  return out;
}

/** Aplica un evento sobre el anterior con el mismo id (upsert). `null` = la alarma sale del mapa (cerrada). */
export function mergeAlarm(prev: LiveAlarm | undefined, a: LiveAlarm): LiveAlarm | null {
  if (prev && a.ts < prev.ts) return prev; // evento viejo fuera de orden
  const next: LiveAlarm = { ...a };
  const ack = a.acknowledged ?? (a.lifecycle === 'acked' ? true : a.lifecycle === 'unacked' ? false : prev?.acknowledged);
  if (ack !== undefined) next.acknowledged = ack;
  if (!next.kind && prev?.kind) next.kind = prev.kind;
  if (!next.rationale && prev?.rationale) next.rationale = prev.rationale;
  if (lifecycleOf(next) === 'closed') return null;
  if (next.lifecycle !== 'shelved') {
    delete next.shelvedUntil;
    delete next.shelvedReason;
  }
  if (next.state === 'cleared') next.clearedAt = a.clearedAt ?? prev?.clearedAt ?? a.ts;
  else delete next.clearedAt;
  return next;
}

function pruneAlarms(alarms: Record<string, LiveAlarm>): void {
  const ids = Object.keys(alarms);
  if (ids.length <= MAX_ALARMS) return;
  ids
    .sort((x, y) => (alarms[x]?.ts ?? 0) - (alarms[y]?.ts ?? 0))
    .slice(0, ids.length - MAX_ALARMS)
    .forEach((id) => delete alarms[id]);
}

function upsertInto(base: Record<string, LiveAlarm>, list: readonly AlarmEvent[]): Record<string, LiveAlarm> {
  const alarms = { ...base };
  for (const a of list) {
    const m = mergeAlarm(alarms[a.id], a);
    if (m) alarms[a.id] = m;
    else delete alarms[a.id];
  }
  pruneAlarms(alarms);
  return alarms;
}

/** Reductor puro: aplica un lote al estado. Devuelve sólo los campos que cambian. */
export function reduceBatch(
  s: Pick<LiveData, 'assets' | 'catalog' | 'assetIds' | 'alarms' | 'alarmSeverityByAsset'>,
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
    const ids = mergeAssetIds(s.catalog, assets);
    if (!sameIds(ids, s.assetIds)) patch.assetIds = ids;
  }

  if (batch.alarms.length > 0) {
    const alarms = upsertInto(s.alarms, batch.alarms);
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
    set({ assets, assetIds: mergeAssetIds(get().catalog, assets), fromCache: true });
  },

  setCatalog(list) {
    const s = get();
    const catalog = catalogMap(list);
    if (s.catalogReady && sameCatalog(s.catalog, catalog)) {
      if (s.catalogError) set({ catalogError: false });
      return;
    }
    const ids = mergeAssetIds(catalog, s.assets);
    set({ catalog, catalogReady: true, catalogError: false, ...(sameIds(ids, s.assetIds) ? {} : { assetIds: ids }) });
  },

  setCatalogError(catalogError) {
    if (get().catalogError !== catalogError) set({ catalogError });
  },

  setLimits(list) {
    const next = groupLimitsByAsset(list);
    const prev = get().limitsByAsset;
    if (get().limitsReady && JSON.stringify(prev) === JSON.stringify(next)) return; // sin cambios: nada se re-renderiza
    set({ limitsByAsset: next, limitsReady: true });
  },

  ackLocal(id) {
    const a = get().alarms[id];
    if (!a) return undefined;
    const l = lifecycleOf(a);
    if (l === 'unacked') set({ alarms: { ...get().alarms, [id]: { ...a, acknowledged: true, lifecycle: 'acked' } } });
    else if (l === 'rtn_unacked') {
      const { [id]: _gone, ...rest } = get().alarms;
      void _gone;
      set({ alarms: rest });
    } else return undefined;
    return a;
  },

  restoreAlarm(prev) {
    set({ alarms: { ...get().alarms, [prev.id]: prev } });
  },

  upsertAlarms(list) {
    if (list.length === 0) return;
    const alarms = upsertInto(get().alarms, list);
    set({ alarms, alarmSeverityByAsset: severityByAsset(alarms) });
  },

  setNotice(notice) {
    set({ notice });
  },

  reset() {
    set(initialLiveData());
  },
}));

/** Alarmas ordenadas por importancia (críticas, sin reconocer, recientes primero). */
export function sortAlarms(alarms: Record<string, LiveAlarm>): LiveAlarm[] {
  return rankAlarms(Object.values(alarms));
}

// ---- Selectores memoizados por la identidad del mapa `alarms` ----
function memoByAlarms<T>(compute: (alarms: Record<string, LiveAlarm>) => T): (s: Pick<LiveData, 'alarms'>) => T {
  const cache = new WeakMap<object, T>();
  return (s) => {
    let v = cache.get(s.alarms);
    if (v === undefined) {
      v = compute(s.alarms);
      cache.set(s.alarms, v);
    }
    return v;
  };
}

/** Lista activa de alarmas (unacked | acked | rtn_unacked), más importantes primero. */
export const selectAlarmList: (s: Pick<LiveData, 'alarms'>) => LiveAlarm[] = memoByAlarms((alarms) =>
  rankAlarms(Object.values(alarms).filter(isListed)),
);

/** Alarmas postergadas, las que vencen antes primero. */
export const selectShelved: (s: Pick<LiveData, 'alarms'>) => LiveAlarm[] = memoByAlarms((alarms) =>
  Object.values(alarms)
    .filter((a) => lifecycleOf(a) === 'shelved')
    .sort((a, b) => (a.shelvedUntil ?? Infinity) - (b.shelvedUntil ?? Infinity) || a.id.localeCompare(b.id)),
);

export const selectAlarmCounts: (s: Pick<LiveData, 'alarms'>) => AlarmCounts = memoByAlarms((alarms) => countAlarms(Object.values(alarms)));

export const selectAssetNotices: (s: Pick<LiveData, 'alarms'>) => Record<string, AssetAlarmNotice> = memoByAlarms((alarms) =>
  noticeByAsset(Object.values(alarms)),
);
