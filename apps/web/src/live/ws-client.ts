import type { ServerMessage } from '@campo/shared';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from '@/lib/backoff';
import { parseServerMessage } from '@/lib/messages';
import type { ConnectionStatus } from '@/store/live-store';
import { useLatencyStore } from '@/store/latency-store';
import { TIME_SYNC_INTERVAL_MS } from './latency';

/** Subconjunto de WebSocket que usamos (permite inyectar un falso en tests). */
export interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number): void;
  /** enviar texto (la sincronización de reloj); opcional para dobles de prueba mínimos */
  send?(data: string): void;
}
export type WsFactory = (url: string) => WsLike;

/** Códigos de cierre que indican credenciales inválidas (no tiene sentido reintentar). */
export const AUTH_CLOSE_CODES = new Set([1008, 4001, 4401, 4403]);

/** Lo que el cliente necesita del registro de latencia (inyectable en tests; por defecto, `latency-store`). */
export interface LatencySink {
  addSync(t0: number, t1: number, t2: number): void;
  noteIngest(asset: string, ingestTs: number): void;
  reset(): void;
}

const defaultLatencySink = (): LatencySink => useLatencyStore.getState();

export interface LiveClientOptions {
  /** URL a conectar; null si falta credencial → estado 'unauthorized' */
  buildUrl: () => string | null;
  onMessage: (m: ServerMessage) => void;
  onStatus: (status: ConnectionStatus, attempt: number) => void;
  createSocket?: WsFactory;
  backoff?: BackoffOptions;
  rng?: () => number;
  /** reloj del cliente (ms); por defecto `Date.now` */
  now?: () => number;
  /** período de la sincronización de reloj (ms); por defecto 10 s (§13) */
  timeSyncMs?: number;
  latency?: LatencySink;
}

export class LiveClient {
  private ws: WsLike | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private readonly backoff: BackoffOptions;
  private readonly rng: () => number;
  private readonly create: WsFactory;

  constructor(private readonly opts: LiveClientOptions) {
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.rng = opts.rng ?? Math.random;
    this.create = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.detach();
    (this.opts.latency ?? defaultLatencySink()).reset();
    this.opts.onStatus('idle', 0);
  }

  /** Reintenta ya (p. ej. al volver la red) saltándose el backoff pendiente. */
  retryNow(): void {
    if (this.stopped || this.ws) return;
    this.clearTimer();
    this.connect();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearSync() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  /** Envía `{type:'time', t0}` con el reloj del cliente. */
  private sendTime(ws: WsLike) {
    try {
      ws.send?.(JSON.stringify({ type: 'time', t0: (this.opts.now ?? Date.now)() }));
    } catch {
      /* conexión cerrándose: el cierre llega por onclose */
    }
  }

  private detach() {
    this.clearSync();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* ya cerrado */
      }
    }
  }

  private connect() {
    const url = this.opts.buildUrl();
    if (!url) {
      this.stopped = true;
      this.opts.onStatus('unauthorized', 0);
      return;
    }
    this.opts.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting', this.attempt);
    let ws: WsLike;
    try {
      ws = this.create(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.opts.onStatus('open', 0);
      // sincronización de reloj (§13): al conectar y cada 10 s; cada conexión empieza sin muestras previas
      (this.opts.latency ?? defaultLatencySink()).reset();
      this.sendTime(ws);
      this.clearSync();
      this.syncTimer = setInterval(() => this.sendTime(ws), this.opts.timeSyncMs ?? TIME_SYNC_INTERVAL_MS);
    };
    ws.onmessage = (ev) => {
      const t2 = (this.opts.now ?? Date.now)();
      let raw: unknown = ev.data;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch {
          return;
        }
      }
      const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
      if (rec?.type === 'time') {
        // respuesta de sincronización: se procesa aquí y no llega a onMessage
        if (typeof rec.t0 === 'number' && typeof rec.t1 === 'number' && Number.isFinite(rec.t0) && Number.isFinite(rec.t1)) {
          (this.opts.latency ?? defaultLatencySink()).addSync(rec.t0, rec.t1, t2);
        }
        return;
      }
      const msg = parseServerMessage(raw);
      if (!msg) return;
      if (msg.type === 'telemetry' && typeof rec?.ingestTs === 'number') {
        (this.opts.latency ?? defaultLatencySink()).noteIngest(msg.asset, rec.ingestTs);
      }
      if (msg.type === 'snapshot') this.attempt = 0; // conexión sana: reinicia el backoff
      this.opts.onMessage(msg);
    };
    ws.onerror = () => {
      /* el cierre llega después; se gestiona en onclose */
    };
    ws.onclose = (ev) => {
      this.clearSync();
      this.ws = null;
      if (this.stopped) return;
      if (AUTH_CLOSE_CODES.has(ev.code)) {
        this.stopped = true;
        this.opts.onStatus('unauthorized', 0);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, this.backoff, this.rng);
    this.attempt++;
    this.opts.onStatus('reconnecting', this.attempt);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
