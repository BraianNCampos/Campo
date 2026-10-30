import { create } from 'zustand';
import type { Me, OrgSummary, Plant } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { clearToken } from '@/lib/auth';
import { AdminApiError, errorMessage } from '@/lib/admin/errors';
import type { AdminApi } from '@/lib/admin/types';
import { config } from '@/lib/env';
import { demoPlants, loadOrgSummaries, withDemoOrg } from '@/lib/orgs';
import { usePlantStore } from './plant-store';

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';

const CACHE_KEY = 'campo.session.v2';
interface Cached {
  me: Me;
  plants: Plant[];
  orgs?: OrgSummary[];
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const v = raw ? (JSON.parse(raw) as Cached) : null;
    return v && v.me && Array.isArray(v.plants) ? v : null;
  } catch {
    return null;
  }
}
function writeCache(c: Cached) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* noop */
  }
}
export function clearSessionCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* noop */
  }
}

interface SessionState {
  me: Me | null;
  /** clientes y módulos (sólo para el personal de plataforma) */
  orgs: OrgSummary[];
  status: SessionStatus;
  error: string | null;
  /** true si los datos salen de la caché local porque no hay red */
  stale: boolean;
  /** Carga usuario (`/api/me`) y plantas (`/api/plants`). Sin red usa la última sesión cacheada. */
  load(api?: AdminApi): Promise<void>;
  /** Vuelve a pedir sólo las plantas (tras crear/borrar). */
  refreshPlants(api?: AdminApi): Promise<void>;
  setMe(me: Me): void;
  clear(): void;
}

export const useSessionStore = create<SessionState>()((set) => ({
  me: null,
  orgs: [],
  status: 'idle',
  error: null,
  stale: false,

  async load(api = getAdminApi()) {
    set({ status: 'loading', error: null });
    try {
      const [rawMe, rawPlants] = await Promise.all([api.me(), api.listPlants()]);
      // demo: el cliente sale de `getDemoOrgId()` y sólo se ven las plantas de ese cliente
      const me = config.mock ? withDemoOrg(rawMe) : rawMe;
      const plants = config.mock ? demoPlants(rawPlants) : rawPlants;
      const orgs = await loadOrgSummaries(me);
      writeCache({ me, plants, orgs });
      usePlantStore.getState().setPlants(plants);
      set({ me, orgs, status: 'ready', stale: false });
    } catch (e) {
      const cached = e instanceof AdminApiError && e.kind === 'network' ? readCache() : null;
      if (cached) {
        usePlantStore.getState().setPlants(cached.plants);
        set({ me: cached.me, orgs: cached.orgs ?? [], status: 'ready', stale: true });
      } else {
        set({ status: 'error', error: errorMessage(e) });
      }
    }
  },

  async refreshPlants(api = getAdminApi()) {
    try {
      const plants = await api.listPlants();
      usePlantStore.getState().setPlants(config.mock ? demoPlants(plants) : plants);
    } catch {
      /* se conserva la lista actual */
    }
  },

  setMe(me) {
    set({ me });
    const cached = readCache();
    if (cached) writeCache({ ...cached, me });
  },

  clear() {
    clearSessionCache();
    usePlantStore.getState().reset();
    set({ me: null, orgs: [], status: 'idle', error: null, stale: false });
  },
}));

/** Cierra la sesión local: borra el token y el estado de sesión (el llamante navega a /login). */
export function signOut(): void {
  clearToken();
  useSessionStore.getState().clear();
}
