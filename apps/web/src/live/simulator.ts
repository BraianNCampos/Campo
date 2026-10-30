import type { AlarmEvent, AssetState, ServerMessage, SnapshotMessage } from '@campo/shared';

/** PRNG determinista (mulberry32) para que la simulación sea testeable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur < target ? Math.min(target, cur + rate * dt) : Math.max(target, cur - rate * dt);

interface TankSim {
  id: string;
  level: number;
  role: 'source' | 'sink';
  phase: number;
  tempBase: number;
  tempAmp: number;
}
interface PumpSim {
  id: string;
  from: string;
  to: string;
  valve: string;
  on: boolean;
  rpm: number;
}
interface ValveSim {
  id: string;
  position: number;
  openTo: number;
}

interface Rule {
  ruleId: string;
  metric: string;
  kind: 'tank';
  test: (v: number) => boolean;
  /** el valor debe volver aquí para limpiar (histéresis) */
  clearTest: (v: number) => boolean;
  threshold: number;
  severity: AlarmEvent['severity'];
  text: string;
  unit: string;
}

export const DEMO_RULES: Rule[] = [
  { ruleId: 'level-high', metric: 'level', kind: 'tank', test: (v) => v > 90, clearTest: (v) => v <= 88, threshold: 90, severity: 'critical', text: 'Nivel alto', unit: '%' },
  { ruleId: 'level-low', metric: 'level', kind: 'tank', test: (v) => v < 10, clearTest: (v) => v >= 12, threshold: 10, severity: 'warning', text: 'Nivel bajo', unit: '%' },
  { ruleId: 'temp-high', metric: 'temp', kind: 'tank', test: (v) => v > 35, clearTest: (v) => v <= 34, threshold: 35, severity: 'warning', text: 'Temperatura alta', unit: '°C' },
];

/**
 * Planta demo: tk-01/tk-02 (origen) → valve → pump → tk-03/tk-04 (destino).
 * Arranca en un estado que genera alarmas en pocos segundos (tk-04 sube sobre 90,
 * tk-02 baja de 10) y después se autorregula con histéresis.
 */
export class PlantSimulator {
  private t = 0;
  private rnd: () => number;
  private tanks: TankSim[] = [
    { id: 'tk-01', level: 55, role: 'source', phase: 0.3, tempBase: 18, tempAmp: 2.5 },
    { id: 'tk-02', level: 12, role: 'source', phase: 1.7, tempBase: 20, tempAmp: 3 },
    { id: 'tk-03', level: 60, role: 'sink', phase: 2.9, tempBase: 25, tempAmp: 7 },
    { id: 'tk-04', level: 87, role: 'sink', phase: 4.1, tempBase: 21, tempAmp: 4 },
  ];
  private pumps: PumpSim[] = [
    { id: 'pump-01', from: 'tk-01', to: 'tk-03', valve: 'valve-01', on: true, rpm: 1450 },
    { id: 'pump-02', from: 'tk-02', to: 'tk-04', valve: 'valve-02', on: true, rpm: 1450 },
  ];
  private valves: ValveSim[] = [
    { id: 'valve-01', position: 100, openTo: 100 },
    { id: 'valve-02', position: 85, openTo: 85 },
  ];
  private temps = new Map<string, number>();
  private pumpCurrent = new Map<string, number>();
  private active = new Map<string, AlarmEvent>(); // `${asset}:${rule}` → alarma activa
  private alarmSeq = 0;

  private speed: number;

  /**
   * `speed` escala el tiempo de la planta (1 = ritmo original, pensado para tests; el modo demo usa menos para
   * que los caudales y las tasas de cambio tengan órdenes de magnitud creíbles). `levels` pisa niveles iniciales.
   */
  constructor(
    private plant = 'demo',
    seed = 42,
    opts: { speed?: number; levels?: Record<string, number> } = {},
  ) {
    this.speed = opts.speed ?? 1;
    this.rnd = mulberry32(seed);
    for (const tk of this.tanks) tk.level = opts.levels?.[tk.id] ?? tk.level;
    this.tanks.forEach((tk) => this.temps.set(tk.id, this.tempOf(tk)));
  }

  private noise(amp: number) {
    return (this.rnd() - 0.5) * 2 * amp;
  }
  private tempOf(tk: TankSim) {
    return tk.tempBase + tk.tempAmp * Math.sin(this.t / 30 + tk.phase) + this.noise(0.08);
  }
  private tank(id: string) {
    return this.tanks.find((x) => x.id === id) as TankSim;
  }

  private assetStates(now: number): Record<string, AssetState> {
    const out: Record<string, AssetState> = {};
    for (const tk of this.tanks)
      out[tk.id] = { ts: now, quality: 'good', values: { level: round(tk.level, 2), temp: round(this.temps.get(tk.id) ?? 0, 2) } };
    for (const p of this.pumps)
      out[p.id] = { ts: now, quality: 'good', values: { rpm: round(p.rpm, 0), current: round(this.pumpCurrent.get(p.id) ?? 0, 2) } };
    for (const v of this.valves) out[v.id] = { ts: now, quality: 'good', values: { position: round(v.position, 1) } };
    return out;
  }

  snapshot(now: number): SnapshotMessage {
    this.pumps.forEach((p) => this.pumpCurrent.set(p.id, (p.rpm / 1450) * 11.2));
    return { type: 'snapshot', plant: this.plant, assets: this.assetStates(now) };
  }

  /** Avanza `dtSec` segundos y devuelve telemetría de todos los activos + cambios de alarma. */
  step(dtSec: number, now: number): ServerMessage[] {
    const dt = clamp(dtSec, 0, 1) * this.speed;
    this.t += dt;

    // control de bombas con histéresis y disparo por mínimo/máximo extremo
    for (const p of this.pumps) {
      const src = this.tank(p.from).level;
      const dst = this.tank(p.to).level;
      if (p.on && (src < 5 || dst > 97)) p.on = false;
      else if (!p.on && src > 25 && dst < 75) p.on = true;
      p.rpm = approach(p.rpm, p.on ? 1450 : 0, 600, dt);
      const jitter = p.rpm > 50 ? this.noise(6) : 0;
      p.rpm = Math.max(0, p.rpm + jitter * dt * 4);
      this.pumpCurrent.set(p.id, Math.max(0, (p.rpm / 1450) * 11.2 + (p.rpm > 50 ? this.noise(0.25) : 0)));
      const valve = this.valves.find((v) => v.id === p.valve) as ValveSim;
      valve.position = approach(valve.position, p.on ? valve.openTo : 0, 20, dt);
    }

    // balance de tanques (% por segundo)
    const flow = new Map<string, number>();
    for (const p of this.pumps) {
      const valve = this.valves.find((v) => v.id === p.valve) as ValveSim;
      const q = (p.rpm / 1450) * (valve.position / 100) * 1.1;
      flow.set(p.from, (flow.get(p.from) ?? 0) - q);
      flow.set(p.to, (flow.get(p.to) ?? 0) + q);
    }
    for (const tk of this.tanks) {
      const ext =
        tk.role === 'source'
          ? 0.3 + 0.2 * Math.sin(this.t / 17 + tk.phase) // aporte de proceso
          : -(0.3 + 0.2 * Math.sin(this.t / 23 + tk.phase)); // consumo
      tk.level = clamp(tk.level + (ext + (flow.get(tk.id) ?? 0)) * dt + this.noise(0.01), 0, 100);
      this.temps.set(tk.id, this.tempOf(tk));
    }

    const msgs: ServerMessage[] = [];
    const states = this.assetStates(now);
    for (const [asset, st] of Object.entries(states)) {
      msgs.push({ type: 'telemetry', plant: this.plant, asset, ...st });
    }
    msgs.push(...this.evaluateAlarms(now));
    return msgs;
  }

  private evaluateAlarms(now: number): AlarmEvent[] {
    const out: AlarmEvent[] = [];
    for (const tk of this.tanks) {
      for (const rule of DEMO_RULES) {
        const v = rule.metric === 'level' ? tk.level : (this.temps.get(tk.id) ?? 0);
        const key = `${tk.id}:${rule.ruleId}`;
        const cur = this.active.get(key);
        if (!cur && rule.test(v)) {
          const ev: AlarmEvent = {
            type: 'alarm',
            id: `alm-${++this.alarmSeq}`,
            ruleId: rule.ruleId,
            plant: this.plant,
            asset: tk.id,
            metric: rule.metric,
            severity: rule.severity,
            state: 'active',
            value: round(v, 1),
            threshold: rule.threshold,
            ts: now,
            message: `${rule.text} en ${tk.id}: ${round(v, 1)} ${rule.unit} (umbral ${rule.threshold} ${rule.unit})`,
            acknowledged: false,
          };
          this.active.set(key, ev);
          out.push(ev);
        } else if (cur && rule.clearTest(v)) {
          this.active.delete(key);
          out.push({ ...cur, state: 'cleared', value: round(v, 1), ts: now });
        }
      }
    }
    return out;
  }
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
