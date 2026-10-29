import type { AlarmEvent, ServerMessage } from '@campo/shared';
import { config, buildWsUrl } from '@/lib/env';
import { getToken } from '@/lib/auth';
import { createBatcher } from '@/lib/batcher';
import { parseServerMessage } from '@/lib/messages';
import { loadSnapshot, saveSnapshot } from '@/lib/snapshot-cache';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
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

  if (config.mock) {
    store.getState().setConnection('open');
    const stop = plant === 'demo' ? startMockSource((m) => batcher.push(m), plant) : startCatalogSource((m) => batcher.push(m), plant);
    return () => {
      alive = false;
      stop();
      batcher.dispose();
    };
  }

  const cached = loadSnapshot(plant);
  if (cached) store.getState().hydrate(cached.assets);

  const client = new LiveClient({
    buildUrl: () => {
      const token = getToken();
      return token ? buildWsUrl(config.wsUrl, plant, token) : null;
    },
    onMessage: (m) => {
      if (!alive) return;
      if (m.type === 'snapshot' && m.plant !== plant) return;
      if ((m.type === 'telemetry' || m.type === 'alarm') && m.plant !== plant) return;
      batcher.push(m);
      if (m.type === 'snapshot') void fetchActiveAlarms(plant, (a) => batcher.push(a), () => alive);
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
    batcher.dispose();
  };
}
