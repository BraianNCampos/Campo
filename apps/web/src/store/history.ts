/**
 * Históricos en memoria (buffers circulares) por activo/métrica. Viven fuera de
 * React: los componentes los leen con `readSeries` y se avisan a ≤2 Hz.
 */

export interface Series {
  t: number[];
  v: number[];
}

class Ring {
  private t: Float64Array;
  private v: Float64Array;
  private head = 0; // posición de escritura
  size = 0;
  constructor(readonly capacity: number) {
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
  }
  lastT(): number {
    return this.size === 0 ? -Infinity : (this.t[(this.head - 1 + this.capacity) % this.capacity] ?? -Infinity);
  }
  push(t: number, v: number, minIntervalMs: number): void {
    const last = this.lastT();
    if (t - last < minIntervalMs && this.size > 0) {
      // dentro del intervalo mínimo: sobrescribe la última muestra (conserva el valor más reciente)
      if (t >= last) {
        const i = (this.head - 1 + this.capacity) % this.capacity;
        this.t[i] = t;
        this.v[i] = v;
      }
      return;
    }
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }
  read(maxPoints: number, sinceMs: number): Series {
    const n = Math.min(this.size, maxPoints);
    const t: number[] = [];
    const v: number[] = [];
    for (let k = n; k > 0; k--) {
      const i = (this.head - k + this.capacity) % this.capacity;
      const ti = this.t[i] as number;
      if (ti >= sinceMs) {
        t.push(ti);
        v.push(this.v[i] as number);
      }
    }
    return { t, v };
  }
}

export const HISTORY_CAPACITY = 720; // 6 min a 2 muestras/s
export const HISTORY_MIN_INTERVAL_MS = 500;
const NOTIFY_EVERY_MS = 500;

const rings = new Map<string, Ring>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const key = (asset: string, metric: string) => `${asset}\u0000${metric}`;

function scheduleNotify() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    version++;
    listeners.forEach((l) => l());
  }, NOTIFY_EVERY_MS);
}

export function pushSample(asset: string, metric: string, t: number, v: number): void {
  const k = key(asset, metric);
  let r = rings.get(k);
  if (!r) {
    r = new Ring(HISTORY_CAPACITY);
    rings.set(k, r);
  }
  r.push(t, v, HISTORY_MIN_INTERVAL_MS);
  scheduleNotify();
}

export function pushAssetValues(asset: string, ts: number, values: Record<string, number>): void {
  for (const [m, v] of Object.entries(values)) pushSample(asset, m, ts, v);
}

/** Últimas `maxPoints` muestras con t ≥ sinceMs. */
export function readSeries(asset: string, metric: string, maxPoints = HISTORY_CAPACITY, sinceMs = -Infinity): Series {
  return rings.get(key(asset, metric))?.read(maxPoints, sinceMs) ?? { t: [], v: [] };
}

export function clearHistory(): void {
  rings.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  version++;
  listeners.forEach((l) => l());
}

export const subscribeHistory = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
export const getHistoryVersion = () => version;
