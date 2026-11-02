import type { Role } from '@campo/shared';
import { getDemoIdentity } from '@/lib/admin';
import { clearToken, getToken } from '@/lib/auth';
import { withBase } from '@/lib/base-path';
import { config } from '@/lib/env';
import { activeModuleIds } from '@/lib/modules/nav';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { DemoControlEngine, type DemoUser, type EngineContext } from './demo-engine';
import { HttpControlApi } from './http-api';
import { MockControlApi } from './mock-api';
import type { ControlApi } from './types';

export * from './types';

function handleUnauthorized(): void {
  clearToken();
  if (typeof window !== 'undefined' && !window.location.pathname.replace(/\/$/, '').endsWith('/login')) window.location.replace(withBase('/login'));
}

/** Usuario «conectado»: el de la sesión o, sin ella, la identidad del modo demo. */
export function currentUser(): DemoUser {
  const me = useSessionStore.getState().me;
  if (me) return { id: me.id, email: me.email, role: me.role };
  const id = getDemoIdentity();
  return { id: `demo-${id.role}`, email: `${id.role}@campo.demo`, role: id.role as Role };
}

function liveContext(): EngineContext {
  return {
    now: () => Date.now(),
    catalog: () => useLiveStore.getState().catalog,
    state: (a) => useLiveStore.getState().assets[a],
    limits: (a) => useLiveStore.getState().limitsByAsset[a] ?? [],
    alarms: () => Object.values(useLiveStore.getState().alarms),
    moduleActive: () => {
      const s = useSessionStore.getState();
      const plantOrg = usePlantStore.getState().plants.find((p) => p.id === usePlantStore.getState().selected)?.orgId ?? null;
      return activeModuleIds(s.me?.org, s.me?.role, plantOrg, s.orgs ?? []).includes('control');
    },
  };
}

const engines = new Map<string, { engine: DemoControlEngine; emit: (o: import('@campo/shared').Order) => void }>();

/** Servidor de control simulado de una planta (uno por planta y por pestaña). */
export function getDemoControl(plant: string): DemoControlEngine {
  let e = engines.get(plant);
  if (!e) {
    const holder = { emit: (_o: import('@campo/shared').Order) => {} };
    e = { engine: new DemoControlEngine({ plant, ctx: liveContext(), emit: (o) => holder.emit(o) }), emit: holder.emit };
    // `emit` se reasigna desde `attachDemoControl`; el cierre de arriba lee siempre el valor vigente
    engines.set(plant, Object.assign(e, { holder }) as never);
  }
  return e.engine;
}

/** Conecta los eventos de órdenes de la planta con el flujo de mensajes (como el WebSocket real). Devuelve la desconexión. */
export function attachDemoControl(plant: string, emit: (o: import('@campo/shared').Order) => void): () => void {
  getDemoControl(plant);
  const rec = engines.get(plant) as unknown as { holder: { emit: typeof emit } };
  rec.holder.emit = emit;
  return () => {
    if (rec.holder.emit === emit) rec.holder.emit = () => {};
  };
}

/** Sólo para tests. */
export function resetDemoControl(): void {
  engines.clear();
}

let instance: ControlApi | null = null;

/** Mock en modo demo, HTTP en caso contrario. Singleton por pestaña. */
export function getControlApi(): ControlApi {
  instance ??= config.mock
    ? new MockControlApi({ user: currentUser, engine: getDemoControl, latencyMs: 150 })
    : new HttpControlApi({ baseUrl: config.apiUrl, getToken, onUnauthorized: handleUnauthorized });
  return instance;
}

/** Sólo para tests. */
export function setControlApi(api: ControlApi | null): void {
  instance = api;
}
