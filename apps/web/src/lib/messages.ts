import type { AlarmEvent, AlarmKind, AlarmLifecycle, AlarmRationale, AssetState, Quality, ServerMessage } from '@campo/shared';

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
      return st ? { type: 'telemetry', plant: data.plant, asset: data.asset, ...st } : null;
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
    default:
      return null;
  }
}
