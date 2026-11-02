/**
 * Store de la latencia medida (docs/architecture.md §13). El registro de muestras vive fuera del estado reactivo
 * (`LatencyTracker`); sólo las cifras agregadas (p50/p95, desfase de reloj) se publican, como mucho una vez por
 * segundo, para que la insignia del pie no re-renderice a cada pintado.
 *
 * Enganche de pintado: la escena 3D llama `paint()` en cada frame que dibuja (sin renders de React); si no hay
 * escena montada, `LatencyBadge` llama `paint('fallback')` desde su propio rAF.
 */
import { create } from 'zustand';
import { LatencyTracker } from '@/live/latency';

export interface LatencyData {
  /** reloj del servidor − reloj del cliente (ms); 0 mientras no hay sincronización */
  offset: number;
  rtt: number | null;
  synced: boolean;
  p50: number | null;
  p95: number | null;
  /** muestras en los últimos 60 s */
  count: number;
}

export interface LatencyActions {
  /** respuesta de `{type:'time'}`: `t0` envío, `t1` reloj del servidor, `t2` recepción */
  addSync(t0: number, t1: number, t2: number): void;
  noteIngest(asset: string, ingestTs: number): void;
  /** convierte lo pendiente en muestras con la hora de pintado; `fallback` se ignora si la escena pintó hace poco */
  paint(source?: 'scene' | 'fallback', now?: number): void;
  /** recalcula las cifras (p. ej. cada segundo, para que las viejas salgan de la ventana) */
  refresh(now?: number): void;
  reset(): void;
}

export type LatencyStore = LatencyData & LatencyActions;

const PUBLISH_EVERY_MS = 1000;
/** Si la escena pintó hace menos que esto, el respaldo no mide. */
const SCENE_GRACE_MS = 1500;

const tracker = new LatencyTracker();
let lastPublish = 0;

const empty = (): LatencyData => ({ offset: 0, rtt: null, synced: false, p50: null, p95: null, count: 0 });

export const useLatencyStore = create<LatencyStore>()((set, get) => {
  const publish = (now: number) => {
    lastPublish = now;
    const st = tracker.stats(now);
    const cur = get();
    if (cur.p50 === st.p50 && cur.p95 === st.p95 && cur.count === st.count && cur.synced === tracker.clock.synced) return;
    set({ p50: st.p50, p95: st.p95, count: st.count, offset: tracker.clock.offset, rtt: tracker.clock.rtt, synced: tracker.clock.synced });
  };
  return {
    ...empty(),
    addSync(t0, t1, t2) {
      tracker.clock.add(t0, t1, t2);
      set({ offset: tracker.clock.offset, rtt: tracker.clock.rtt, synced: true });
    },
    noteIngest(asset, ingestTs) {
      tracker.noteIngest(asset, ingestTs);
    },
    paint(source = 'scene', now = Date.now()) {
      if (typeof document !== 'undefined' && document.hidden) return; // pestaña oculta: no se pinta, no se mide
      if (source === 'scene') tracker.lastScenePaint = now;
      else if (now - tracker.lastScenePaint < SCENE_GRACE_MS) return;
      tracker.paint(now);
      if (now - lastPublish >= PUBLISH_EVERY_MS) publish(now);
    },
    refresh(now = Date.now()) {
      publish(now);
    },
    reset() {
      tracker.reset();
      lastPublish = 0;
      set(empty());
    },
  };
});
