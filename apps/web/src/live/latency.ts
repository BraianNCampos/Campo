/**
 * Latencia extremo a extremo medida (docs/architecture.md §13). Lógica pura y testeable (sin React ni red):
 *
 * - Sincronización de reloj: el cliente envía `{type:'time', t0}`; el servidor responde `{type:'time', t0, t1}`.
 *   `offset = t1 − (t0 + rtt/2)` (reloj del servidor − reloj del cliente); se conserva la muestra de MENOR RTT de las
 *   últimas 6 (la menos afectada por la cola de red).
 * - Latencia de una muestra de telemetría = `(Date.now() + offset) − ingestTs`, medida AL PINTAR (no al recibir).
 * - Estadística: p50/p95 de los últimos 60 s. Umbrales: < 500 ms normal, 500–2000 ámbar, > 2000 rojo.
 */

/** Cada cuánto se repite la sincronización de reloj. */
export const TIME_SYNC_INTERVAL_MS = 10_000;
/** Cuántas muestras de sincronización se conservan para elegir la de menor RTT. */
export const OFFSET_WINDOW = 6;
/** Ventana de la estadística. */
export const STATS_WINDOW_MS = 60_000;
export const LATENCY_WARN_MS = 500;
export const LATENCY_CRIT_MS = 2000;
/** Latencias fuera de este rango se descartan (reloj desfasado o dato de otra época). */
const MIN_PLAUSIBLE_MS = -1000;
const MAX_PLAUSIBLE_MS = 3_600_000;
/** Tope de muestras conservadas (memoria acotada incluso a ráfagas altas). */
const MAX_SAMPLES = 4000;

export interface SyncSample {
  rtt: number;
  /** reloj del servidor − reloj del cliente (ms) */
  offset: number;
}

/** Muestra de sincronización: `t0` envío, `t1` reloj del servidor, `t2` recepción (reloj del cliente). */
export function syncSample(t0: number, t1: number, t2: number): SyncSample {
  const rtt = Math.max(0, t2 - t0);
  return { rtt, offset: t1 - (t0 + rtt / 2) };
}

/** Elige la muestra de menor RTT entre las últimas `OFFSET_WINDOW`. */
export function bestSync(samples: readonly SyncSample[]): SyncSample | null {
  let best: SyncSample | null = null;
  for (const s of samples.slice(-OFFSET_WINDOW)) if (!best || s.rtt < best.rtt) best = s;
  return best;
}

/** Estimador de desfase de reloj con ventana deslizante de 6 muestras. */
export class ClockSync {
  private samples: SyncSample[] = [];

  add(t0: number, t1: number, t2: number): SyncSample {
    const s = syncSample(t0, t1, t2);
    this.samples.push(s);
    if (this.samples.length > OFFSET_WINDOW) this.samples.shift();
    return s;
  }

  get best(): SyncSample | null {
    return bestSync(this.samples);
  }
  get offset(): number {
    return this.best?.offset ?? 0;
  }
  get rtt(): number | null {
    return this.best?.rtt ?? null;
  }
  get synced(): boolean {
    return this.samples.length > 0;
  }
  reset(): void {
    this.samples = [];
  }
}

/** Percentil por rango más cercano sobre una lista ya ordenada ascendente. `null` si está vacía. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

export type LatencyLevel = 'ok' | 'warn' | 'crit';

/** < 500 ms normal; 500–2000 ámbar; > 2000 rojo. */
export function latencyLevel(ms: number): LatencyLevel {
  if (ms > LATENCY_CRIT_MS) return 'crit';
  if (ms >= LATENCY_WARN_MS) return 'warn';
  return 'ok';
}

export interface LatencyStats {
  p50: number | null;
  p95: number | null;
  count: number;
}

/** Latencia de una muestra: `(ahora + offset) − ingestTs`. */
export const sampleLatency = (now: number, offset: number, ingestTs: number): number => now + offset - ingestTs;

/**
 * Registro de latencias. `noteIngest` apunta el último `ingestTs` recibido por activo (barato, al recibir); `paint`
 * convierte lo pendiente en muestras con la hora de pintado. Estado acotado: un pendiente por activo y a lo sumo
 * `MAX_SAMPLES` muestras en 60 s.
 */
export class LatencyTracker {
  readonly clock = new ClockSync();
  private pending = new Map<string, number>();
  private samples: { at: number; ms: number }[] = [];
  /** instante del último pintado de la escena (para que el respaldo no duplique) */
  lastScenePaint = 0;

  noteIngest(asset: string, ingestTs: number): void {
    if (!Number.isFinite(ingestTs)) return;
    this.pending.set(asset, ingestTs);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Pinta: cada pendiente pasa a muestra. Sin sincronización de reloj todavía no se mide (se conserva el pendiente). Devuelve cuántas muestras añadió. */
  paint(now: number): number {
    if (!this.clock.synced || this.pending.size === 0) return 0;
    const offset = this.clock.offset;
    let n = 0;
    for (const ts of this.pending.values()) {
      const ms = sampleLatency(now, offset, ts);
      if (ms < MIN_PLAUSIBLE_MS || ms > MAX_PLAUSIBLE_MS) continue;
      this.samples.push({ at: now, ms: Math.max(0, ms) });
      n++;
    }
    this.pending.clear();
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    return n;
  }

  /** p50/p95 de los últimos 60 s (descarta lo más viejo). */
  stats(now: number): LatencyStats {
    const from = now - STATS_WINDOW_MS;
    let cut = 0;
    while (cut < this.samples.length && (this.samples[cut] as { at: number }).at < from) cut++;
    if (cut > 0) this.samples.splice(0, cut);
    const sorted = this.samples.map((s) => s.ms).sort((a, b) => a - b);
    return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), count: sorted.length };
  }

  reset(): void {
    this.clock.reset();
    this.pending.clear();
    this.samples = [];
    this.lastScenePaint = 0;
  }
}
