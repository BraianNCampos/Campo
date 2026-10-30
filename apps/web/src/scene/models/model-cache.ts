import { getAdminApi } from '@/lib/admin';
import { disposeModel, parseGlb, type LoadedModel } from './glb';

export interface ModelCacheDeps {
  fetchBytes(modelId: string): Promise<ArrayBuffer>;
  parse(bytes: ArrayBuffer): Promise<LoadedModel>;
  dispose(model: LoadedModel): void;
  /** Espera tras soltar el último uso antes de liberar (evita recargar al remontar o en StrictMode) */
  graceMs?: number;
  /** Descargas+análisis simultáneos */
  maxConcurrent?: number;
}

export interface ModelLease {
  promise: Promise<LoadedModel>;
  /** Suelta este uso. Cuando no quedan usos el modelo se libera pasado `graceMs`. */
  release(): void;
}

interface Entry {
  id: string;
  promise: Promise<LoadedModel>;
  model?: LoadedModel;
  refs: number;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Caché en memoria de modelos GLB por id: una sola petición aunque varios activos lo pidan a la vez,
 * cuenta de usos y liberación de recursos de GPU (geometrías, materiales, texturas) al quedar sin uso.
 * Los errores no se cachean: el siguiente `acquire` vuelve a intentarlo.
 */
export class ModelCache {
  private entries = new Map<string, Entry>();
  private queue: (() => void)[] = [];
  private running = 0;
  private readonly graceMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly deps: ModelCacheDeps) {
    this.graceMs = deps.graceMs ?? 3000;
    this.maxConcurrent = deps.maxConcurrent ?? 2;
  }

  acquire(id: string): ModelLease {
    let entry = this.entries.get(id);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    } else {
      entry = this.start(id);
    }
    entry.refs++;
    const e = entry;
    let released = false;
    return {
      promise: e.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--e.refs <= 0) e.timer = setTimeout(() => this.evict(e), this.graceMs);
      },
    };
  }

  /** Entradas cargadas o cargándose (para diagnóstico y pruebas). */
  get size(): number {
    return this.entries.size;
  }

  /** Libera todo (cambio de planta o cierre de la escena). */
  clear(): void {
    for (const e of [...this.entries.values()]) this.evict(e);
  }

  private start(id: string): Entry {
    const entry: Entry = { id, refs: 0, cancelled: false, promise: undefined as unknown as Promise<LoadedModel> };
    entry.promise = this.schedule(async () => {
      if (entry.cancelled) throw new Error('cancelado');
      const model = await this.deps.parse(await this.deps.fetchBytes(id));
      if (entry.cancelled) {
        this.deps.dispose(model);
        throw new Error('cancelado');
      }
      entry.model = model;
      return model;
    });
    entry.promise.catch(() => {
      // los fallos no se cachean
      if (this.entries.get(id) === entry) this.entries.delete(id);
    });
    this.entries.set(id, entry);
    return entry;
  }

  private evict(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.cancelled = true;
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    if (entry.model) this.deps.dispose(entry.model);
    entry.model = undefined;
  }

  private schedule<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        job().then(resolve, reject).finally(() => {
          this.running--;
          this.queue.shift()?.();
        });
      };
      if (this.running < this.maxConcurrent) run();
      else this.queue.push(run);
    });
  }
}

/** Caché global de la aplicación: descarga con el cliente de administración (Bearer, 401 → /login). */
export const modelCache = new ModelCache({
  fetchBytes: (id) => getAdminApi().downloadModel(id),
  parse: parseGlb,
  dispose: disposeModel,
});
