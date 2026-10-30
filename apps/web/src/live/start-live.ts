import type { AlarmEvent, ServerMessage } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { AdminApiError } from '@/lib/admin/errors';
import { config, buildWsUrl } from '@/lib/env';
import { getToken } from '@/lib/auth';
import { createBatcher } from '@/lib/batcher';
import { parseServerMessage } from '@/lib/messages';
import { loadSnapshot, saveSnapshot } from '@/lib/snapshot-cache';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { createCatalogSync } from './catalog-sync';
import { startCatalogSource, startMockSource } from './mock-source';
import { LiveClient, type WsFactory } from './ws-client';

/** Alarmas activas al (re)conectar: el snapshot WS no las incluye. Best-effort. */
async function fetchActiveAlarms(plant: string, push: (m: ServerMessage) => void, isCurrent: () => boolean): Promise<void> {
  try {
    const token = getToken();
    const res = await fetch(`${config.apiUrl}/api/alarms?state=active&plant=${encodeURIComponent(plant)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok || !isCurrent()) return;
    const list: unknown = await res.json();
    if (!Array.isArray(list) || !isCurrent()) return;
    for (const item of list) {
      const m = parseServerMessage({ type: 'alarm', state: 'active', ...(item as object) });
      if (m && m.type === 'alarm' && m.plant === plant) push(m as AlarmEvent);
    }
  } catch {
    /* sin red: seguimos con lo que llegue por WS */
  }
}

/** Red o servidor caído: se reintenta. 403/404 (planta sin acceso o borrada): no. */
const retriable = (e: unknown) => !(e instanceof AdminApiError) || ['network', 'server', 'unknown'].includes(e.kind);

export interface StartLiveOptions {
  /** Inyectable en tests */
  createSocket?: WsFactory;
}

/**
 * Arranca la fuente de datos (mock o WebSocket real) de UNA planta, conectada al store con
 * batching por rAF. Empieza con el estado vivo limpio (sin restos de otra planta) y devuelve la
 * función de parada; para cambiar de planta se para y se vuelve a arrancar con la nueva.
 */
export function startLive(plant: string, opts: StartLiveOptions = {}): () => void {
  const store = useLiveStore;
  store.getState().reset();
  clearHistory();
  useUiStore.getState().select(null);
  store.getState().setMode(config.mock ? 'mock' : 'live', plant);
  let alive = true;
  const batcher = createBatcher((b) => {
    if (alive) store.getState().applyBatch(b);
  });
  // la lista y el 3D salen del catálogo de la planta; `{type:"catalog"}` lo vuelve a pedir (con debounce)
  const catalog = createCatalogSync({
    load: () => getAdminApi().listAssets(plant),
    onLoaded: (list) => store.getState().setCatalog(list),
    onError: () => store.getState().setCatalogError(true),
    shouldRetry: retriable,
  });
  catalog.refresh();

  if (config.mock) {
    store.getState().setConnection('open');
    const emit = (m: ServerMessage) => {
      if (m.type === 'catalog') {
        if (m.plant === plant) catalog.schedule();
      } else batcher.push(m);
    };
    const stop = plant === 'demo' ? startMockSource(emit, plant) : startCatalogSource(emit, plant);
    return () => {
      alive = false;
      stop();
      catalog.dispose();
      batcher.dispose();
    };
  }

  const cached = loadSnapshot(plant);
  if (cached) store.getState().hydrate(cached.assets);

  let snapshots = 0;
  const client = new LiveClient({
    buildUrl: () => {
      const token = getToken();
      return token ? buildWsUrl(config.wsUrl, plant, token) : null;
    },
    onMessage: (m) => {
      if (!alive || m.plant !== plant) return;
      if (m.type === 'catalog') {
        catalog.schedule();
        return;
      }
      batcher.push(m);
      if (m.type === 'snapshot') {
        void fetchActiveAlarms(plant, (a) => batcher.push(a), () => alive);
        // al reconectar pudo cambiar el catálogo mientras estábamos desconectados (el primer snapshot ya va con la carga inicial)
        if (snapshots++ > 0) catalog.schedule();
      }
    },
    onStatus: (status, attempt) => {
      if (alive) store.getState().setConnection(status, attempt);
    },
    createSocket: opts.createSocket,
  });
  client.start();

  const onOnline = () => client.retryNow();
  window.addEventListener('online', onOnline);
  const cacheTimer = setInterval(() => {
    const { assets, fromCache } = store.getState();
    if (!fromCache && Object.keys(assets).length > 0) saveSnapshot(plant, assets);
  }, 5000);

  return () => {
    alive = false;
    window.removeEventListener('online', onOnline);
    clearInterval(cacheTimer);
    client.stop();
    catalog.dispose();
    batcher.dispose();
  };
}
