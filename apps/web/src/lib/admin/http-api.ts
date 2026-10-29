import type { AssetDef, AuditEntry, ManagedUser, Me, Plant } from '@campo/shared';
import { AdminApiError, errorFromResponse, networkError } from './errors';
import type {
  AdminApi,
  AlarmRule,
  AlarmRuleInput,
  AlarmRulePatch,
  AssetInput,
  AssetPatch,
  AuditQuery,
  UserInput,
  UserPatch,
} from './types';

export interface HttpApiOptions {
  /** Base REST ('' = mismo origen) */
  baseUrl: string;
  getToken: () => string | null;
  /** 401: la sesión ya no vale (cerrar sesión y volver a /login). Se llama una vez por respuesta 401. */
  onUnauthorized?: () => void;
  /** Inyectable en tests. */
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

const enc = encodeURIComponent;
const unexpected = () => new AdminApiError('Respuesta inesperada del servidor.', 502, 'server');

/** Cliente REST con Bearer y errores uniformes (`AdminApiError`). */
export class HttpAdminApi implements AdminApi {
  constructor(private readonly opts: HttpApiOptions) {}

  private async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Query } = {},
  ): Promise<T | undefined> {
    const doFetch = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    const url = `${this.opts.baseUrl}/api${path}${q ? `?${q}` : ''}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.opts.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw networkError();
    }

    const text = await res.text().catch(() => '');
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined; // HTML de un proxy, etc.: nunca se muestra
      }
    }
    if (!res.ok) {
      const err = errorFromResponse(res.status, body);
      if (err.kind === 'unauthorized') this.opts.onUnauthorized?.();
      throw err;
    }
    if (text && body === undefined) throw unexpected();
    return body as T | undefined;
  }

  private async get<T>(path: string, query?: Query): Promise<T> {
    const body = await this.request<T>('GET', path, { query });
    if (body === undefined) throw unexpected();
    return body;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const out = await this.request<T>(method, path, { body });
    if (out === undefined) throw unexpected();
    return out;
  }

  private async list<T>(path: string, query?: Query): Promise<T[]> {
    const body = await this.get<unknown>(path, query);
    if (!Array.isArray(body)) throw unexpected();
    return body as T[];
  }

  me = () => this.get<Me>('/me');

  async changePassword(input: { currentPassword: string; newPassword: string }) {
    const out = await this.send<{ accessToken?: unknown }>('POST', '/me/password', input);
    if (typeof out.accessToken !== 'string' || !out.accessToken) throw unexpected();
    return { accessToken: out.accessToken };
  }

  listPlants = () => this.list<Plant>('/plants');
  createPlant = (input: { id: string; name: string }) => this.send<Plant>('POST', '/plants', input);
  renamePlant = (id: string, name: string) => this.send<Plant>('PATCH', `/plants/${enc(id)}`, { name });
  async deletePlant(id: string) {
    await this.request('DELETE', `/plants/${enc(id)}`);
  }

  listAssets = (plant: string) => this.list<AssetDef>(`/plants/${enc(plant)}/assets`);
  createAsset = (plant: string, input: AssetInput) => this.send<AssetDef>('POST', `/plants/${enc(plant)}/assets`, input);
  updateAsset = (plant: string, id: string, patch: AssetPatch) =>
    this.send<AssetDef>('PATCH', `/plants/${enc(plant)}/assets/${enc(id)}`, patch);
  async deleteAsset(plant: string, id: string) {
    const out = await this.request<{ affectedRules?: unknown }>('DELETE', `/plants/${enc(plant)}/assets/${enc(id)}`);
    const n = out?.affectedRules;
    return { affectedRules: typeof n === 'number' && Number.isFinite(n) ? n : 0 };
  }

  listUsers = () => this.list<ManagedUser>('/users');
  createUser = (input: UserInput) => this.send<ManagedUser>('POST', '/users', input);
  updateUser = (id: string, patch: UserPatch) => this.send<ManagedUser>('PATCH', `/users/${enc(id)}`, patch);
  setUserPlants = (id: string, plants: string[]) => this.send<ManagedUser>('PUT', `/users/${enc(id)}/plants`, { plants });
  revokeUserSessions = (id: string) => this.send<ManagedUser>('POST', `/users/${enc(id)}/revoke`);

  listRules = () => this.list<AlarmRule>('/alarm-rules');
  createRule = (input: AlarmRuleInput) => this.send<AlarmRule>('POST', '/alarm-rules', input);
  updateRule = (id: string, patch: AlarmRulePatch) => this.send<AlarmRule>('PATCH', `/alarm-rules/${enc(id)}`, patch);
  async deleteRule(id: string) {
    await this.request('DELETE', `/alarm-rules/${enc(id)}`);
  }

  listAudit = (q: AuditQuery = {}) =>
    this.list<AuditEntry>('/audit', { limit: q.limit, before: q.before, actor: q.actor, action: q.action });
}
