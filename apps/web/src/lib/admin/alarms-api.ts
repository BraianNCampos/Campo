import type { AlarmEvent, AlarmKind, AlarmKpis, AlarmLifecycle, AlarmPolicy, AlarmRationale, Severity } from '@campo/shared';
import { AdminApiError, errorFromResponse, networkError } from './errors';

/** Cliente de alarmas ISA-18.2 (docs/architecture.md §12): lista, ciclo de vida, diario, política y KPIs. */

export type AlarmListState = 'active' | 'cleared' | 'shelved';
export type KpiWindow = AlarmKpis['window'];
export const KPI_WINDOWS: readonly KpiWindow[] = ['24h', '7d', '30d'];

export type JournalEvent = 'activated' | 'acknowledged' | 'cleared' | 'closed' | 'shelved' | 'unshelved' | 'reannounced' | 'suppressed';

/** Una línea del diario (`alarm_events`). El contrato no fija la forma exacta: `parseJournal` es tolerante. */
export interface AlarmJournalEntry {
  ts: number;
  event: JournalEvent | string;
  /** quién (correo); `null` = el sistema */
  actor: string | null;
  detail?: string;
  value?: number;
}

export interface ShelveInput {
  /** 1–480 */
  minutes: number;
  /** ≥ 3 caracteres */
  reason: string;
}

export const SHELVE_MINUTES = { min: 1, max: 480 } as const;
export const SHELVE_PRESETS: readonly number[] = [15, 30, 60, 120, 480];
export const REASON_MIN = 3;

export interface AlarmsApi {
  /** `plant` opcional: la API filtra por las plantas permitidas. */
  listAlarms(q: { state: AlarmListState; plant?: string; limit?: number }): Promise<AlarmEvent[]>;
  ack(id: string): Promise<AlarmEvent | null>;
  shelve(id: string, input: ShelveInput): Promise<AlarmEvent | null>;
  unshelve(id: string): Promise<AlarmEvent | null>;
  journal(id: string): Promise<AlarmJournalEntry[]>;
  getPolicy(plant: string): Promise<AlarmPolicy>;
  setPolicy(plant: string, policy: AlarmPolicy): Promise<AlarmPolicy>;
  kpis(plant: string, window: KpiWindow): Promise<AlarmKpis>;
}

// ── Errores en voseo ──

export type AlarmAction = 'list' | 'ack' | 'shelve' | 'unshelve' | 'journal' | 'policy' | 'kpis';

const FORBIDDEN: Record<AlarmAction, string> = {
  list: 'No tenés acceso a las alarmas de esta planta.',
  ack: 'Tu rol no permite reconocer alarmas. Pedile a alguien de operación o ingeniería que lo haga.',
  shelve: 'Postergar alarmas es para ingeniería y administración. Pedile a alguien con ese rol que lo haga.',
  unshelve: 'Reactivar una alarma postergada es para ingeniería y administración.',
  journal: 'No tenés acceso al diario de esta alarma.',
  policy: 'Cambiar la política de alarmas es sólo para administración.',
  kpis: 'No tenés acceso a la salud de alarmas de esta planta.',
};

const CONFLICT: Record<AlarmAction, string> = {
  list: 'La operación choca con el estado actual.',
  ack: 'Esa alarma ya no se puede reconocer: cambió de estado mientras mirabas. Actualizá la lista.',
  shelve: 'Esa alarma ya no se puede postergar: cambió de estado mientras mirabas. Actualizá la lista.',
  unshelve: 'Esa alarma ya no está postergada. Actualizá la lista.',
  journal: 'La operación choca con el estado actual.',
  policy: 'La política cambió mientras la editabas. Volvé a abrirla.',
  kpis: 'La operación choca con el estado actual.',
};

/** Mismo mapeo de errores que el resto de la administración, con textos propios de alarmas para 403/404/409. */
export function alarmErrorFromResponse(action: AlarmAction, status: number, body: unknown): AdminApiError {
  if (status === 403) return new AdminApiError(FORBIDDEN[action], 403, 'forbidden');
  if (status === 409) return new AdminApiError(CONFLICT[action], 409, 'conflict');
  if (status === 404 && action !== 'list' && action !== 'kpis' && action !== 'policy') {
    return new AdminApiError('No encontramos esa alarma. Puede que ya se haya cerrado: actualizá la lista.', 404, 'not_found');
  }
  return errorFromResponse(status, body);
}

// ── Validación de formularios (alineada con la API) ──

export function validateShelve(minutes: string | number, reason: string): { errors: Record<string, string>; value?: ShelveInput } {
  const errors: Record<string, string> = {};
  const m = typeof minutes === 'number' ? minutes : minutes.trim() === '' ? NaN : Number(minutes);
  if (!Number.isInteger(m) || m < SHELVE_MINUTES.min || m > SHELVE_MINUTES.max) errors.minutes = `Indicá un número entero de minutos entre ${SHELVE_MINUTES.min} y ${SHELVE_MINUTES.max}.`;
  const r = reason.trim();
  if (r.length < REASON_MIN) errors.reason = `Contanos el motivo (mínimo ${REASON_MIN} caracteres).`;
  else if (r.length > 300) errors.reason = 'Máximo 300 caracteres.';
  return Object.keys(errors).length ? { errors } : { errors, value: { minutes: m, reason: r } };
}

export function validatePolicy(v: { ratePerDay: string; peak10min: string; staleHours: string }): { errors: Record<string, string>; value?: AlarmPolicy } {
  const errors: Record<string, string> = {};
  const n = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const rate = n(v.ratePerDay);
  const peak = n(v.peak10min);
  const stale = n(v.staleHours);
  if (!Number.isFinite(rate) || rate < 1 || rate > 10_000) errors.ratePerDay = 'Un número entre 1 y 10 000 alarmas por día.';
  if (!Number.isFinite(peak) || peak < 1 || peak > 1000) errors.peak10min = 'Un número entre 1 y 1000 alarmas en 10 minutos.';
  if (!Number.isFinite(stale) || stale < 1 || stale > 720) errors.staleHours = 'Un número entre 1 y 720 horas.';
  return Object.keys(errors).length ? { errors } : { errors, value: { ratePerDay: rate, peak10min: peak, staleHours: stale } };
}

// ── Parseo tolerante de respuestas REST ──

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const KINDS: readonly string[] = ['HH', 'HI', 'LO', 'LL', 'DEV', 'ROC'];
const LIFECYCLES: readonly string[] = ['unacked', 'acked', 'rtn_unacked', 'closed', 'shelved'];

function rationale(v: unknown): AlarmRationale | undefined {
  if (!isObj(v)) return undefined;
  const out: AlarmRationale = {};
  for (const k of ['description', 'consequence', 'response'] as const) {
    const s = str(v[k]);
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Un registro REST de alarma (puede no traer `type`) → `AlarmEvent`; `null` si no es utilizable. */
export function toAlarm(raw: unknown, now = Date.now()): AlarmEvent | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const plant = str(raw.plant);
  const asset = str(raw.asset);
  const metric = str(raw.metric);
  if (!id || !plant || !asset || !metric) return null;
  const severity: Severity | undefined = raw.severity === 'critical' || raw.severity === 'warning' ? raw.severity : undefined;
  if (!severity) return null;
  const state = raw.state === 'cleared' ? 'cleared' : 'active';
  const ev: AlarmEvent = {
    type: 'alarm',
    id,
    ruleId: str(raw.ruleId) ?? '',
    plant,
    asset,
    metric,
    severity,
    state,
    value: num(raw.value) ?? 0,
    threshold: num(raw.threshold) ?? 0,
    ts: num(raw.ts) ?? now,
    message: str(raw.message) ?? '',
  };
  if (typeof raw.acknowledged === 'boolean') ev.acknowledged = raw.acknowledged;
  if (typeof raw.kind === 'string' && KINDS.includes(raw.kind)) ev.kind = raw.kind as AlarmKind;
  if (typeof raw.lifecycle === 'string' && LIFECYCLES.includes(raw.lifecycle)) ev.lifecycle = raw.lifecycle as AlarmLifecycle;
  const r = rationale(raw.rationale);
  if (r) ev.rationale = r;
  const until = num(raw.shelvedUntil);
  if (until !== undefined) ev.shelvedUntil = until;
  const why = str(raw.shelvedReason);
  if (why) ev.shelvedReason = why;
  return ev;
}

const EVENT_ALIASES: Record<string, JournalEvent> = {
  activated: 'activated', activation: 'activated', active: 'activated', raised: 'activated',
  acknowledged: 'acknowledged', ack: 'acknowledged', acked: 'acknowledged',
  cleared: 'cleared', normalized: 'cleared', rtn: 'cleared', returned: 'cleared',
  closed: 'closed',
  shelved: 'shelved', shelve: 'shelved',
  unshelved: 'unshelved', unshelve: 'unshelved', expired: 'unshelved',
  reannounced: 'reannounced', reactivated: 'reannounced',
  suppressed: 'suppressed', suppression: 'suppressed',
};

/** Diario: acepta `ts|at`, `event|type|kind|action` y `actor|actorEmail|by|user`; ordenado de más viejo a más nuevo. */
export function parseJournal(raw: unknown): AlarmJournalEntry[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.events) ? raw.events : [];
  const out: AlarmJournalEntry[] = [];
  for (const item of list) {
    if (!isObj(item)) continue;
    const ts = num(item.ts) ?? num(item.at) ?? num(item.createdAt);
    const name = str(item.event) ?? str(item.type) ?? str(item.kind) ?? str(item.action);
    if (ts === undefined || !name) continue;
    const actor = str(item.actor) ?? str(item.actorEmail) ?? str(item.by) ?? str(item.user) ?? null;
    const entry: AlarmJournalEntry = { ts, event: EVENT_ALIASES[name.toLowerCase()] ?? name, actor };
    const detail = str(item.detail) ?? str(item.reason) ?? str(item.message);
    if (detail) entry.detail = detail;
    const value = num(item.value);
    if (value !== undefined) entry.value = value;
    out.push(entry);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function parsePolicy(raw: unknown): AlarmPolicy | null {
  if (!isObj(raw)) return null;
  const r = num(raw.ratePerDay);
  const p = num(raw.peak10min);
  const s = num(raw.staleHours);
  return r !== undefined && p !== undefined && s !== undefined ? { ratePerDay: r, peak10min: p, staleHours: s } : null;
}

function parseKpis(raw: unknown, window: KpiWindow): AlarmKpis | null {
  if (!isObj(raw)) return null;
  const policy = parsePolicy(raw.policy);
  const peak = isObj(raw.peak10min) ? raw.peak10min : null;
  const by = isObj(raw.byPriority) ? raw.byPriority : null;
  if (!policy || !peak || !by) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);
  return {
    window: raw.window === '24h' || raw.window === '7d' || raw.window === '30d' ? raw.window : window,
    from: num(raw.from) ?? 0,
    to: num(raw.to) ?? Date.now(),
    policy,
    total: num(raw.total) ?? 0,
    perDay: num(raw.perDay) ?? 0,
    perHour: num(raw.perHour) ?? 0,
    peak10min: { count: num(peak.count) ?? 0, at: num(peak.at) ?? null },
    byPriority: { critical: num(by.critical) ?? 0, warning: num(by.warning) ?? 0 },
    top: arr(raw.top).map((t) => ({ ruleId: str(t.ruleId) ?? '', asset: str(t.asset) ?? '', metric: str(t.metric) ?? '', kind: (KINDS.includes(String(t.kind)) ? t.kind : 'HI') as AlarmKind, count: num(t.count) ?? 0 })),
    chattering: arr(raw.chattering).map((t) => ({ ruleId: str(t.ruleId) ?? '', asset: str(t.asset) ?? '', metric: str(t.metric) ?? '', activations10min: num(t.activations10min) ?? 0 })),
    stale: arr(raw.stale).map((t) => ({ id: str(t.id) ?? '', asset: str(t.asset) ?? '', metric: str(t.metric) ?? '', since: num(t.since) ?? 0 })),
    shelved: num(raw.shelved) ?? 0,
    suppressed: num(raw.suppressed) ?? 0,
    outOfService: num(raw.outOfService) ?? 0,
    status: raw.status === 'warning' || raw.status === 'critical' ? raw.status : 'ok',
  };
}

// ── HTTP ──

export interface HttpAlarmsOptions {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

const enc = encodeURIComponent;
const unexpected = () => new AdminApiError('Respuesta inesperada del servidor.', 502, 'server');

export class HttpAlarmsApi implements AlarmsApi {
  constructor(private readonly opts: HttpAlarmsOptions) {}

  private async request(action: AlarmAction, method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<unknown> {
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
      const err = alarmErrorFromResponse(action, res.status, parsed);
      if (err.kind === 'unauthorized') this.opts.onUnauthorized?.();
      throw err;
    }
    if (text && parsed === undefined) throw unexpected();
    return parsed;
  }

  async listAlarms(q: { state: AlarmListState; plant?: string; limit?: number }) {
    const body = await this.request('list', 'GET', '/alarms', undefined, { state: q.state, plant: q.plant, limit: q.limit });
    if (!Array.isArray(body)) throw unexpected();
    return body.map((x) => toAlarm(x)).filter((x): x is AlarmEvent => x !== null);
  }
  private async transition(action: AlarmAction, id: string, verb: string, body?: unknown) {
    const out = await this.request(action, 'POST', `/alarms/${enc(id)}/${verb}`, body ?? {});
    return toAlarm(out);
  }
  ack = (id: string) => this.transition('ack', id, 'ack');
  shelve = (id: string, input: ShelveInput) => this.transition('shelve', id, 'shelve', input);
  unshelve = (id: string) => this.transition('unshelve', id, 'unshelve');
  async journal(id: string) {
    return parseJournal(await this.request('journal', 'GET', `/alarms/${enc(id)}/journal`));
  }
  async getPolicy(plant: string) {
    const p = parsePolicy(await this.request('policy', 'GET', `/plants/${enc(plant)}/alarm-policy`));
    if (!p) throw unexpected();
    return p;
  }
  async setPolicy(plant: string, policy: AlarmPolicy) {
    const p = parsePolicy(await this.request('policy', 'PUT', `/plants/${enc(plant)}/alarm-policy`, policy));
    if (!p) throw unexpected();
    return p;
  }
  async kpis(plant: string, window: KpiWindow) {
    const k = parseKpis(await this.request('kpis', 'GET', `/plants/${enc(plant)}/alarm-kpis`, undefined, { window }), window);
    if (!k) throw unexpected();
    return k;
  }
}
