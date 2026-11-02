import type { AlarmKpis, AlarmPolicy, Role } from '@campo/shared';
import { getAdminApi, getDemoIdentity } from '@/lib/admin';
import { ACK_ROLES, HttpAlarmsApi, POLICY_ROLES, SHELVE_ROLES, alarmErrorFromResponse, validatePolicy, validateShelve, type AlarmAction, type AlarmJournalEntry, type AlarmListState, type AlarmsApi, type KpiWindow, type ShelveInput } from '@/lib/admin/alarms-api';
import { errorFromResponse } from '@/lib/admin/errors';
import { getToken, clearToken } from '@/lib/auth';
import { config } from '@/lib/env';
import { withBase } from '@/lib/base-path';
import { useSessionStore } from '@/store/session-store';
import { AlarmError, anyDemoEngine, findDemoEngine, getDemoEngine, type AlarmEngine } from './alarm-lifecycle';

const forbidden = (action: AlarmAction) => alarmErrorFromResponse(action, 403, {});

export interface MockAlarmsOptions {
  role: () => Role;
  actor: () => string;
  now?: () => number;
  /** reglas fuera de servicio de la planta (best-effort) */
  outOfService?: (plant: string) => Promise<number>;
}

/** Cliente de alarmas del modo demo: delega en el motor de la planta en marcha (`alarm-lifecycle.ts`). */
export class MockAlarmsApi implements AlarmsApi {
  private readonly now: () => number;
  constructor(private readonly o: MockAlarmsOptions) {
    this.now = o.now ?? Date.now;
  }

  private engineFor(id: string): AlarmEngine {
    const e = findDemoEngine(id);
    if (!e) throw alarmErrorFromResponse('ack', 404, {});
    return e;
  }
  private engineOfPlant(plant: string): AlarmEngine {
    const e = getDemoEngine(plant);
    if (!e) throw errorFromResponse(404, { message: 'La planta no tiene datos de alarmas en este momento.' });
    return e;
  }
  private need(roles: readonly Role[], action: AlarmAction) {
    if (!roles.includes(this.o.role())) throw forbidden(action);
  }
  private wrap<T>(action: AlarmAction, fn: () => T): Promise<T> {
    return Promise.resolve().then(() => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof AlarmError) throw alarmErrorFromResponse(action, e.status, {});
        throw e;
      }
    });
  }

  listAlarms(q: { state: AlarmListState; plant?: string; limit?: number }) {
    return this.wrap('list', () => {
      const e = q.plant ? getDemoEngine(q.plant) : anyDemoEngine();
      const list = e ? e.list(q.state) : [];
      return q.limit ? list.slice(0, q.limit) : list;
    });
  }
  ack(id: string) {
    return this.wrap('ack', () => {
      this.need(ACK_ROLES, 'ack');
      return this.engineFor(id).ack(id, this.now(), this.o.actor());
    });
  }
  shelve(id: string, input: ShelveInput) {
    return this.wrap('shelve', () => {
      this.need(SHELVE_ROLES, 'shelve');
      const v = validateShelve(input.minutes, input.reason);
      if (!v.value) throw errorFromResponse(400, { message: Object.values(v.errors) });
      return this.engineFor(id).shelve(id, v.value.minutes, v.value.reason, this.now(), this.o.actor());
    });
  }
  unshelve(id: string) {
    return this.wrap('unshelve', () => {
      this.need(SHELVE_ROLES, 'unshelve');
      return this.engineFor(id).unshelve(id, this.now(), this.o.actor());
    });
  }
  journal(id: string): Promise<AlarmJournalEntry[]> {
    return this.wrap('journal', () => this.engineFor(id).journal(id));
  }
  getPolicy(plant: string): Promise<AlarmPolicy> {
    return this.wrap('policy', () => this.engineOfPlant(plant).getPolicy());
  }
  setPolicy(plant: string, policy: AlarmPolicy): Promise<AlarmPolicy> {
    return this.wrap('policy', () => {
      this.need(POLICY_ROLES, 'policy');
      const v = validatePolicy({ ratePerDay: String(policy.ratePerDay), peak10min: String(policy.peak10min), staleHours: String(policy.staleHours) });
      if (!v.value) throw errorFromResponse(400, { message: Object.values(v.errors) });
      return this.engineOfPlant(plant).setPolicy(v.value);
    });
  }
  async kpis(plant: string, window: KpiWindow): Promise<AlarmKpis> {
    const out = await (this.o.outOfService?.(plant).catch(() => 0) ?? Promise.resolve(0));
    return this.wrap('kpis', () => this.engineOfPlant(plant).kpis(window, this.now(), out));
  }
}

function handleUnauthorized(): void {
  clearToken();
  if (typeof window !== 'undefined' && !window.location.pathname.replace(/\/$/, '').endsWith('/login')) window.location.replace(withBase('/login'));
}

let instance: AlarmsApi | null = null;

/** Mock en modo demo, HTTP en caso contrario. Singleton por pestaña. */
export function getAlarmsApi(): AlarmsApi {
  instance ??= config.mock
    ? new MockAlarmsApi({
        role: () => useSessionStore.getState().me?.role ?? getDemoIdentity().role,
        actor: () => useSessionStore.getState().me?.email ?? 'operador@campo.demo',
        outOfService: async (plant) => (await getAdminApi().listRules()).filter((r) => r.plant === plant && !r.enabled).length,
      })
    : new HttpAlarmsApi({ baseUrl: config.apiUrl, getToken, onUnauthorized: handleUnauthorized });
  return instance;
}

/** Sólo para tests. */
export function setAlarmsApi(api: AlarmsApi | null): void {
  instance = api;
}
