import type { AlarmEvent, AssetState, ServerMessage, SnapshotMessage } from '@campo/shared';

/** Mensajes acumulados entre dos frames, ya coalescidos. */
export interface Batch {
  snapshot: SnapshotMessage | null;
  /** último estado por activo (valores fusionados) */
  telemetry: Record<string, AssetState>;
  /** alarmas en orden de llegada; la última por id gana */
  alarms: AlarmEvent[];
  /** nº de mensajes que se fusionaron en este lote */
  count: number;
}

export interface Scheduler {
  request(cb: () => void): () => void;
}

/**
 * requestAnimationFrame con red de seguridad: en pestañas ocultas rAF no
 * dispara, así que un setTimeout evita que el lote crezca sin límite.
 */
export const rafScheduler: Scheduler = {
  request(cb) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      cb();
    };
    const raf = requestAnimationFrame(run);
    const timer = setTimeout(run, 250);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  },
};

export function emptyBatch(): Batch {
  return { snapshot: null, telemetry: {}, alarms: [], count: 0 };
}

export function addToBatch(b: Batch, msg: ServerMessage): void {
  b.count++;
  switch (msg.type) {
    case 'snapshot':
      // un snapshot sustituye todo el estado: lo anterior ya no importa
      b.snapshot = msg;
      b.telemetry = {};
      break;
    case 'telemetry': {
      const prev = b.telemetry[msg.asset];
      if (prev && msg.ts < prev.ts) break;
      b.telemetry[msg.asset] = {
        ts: msg.ts,
        quality: msg.quality,
        values: prev ? { ...prev.values, ...msg.values } : msg.values,
      };
      break;
    }
    case 'alarm': {
      const i = b.alarms.findIndex((a) => a.id === msg.id);
      if (i >= 0) b.alarms.splice(i, 1);
      b.alarms.push(msg);
      break;
    }
  }
}

export interface Batcher {
  push(msg: ServerMessage): void;
  flushNow(): void;
  dispose(): void;
}

/** Acumula mensajes y los entrega como un único lote por frame. */
export function createBatcher(flush: (b: Batch) => void, scheduler: Scheduler = rafScheduler): Batcher {
  let batch = emptyBatch();
  let cancel: (() => void) | null = null;

  const run = () => {
    cancel = null;
    if (batch.count === 0) return;
    const b = batch;
    batch = emptyBatch();
    flush(b);
  };

  return {
    push(msg) {
      addToBatch(batch, msg);
      if (!cancel) cancel = scheduler.request(run);
    },
    flushNow() {
      cancel?.();
      run();
    },
    dispose() {
      cancel?.();
      cancel = null;
      batch = emptyBatch();
    },
  };
}
