import type { AlarmEvent, AlarmKind, AlarmLifecycle, AlarmRationale, AssetState, Order, OrderCommand, OrderStatus, Quality, ServerMessage } from '@campo/shared';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function values(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (isNum(x)) out[k] = x;
  return out;
}

const KINDS: ReadonlySet<string> = new Set<AlarmKind>(['HH', 'HI', 'LO', 'LL', 'DEV', 'ROC']);
const LIFECYCLES: ReadonlySet<string> = new Set<AlarmLifecycle>(['unacked', 'acked', 'rtn_unacked', 'closed', 'shelved']);

function rationale(v: unknown): AlarmRationale | undefined {
  if (!isObj(v)) return undefined;
  const out: AlarmRationale = {};
  for (const k of ['description', 'consequence', 'response'] as const) {
    const x = v[k];
    if (typeof x === 'string' && x.trim()) out[k] = x.trim().slice(0, 400);
  }
  return Object.keys(out).length ? out : undefined;
}

export const ORDER_COMMANDS: ReadonlySet<string> = new Set<OrderCommand>(['fill', 'drain', 'stop', 'start', 'open', 'close', 'set_position']);
export const ORDER_STATUSES: ReadonlySet<string> = new Set<OrderStatus>(['pending', 'accepted', 'running', 'done', 'failed', 'rejected', 'timeout', 'cancelled']);

/** Valida/sanea una orden (evento WS `order` o fila de `GET .../orders`). `null` si no es utilizable. */
export function parseOrder(raw: unknown, now = Date.now()): Order | null {
  if (!isObj(raw)) return null;
  if (!isStr(raw.id) || !isStr(raw.asset)) return null;
  if (typeof raw.command !== 'string' || !ORDER_COMMANDS.has(raw.command)) return null;
  if (typeof raw.status !== 'string' || !ORDER_STATUSES.has(raw.status)) return null;
  const by = isObj(raw.requestedBy) ? raw.requestedBy : {};
  const requestedAt = isNum(raw.requestedAt) ? raw.requestedAt : now;
  const order: Order = {
    id: raw.id,
    plant: isStr(raw.plant) ? raw.plant : '',
    asset: raw.asset,
    command: raw.command as OrderCommand,
    status: raw.status as OrderStatus,
    requestedBy: { id: typeof by.id === 'string' ? by.id : '', email: typeof by.email === 'string' ? by.email : '' },
    requestedAt,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : requestedAt,
  };
  if (typeof raw.tag === 'string' && raw.tag) order.tag = raw.tag;
  else if (raw.tag === null) order.tag = null;
  if (isNum(raw.target)) order.target = raw.target;
  if (isNum(raw.completedAt)) order.completedAt = raw.completedAt;
  if (typeof raw.reason === 'string' && raw.reason.trim()) order.reason = raw.reason.trim().slice(0, 400);
  return order;
}

const quality = (q: unknown): Quality => (q === 'uncertain' || q === 'bad' ? q : 'good');

function assetState(v: unknown, fallbackTs: number): AssetState | null {
  if (!isObj(v)) return null;
  return { ts: isNum(v.ts) ? v.ts : fallbackTs, values: values(v.values), quality: quality(v.quality) };
}

/** Valida/sanea un mensaje del servidor. Devuelve null si no es utilizable. */
export function parseServerMessage(raw: unknown, now = Date.now()): ServerMessage | null {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(data)) return null;

  switch (data.type) {
    case 'snapshot': {
      if (!isStr(data.plant) || !isObj(data.assets)) return null;
      const assets: Record<string, AssetState> = {};
      for (const [id, s] of Object.entries(data.assets)) {
        const st = assetState(s, now);
        if (st) assets[id] = st;
      }
      return { type: 'snapshot', plant: data.plant, assets };
    }
    case 'telemetry': {
      if (!isStr(data.plant) || !isStr(data.asset)) return null;
      const st = assetState(data, now);
      if (!st) return null;
      // `ingestTs` (§13): reloj de la ingesta al recibir la muestra; base de la latencia extremo a extremo
      return { type: 'telemetry', plant: data.plant, asset: data.asset, ...st, ...(isNum(data.ingestTs) && data.ingestTs > 0 ? { ingestTs: data.ingestTs } : {}) };
    }
    case 'alarm': {
      if (!isStr(data.id) || !isStr(data.plant) || !isStr(data.asset) || !isStr(data.metric)) return null;
      if (data.severity !== 'warning' && data.severity !== 'critical') return null;
      if (data.state !== 'active' && data.state !== 'cleared') return null;
      const ev: AlarmEvent = {
        type: 'alarm',
        id: data.id,
        ruleId: isStr(data.ruleId) ? data.ruleId : '',
        plant: data.plant,
        asset: data.asset,
        metric: data.metric,
        severity: data.severity,
        state: data.state,
        value: isNum(data.value) ? data.value : 0,
        threshold: isNum(data.threshold) ? data.threshold : 0,
        ts: isNum(data.ts) ? data.ts : now,
        message: typeof data.message === 'string' ? data.message : '',
      };
      if (typeof data.acknowledged === 'boolean') ev.acknowledged = data.acknowledged;
      if (typeof data.kind === 'string' && KINDS.has(data.kind)) ev.kind = data.kind as AlarmKind;
      if (typeof data.lifecycle === 'string' && LIFECYCLES.has(data.lifecycle)) ev.lifecycle = data.lifecycle as AlarmLifecycle;
      const r = rationale(data.rationale);
      if (r) ev.rationale = r;
      if (isNum(data.shelvedUntil)) ev.shelvedUntil = data.shelvedUntil;
      if (typeof data.shelvedReason === 'string' && data.shelvedReason) ev.shelvedReason = data.shelvedReason.slice(0, 300);
      // `clearedAt` no está en el contrato: si el servidor lo envía se conserva (si no, el store usa `ts` del evento cleared)
      if (isNum(data.clearedAt)) (ev as AlarmEvent & { clearedAt?: number }).clearedAt = data.clearedAt;
      return ev;
    }
    case 'catalog':
      return isStr(data.plant) ? { type: 'catalog', plant: data.plant } : null;
    case 'order': {
      const order = parseOrder(data.order, now);
      return order ? { type: 'order', order } : null;
    }
    case 'time':
      // sincronización de reloj (§13): `{type:"time", t0, t1}`
      return isNum(data.t0) ? { type: 'time', t0: data.t0, ...(isNum(data.t1) ? { t1: data.t1 } : {}) } : null;
    default:
      return null;
  }
}
