import type { InterlockItem, Order, OrderPreview } from '@campo/shared';
import { AdminApiError, networkError } from '@/lib/admin/errors';
import { parseOrder } from '@/lib/messages';
import { controlErrorFromResponse } from './errors';
import type { ControlApi, OrderQuery, PreviewRequest, SetpointResult } from './types';

export interface HttpControlOptions {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

const enc = encodeURIComponent;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unexpected = () => new AdminApiError('Respuesta inesperada del servidor.', 502, 'server');

/** `OrderPreview` desde el cuerpo del servidor; `null` si no es utilizable. */
export function parsePreview(raw: unknown): OrderPreview | null {
  if (!isObj(raw) || typeof raw.confirmId !== 'string' || !raw.confirmId) return null;
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : Date.parse(String(raw.expiresAt));
  if (!Number.isFinite(expiresAt)) return null;
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string' && w.trim() !== '') : [];
  const blocked = typeof raw.blocked === 'string' && raw.blocked.trim() !== '' ? raw.blocked.trim() : null;
  return { confirmId: raw.confirmId, expiresAt, summary: typeof raw.summary === 'string' ? raw.summary : '', warnings, blocked };
}

/** Permisos de enclavamiento: acepta una lista, `{interlocks:[…]}` o `{items:[…]}`. */
export function parseInterlocks(raw: unknown): InterlockItem[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) ? (Array.isArray(raw.interlocks) ? raw.interlocks : Array.isArray(raw.items) ? raw.items : []) : [];
  const out: InterlockItem[] = [];
  for (const x of list) {
    if (!isObj(x) || typeof x.id !== 'string') continue;
    const item: InterlockItem = { id: x.id, label: typeof x.label === 'string' ? x.label : x.id, ok: x.ok === true };
    if (typeof x.reason === 'string' && x.reason) item.reason = x.reason;
    out.push(item);
  }
  return out;
}

/** Una orden o `{order}`. */
export function parseOrderBody(raw: unknown): Order | null {
  return parseOrder(isObj(raw) && isObj(raw.order) ? raw.order : raw);
}

/** Cliente REST del control de llenado (§14.3). Errores en voseo (409 `device_offline`/`order_in_progress`, 429, 503…). */
export class HttpControlApi implements ControlApi {
  constructor(private readonly opts: HttpControlOptions) {}

  private async request(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const doFetch = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.opts.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl}/api${path}${q ? `?${q}` : ''}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw networkError();
    }
    const text = await res.text().catch(() => '');
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined; // HTML de un proxy, etc.: nunca se muestra
      }
    }
    if (!res.ok) {
      const err = controlErrorFromResponse(res.status, parsed);
      if (err.kind === 'unauthorized') this.opts.onUnauthorized?.();
      throw err;
    }
    if (text && parsed === undefined) throw unexpected();
    return parsed;
  }

  private base = (plant: string, asset: string) => `/plants/${enc(plant)}/assets/${enc(asset)}`;

  async preview(plant: string, asset: string, req: PreviewRequest) {
    const p = parsePreview(await this.request('POST', `${this.base(plant, asset)}/commands/preview`, req));
    if (!p) throw unexpected();
    return p;
  }

  async execute(plant: string, asset: string, confirmId: string) {
    const o = parseOrderBody(await this.request('POST', `${this.base(plant, asset)}/commands`, { confirmId }));
    if (!o) throw unexpected();
    return o;
  }

  async listOrders(plant: string, q: OrderQuery = {}) {
    const body = await this.request('GET', `/plants/${enc(plant)}/orders`, undefined, { asset: q.asset, status: q.status, limit: q.limit, before: q.before });
    const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.orders) ? body.orders : null;
    if (!list) throw unexpected();
    return list.map((x) => parseOrder(isObj(x) && !x.plant ? { ...x, plant } : x)).filter((x): x is Order => x !== null);
  }

  async cancelOrder(orderId: string) {
    const o = parseOrderBody(await this.request('POST', `/orders/${enc(orderId)}/cancel`, {}));
    if (!o) throw unexpected();
    return o;
  }

  async interlocks(plant: string, asset: string) {
    return parseInterlocks(await this.request('GET', `${this.base(plant, asset)}/interlocks`));
  }

  async setSetpoint(plant: string, asset: string, metric: string, value: number): Promise<SetpointResult> {
    const out = await this.request('PUT', `${this.base(plant, asset)}/setpoints/${enc(metric)}`, { value });
    const v = isObj(out) && typeof out.value === 'number' && Number.isFinite(out.value) ? out.value : value;
    return { metric, value: v };
  }
}
