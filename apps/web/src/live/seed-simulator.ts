import { METRICS, type AlarmEvent, type AssetDef, type AssetState, type Limit, type ServerMessage, type SnapshotMessage } from '@campo/shared';
import { DEMO_ASSETS, DEMO_LIMITS } from '@/lib/demo-seed';
import { mulberry32 } from './simulator';

/**
 * Telemetría simulada de los activos de los clientes demo (`DEMO_ASSETS`, docs/architecture.md §11.2–§11.3), salvo los
 * que ya mueve `PlantSimulator` (tanques, bombas y válvulas de `demo`). Cada tipo genera sus métricas con ciclos suaves,
 * contadores monótonos, cambios de estado ocasionales y excursiones periódicas hacia los límites de `DEMO_LIMITS`, de
 * modo que a lo largo de unos minutos haya valores «cerca del límite» y alarmas. También emite las alarmas (con histéresis).
 * El tiempo está acelerado en los contadores (kWh, m³) para que se vean avanzar.
 */

export const COUNTER_SPEEDUP = 30;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (x: number) => x * x * (3 - 2 * x);
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Excursión periódica: sube en `rise` s, se mantiene `hold`, baja en `fall`; se repite cada `period` desde `start`. Devuelve 0..1. */
export function bump(t: number, b: { start: number; period: number; rise: number; hold: number; fall: number }): number {
  if (t < b.start) return 0;
  const p = (t - b.start) % b.period;
  if (p < b.rise) return smooth(p / b.rise);
  if (p < b.rise + b.hold) return 1;
  if (p < b.rise + b.hold + b.fall) return 1 - smooth((p - b.rise - b.hold) / b.fall);
  return 0;
}

type Values = Record<string, number>;
interface Gen {
  def: AssetDef;
  step(t: number, dt: number): Values;
}

const num = (def: AssetDef, key: string, fallback: number): number => {
  const v = (def.metadata as Record<string, unknown>)[key];
  return typeof v === 'number' && v > 0 ? v : fallback;
};

function makeGen(def: AssetDef, rnd: () => number, index: number): Gen {
  const h = hash(def.id);
  const phase = (h % 628) / 100;
  const noise = (a: number) => (rnd() - 0.5) * 2 * a;
  const start = 25 + (h % 50) + index * 7;
  switch (def.type) {
    case 'climate': {
      const warm = /02|dep/.test(def.id);
      const tBase = warm ? 24.5 : 7.8;
      const hBase = warm ? 52 : 66;
      const tb = { start: start + 15, period: 330, rise: 60, hold: 25, fall: 60 };
      const hb = { start, period: 300, rise: 40, hold: 20, fall: 50 };
      return {
        def,
        step: (t) => ({
          temp: round(tBase + (warm ? 1.2 : 0.5) * Math.sin(t / 70 + phase) + (warm ? 7 : 0.4) * bump(t, tb) + noise(0.05), 2),
          humidity: round(clamp(hBase + 4 * Math.sin(t / 55 + phase) + (warm ? 3 : 17) * bump(t, hb) + noise(0.3), 0, 100), 1),
        }),
      };
    }
    case 'energy': {
      const c = num(def, 'contractedKw', 100);
      const eb = { start: start + 20, period: 260 + (h % 60), rise: 30, hold: 25, fall: 35 };
      let kwh = 380_000 + (h % 90_000);
      return {
        def,
        step: (t, dt) => {
          const load = 0.56 + 0.07 * Math.sin(t / 60 + phase) + 0.45 * bump(t, eb);
          const kw = Math.max(0, c * load + noise(c * 0.006));
          kwh += (kw * dt * COUNTER_SPEEDUP) / 3600;
          return { kw: round(kw, 1), kwh: round(kwh, 1), pf: round(clamp(0.95 - 0.06 * (load - 0.6) + noise(0.004), 0.7, 1), 3) };
        },
      };
    }
    case 'gas': {
      let total = 18_000 + (h % 5_000);
      return {
        def,
        step: (t, dt) => {
          const flow = Math.max(0, 36 + 7 * Math.sin(t / 90 + phase) + noise(0.5));
          total += (flow * dt * COUNTER_SPEEDUP) / 3600;
          return { flow: round(flow, 2), total: round(total, 2) };
        },
      };
    }
    case 'machine': {
      let on = h % 3 !== 0;
      let next = 40 + (h % 80);
      return {
        def,
        step: (t) => {
          if (t >= next) {
            on = !on;
            next = t + (on ? 90 + rnd() * 150 : 25 + rnd() * 45);
          }
          return { state: on ? 1 : 0 };
        },
      };
    }
    case 'pressure': {
      const pb = { start: 70, period: 360, rise: 12, hold: 14, fall: 20 };
      return { def, step: (t) => ({ pressure: round(6.1 + 0.35 * Math.sin(t / 45 + phase) + 2.6 * bump(t, pb) + noise(0.03), 2) }) };
    }
    case 'flow':
      return { def, step: (t) => ({ flow: round(Math.max(0, 54 + 9 * Math.sin(t / 110 + phase) + noise(0.6)), 2) }) };
    case 'tank': {
      // llena hasta ~93 % y vacía hasta ~8 %: cruza los límites en cada extremo
      const filling0 = index % 2 === 0;
      let filling = filling0;
      let level = filling0 ? 82 : 20;
      return {
        def,
        step: (t, dt) => {
          level += (filling ? 0.35 : -0.35) * dt + noise(0.01);
          if (filling && level >= 93) filling = false;
          if (!filling && level <= 8) filling = true;
          return { level: round(clamp(level, 0, 100), 2), temp: round(19 + 1.5 * Math.sin(t / 80 + phase) + noise(0.05), 2) };
        },
      };
    }
    case 'pump':
      return { def, step: () => ({ rpm: round(1450 + noise(15), 0), current: round(11.2 + noise(0.3), 2) }) };
    case 'valve':
      return { def, step: () => ({ position: 100 }) };
    default:
      return { def, step: (t) => ({ value: round(10 * Math.sin(t / 30 + phase), 2) }) };
  }
}

const OPERATOR_TEXT: Record<Limit['operator'], string> = { gt: 'alto', gte: 'alto', lt: 'bajo', lte: 'bajo' };
const beyond = (v: number, l: Limit) => (l.operator === 'gt' ? v > l.threshold : l.operator === 'gte' ? v >= l.threshold : l.operator === 'lt' ? v < l.threshold : v <= l.threshold);
const cleared = (v: number, l: Limit) => {
  const hys = Math.max(Math.abs(l.threshold) * 0.02, 0.3);
  return l.operator === 'gt' || l.operator === 'gte' ? v <= l.threshold - hys : v >= l.threshold + hys;
};

export interface SeedSimOptions {
  /** activos que se saltan (los mueve otro simulador) */
  skip?: (def: AssetDef) => boolean;
}

export class SeedSimulator {
  private gens: Gen[];
  private limits: Limit[];
  private t = 0;
  private last = new Map<string, Values>();
  private active = new Map<string, AlarmEvent>();
  private seq = 0;

  constructor(
    private plant: string,
    seed = 7,
    opts: SeedSimOptions = {},
  ) {
    const rnd = mulberry32(seed);
    const defs = (DEMO_ASSETS[plant] ?? []).filter((d) => !opts.skip?.(d));
    this.gens = defs.map((d, i) => makeGen(d, rnd, i));
    const ids = new Set(defs.map((d) => d.id));
    this.limits = (DEMO_LIMITS[plant] ?? []).filter((l) => ids.has(l.asset));
    for (const g of this.gens) this.last.set(g.def.id, g.step(0, 0));
  }

  get assetIds(): string[] {
    return this.gens.map((g) => g.def.id);
  }

  private states(now: number): Record<string, AssetState> {
    const out: Record<string, AssetState> = {};
    for (const [id, values] of this.last) out[id] = { ts: now, quality: 'good', values: { ...values } };
    return out;
  }

  snapshot(now: number): SnapshotMessage {
    return { type: 'snapshot', plant: this.plant, assets: this.states(now) };
  }

  step(dtSec: number, now: number): ServerMessage[] {
    const dt = clamp(dtSec, 0, 1);
    this.t += dt;
    for (const g of this.gens) this.last.set(g.def.id, g.step(this.t, dt));
    const msgs: ServerMessage[] = Object.entries(this.states(now)).map(([asset, st]) => ({ type: 'telemetry', plant: this.plant, asset, ...st }));
    msgs.push(...this.evaluate(now));
    return msgs;
  }

  private evaluate(now: number): AlarmEvent[] {
    const out: AlarmEvent[] = [];
    for (const l of this.limits) {
      const v = this.last.get(l.asset)?.[l.metric];
      if (v === undefined) continue;
      const key = `${l.asset}:${l.metric}:${l.operator}:${l.severity}`;
      const cur = this.active.get(key);
      if (!cur && beyond(v, l)) {
        const def = this.gens.find((g) => g.def.id === l.asset)?.def;
        const m = METRICS[l.metric];
        const unit = m?.unit ? ` ${m.unit}` : '';
        const ev: AlarmEvent = {
          type: 'alarm', id: `sim-${this.plant}-${++this.seq}`, ruleId: key, plant: this.plant, asset: l.asset, metric: l.metric,
          severity: l.severity, state: 'active', value: round(v, 1), threshold: l.threshold, ts: now,
          message: `${m?.label ?? l.metric} ${OPERATOR_TEXT[l.operator]} en ${def?.name ?? l.asset}: ${round(v, 1)}${unit} (umbral ${l.threshold}${unit})`,
          acknowledged: false,
        };
        this.active.set(key, ev);
        out.push(ev);
      } else if (cur && cleared(v, l)) {
        this.active.delete(key);
        out.push({ ...cur, state: 'cleared', value: round(v, 1), ts: now });
      }
    }
    return out;
  }
}
