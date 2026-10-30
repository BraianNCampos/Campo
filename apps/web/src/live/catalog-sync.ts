import type { AssetDef } from '@campo/shared';

/** Espera tras un aviso `{type:"catalog"}` antes de volver a pedir el catálogo (agrupa ráfagas de cambios). */
export const CATALOG_DEBOUNCE_MS = 300;

export interface CatalogSyncOptions<T = AssetDef> {
  load: () => Promise<T[]>;
  onLoaded: (list: T[]) => void;
  onError?: (e: unknown) => void;
  /** ¿Merece la pena reintentar tras este error? (red/servidor sí; 403/404 no) */
  shouldRetry?: (e: unknown) => boolean;
  debounceMs?: number;
  /** Espera antes del reintento nº `attempt` (1, 2…) */
  retryDelayMs?: (attempt: number) => number;
}

export interface CatalogSync {
  /** Pide el catálogo ya (si hay una petición en curso, repite al terminar). */
  refresh(): void;
  /** Pide el catálogo tras `debounceMs` sin nuevos avisos. */
  schedule(): void;
  dispose(): void;
}

/**
 * Mantiene el catálogo al día: una sola petición en vuelo, resultados en orden, *debounce* para los avisos
 * del WebSocket y reintento con espera creciente si falla (conserva el catálogo anterior).
 */
export function createCatalogSync<T = AssetDef>(opts: CatalogSyncOptions<T>): CatalogSync {
  const debounceMs = opts.debounceMs ?? CATALOG_DEBOUNCE_MS;
  const retryDelay = opts.retryDelayMs ?? ((n: number) => Math.min(30_000, 2000 * 2 ** (n - 1)));
  let disposed = false;
  let loading = false;
  let again = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  function refresh() {
    if (disposed) return;
    clear();
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    opts.load().then(
      (list) => {
        loading = false;
        if (disposed) return;
        attempts = 0;
        opts.onLoaded(list);
        if (again) {
          again = false;
          refresh();
        }
      },
      (e: unknown) => {
        loading = false;
        if (disposed) return;
        opts.onError?.(e);
        if (again) {
          again = false;
          refresh();
          return;
        }
        if (opts.shouldRetry && !opts.shouldRetry(e)) return;
        attempts++;
        timer = setTimeout(refresh, retryDelay(attempts));
      },
    );
  }

  return {
    refresh,
    schedule() {
      if (disposed) return;
      clear();
      timer = setTimeout(refresh, debounceMs);
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
