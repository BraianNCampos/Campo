import type { AlarmEvent, ServerMessage } from '@campo/shared';
import { config, buildWsUrl } from '@/lib/env';
import { getToken } from '@/lib/auth';
import { createBatcher } from '@/lib/batcher';
import { parseServerMessage } from '@/lib/messages';
import { loadSnapshot, saveSnapshot } from '@/lib/snapshot-cache';
import { useLiveStore } from '@/store/live-store';
import { startMockSource } from './mock-source';
import { LiveClient } from './ws-client';

/** Alarmas activas al (re)conectar: el snapshot WS no las incluye. Best-effort. */
async function fetchActiveAlarms(push: (m: ServerMessage) => void): Promise<void> {
  try {
    const token = getToken();
    const res = await fetch(`${config.apiUrl}/api/alarms?state=active`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const m = parseServerMessage({ type: 'alarm', state: 'active', ...(item as object) });
      if (m && m.type === 'alarm' && m.plant === config.plant) push(m as AlarmEvent);
    }
  } catch {
    /* sin red: seguimos con lo que llegue por WS */
  }
}

/**
 * Arranca la fuente de datos (mock o WebSocket real) conectada al store con
 * batching por rAF. Devuelve la función de parada.
 */
export function startLive(): () => void {
  const store = useLiveStore;
  store.getState().setMode(config.mock ? 'mock' : 'live', config.plant);
  const batcher = createBatcher((b) => store.getState().applyBatch(b));

  if (config.mock) {
    store.getState().setConnection('open');
    const stop = startMockSource((m) => batcher.push(m), config.plant);
    return () => {
      stop();
      batcher.dispose();
    };
  }

  const cached = loadSnapshot(config.plant);
  if (cached) store.getState().hydrate(cached.assets);

  const client = new LiveClient({
    buildUrl: () => {
      const token = getToken();
      return token ? buildWsUrl(config.wsUrl, config.plant, token) : null;
    },
    onMessage: (m) => {
      if (m.type === 'snapshot' && m.plant !== config.plant) return;
      batcher.push(m);
      if (m.type === 'snapshot') void fetchActiveAlarms((a) => batcher.push(a));
    },
    onStatus: (status, attempt) => store.getState().setConnection(status, attempt),
  });
  client.start();

  const onOnline = () => client.retryNow();
  window.addEventListener('online', onOnline);
  const cacheTimer = setInterval(() => {
    const { assets, fromCache } = store.getState();
    if (!fromCache && Object.keys(assets).length > 0) saveSnapshot(config.plant, assets);
  }, 5000);

  return () => {
    window.removeEventListener('online', onOnline);
    clearInterval(cacheTimer);
    client.stop();
    batcher.dispose();
  };
}
