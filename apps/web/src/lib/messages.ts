import type { AlarmEvent, AssetState, Quality, ServerMessage } from '@campo/shared';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function values(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (isNum(x)) out[k] = x;
  return out;
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
      return ev;
    }
    default:
      return null;
  }
}
