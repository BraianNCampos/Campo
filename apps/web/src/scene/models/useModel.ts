'use client';

import { useEffect, useState } from 'react';
import { modelIdOf } from '@/lib/catalog';
import type { LoadedModel } from './glb';
import { modelCache } from './model-cache';

export type ModelState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; model: LoadedModel }
  | { status: 'error'; reason: string };

const reasonOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'No se pudo cargar el modelo.');

/**
 * Modelo GLB de una referencia `model:<uuid>` (carga perezosa, caché compartida). `none` si no hay
 * referencia a un modelo (procedural); `loading` mientras llega; `error` si falla (se usa el procedural).
 */
export function useModel(ref: string | null): ModelState {
  const id = modelIdOf(ref);
  const [done, setDone] = useState<{ id: string; state: ModelState } | null>(null);

  useEffect(() => {
    if (!id) return;
    const lease = modelCache.acquire(id);
    let live = true;
    lease.promise.then(
      (model) => live && setDone({ id, state: { status: 'ready', model } }),
      (e: unknown) => live && setDone({ id, state: { status: 'error', reason: reasonOf(e) } }),
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [id]);

  if (!id) return { status: 'none' };
  return done?.id === id ? done.state : { status: 'loading' };
}
