import type { AssetDef, AuditEntry, ManagedUser, Me, ModelInfo, Plant } from '@campo/shared';
import { AdminApiError, assetsFromConflict, errorFromResponse, ModelInUseError, networkError } from './errors';
import type {
  AdminApi,
  AlarmRule,
  AlarmRuleInput,
  AlarmRulePatch,
  AssetInput,
  AssetPatch,
  AssetResult,
  AuditQuery,
  ModelUploadOptions,
  ModelUploadResult,
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
  /** Fábrica de XMLHttpRequest (la subida de modelos usa XHR para informar del progreso). Inyectable en tests. */
  xhr?: () => XhrLike;
}

/** Subconjunto de XMLHttpRequest que usa la subida de modelos. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  upload: { onprogress: ((ev: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  readonly status: number;
  readonly responseText: string;
}

type Query = Record<string, string | number | undefined>;

const enc = encodeURIComponent;

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function isModelInfo(v: unknown): v is ModelInfo {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.id === 'string' && typeof m.name === 'string' && typeof m.size === 'number';
}
const unexpected = () => new AdminApiError('Respuesta inesperada del servidor.', 502, 'server');

/** Cliente REST con Bearer y errores uniformes (`AdminApiError`). */
export class HttpAdminApi implements AdminApi {
  constructor(private readonly opts: HttpApiOptions) {}

  private async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Query; onError?: (status: number, body: unknown) => AdminApiError | undefined } = {},
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
      const err = init.onError?.(res.status, body) ?? errorFromResponse(res.status, body);
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
  createAsset = (plant: string, input: AssetInput) => this.send<AssetResult>('POST', `/plants/${enc(plant)}/assets`, input);
  updateAsset = (plant: string, id: string, patch: AssetPatch) =>
    this.send<AssetResult>('PATCH', `/plants/${enc(plant)}/assets/${enc(id)}`, patch);
  async deleteAsset(plant: string, id: string) {
    const out = await this.request<{ affectedRules?: unknown }>('DELETE', `/plants/${enc(plant)}/assets/${enc(id)}`);
    const n = out?.affectedRules;
    return { affectedRules: typeof n === 'number' && Number.isFinite(n) ? n : 0 };
  }

  // ───────── modelos 3D ─────────

  listModels = (plant: string) => this.list<ModelInfo>(`/plants/${enc(plant)}/models`);

  async deleteModel(plant: string, id: string) {
    await this.request('DELETE', `/plants/${enc(plant)}/models/${enc(id)}`, {
      onError: (status, body) => (status === 409 ? new ModelInUseError(assetsFromConflict(body)) : undefined),
    });
  }

  async downloadModel(id: string): Promise<ArrayBuffer> {
    const doFetch = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const token = this.opts.getToken();
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl}/api/models/${enc(id)}`, {
        headers: { accept: 'model/gltf-binary', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
    } catch {
      throw networkError();
    }
    if (!res.ok) {
      const err = errorFromResponse(res.status, await parseBody(res));
      if (err.kind === 'unauthorized') this.opts.onUnauthorized?.();
      throw err;
    }
    try {
      return await res.arrayBuffer();
    } catch {
      throw networkError();
    }
  }

  /** XHR (no fetch) porque `fetch` no informa del progreso de subida; cuerpo crudo con Bearer. */
  uploadModel(plant: string, file: Blob, name: string, opts: ModelUploadOptions = {}): Promise<ModelUploadResult> {
    const xhr = this.opts.xhr?.() ?? (new XMLHttpRequest() as unknown as XhrLike);
    const token = this.opts.getToken();
    return new Promise((resolve, reject) => {
      xhr.open('POST', `${this.opts.baseUrl}/api/plants/${enc(plant)}/models?name=${enc(name)}`);
      xhr.setRequestHeader('content-type', 'model/gltf-binary');
      xhr.setRequestHeader('accept', 'application/json');
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) opts.onProgress?.(ev.loaded, ev.total);
      };
      xhr.onerror = xhr.ontimeout = () => reject(networkError());
      xhr.onabort = () => reject(new AdminApiError('Subida cancelada.', 0, 'unknown'));
      xhr.onload = () => {
        let body: unknown;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
        } catch {
          body = undefined;
        }
        if (xhr.status === 200 || xhr.status === 201) {
          if (!isModelInfo(body)) return reject(unexpected());
          opts.onProgress?.(file.size, file.size);
          return resolve({ model: body, created: xhr.status === 201 });
        }
        const err = errorFromResponse(xhr.status, body);
        if (err.kind === 'unauthorized') this.opts.onUnauthorized?.();
        // 400 sin texto propio de la API: dar contexto de qué falló
        if (err.status === 400 && err.details.length <= 1 && /^Los datos enviados no son válidos/.test(err.message)) {
          return reject(new AdminApiError('El archivo no es un GLB válido o incumple los límites del modelo.', 400, 'validation'));
        }
        reject(err);
      };
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      if (opts.signal?.aborted) return reject(new AdminApiError('Subida cancelada.', 0, 'unknown'));
      xhr.send(file);
    });
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
