'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** Actualiza los datos en local (p. ej. tras crear/editar) sin volver a pedirlos. */
  setData: (updater: (prev: T | undefined) => T | undefined) => void;
}

/** Carga asíncrona con estados de carga/error y recarga; ignora respuestas de cargas obsoletas. */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): Loaded<T> {
  const [tick, setTick] = useState(0);
  const key = [tick, ...deps].map(String).join('\u0000');
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key: '' });
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let cancelled = false;
    loaderRef.current().then(
      (data) => {
        if (!cancelled) setState({ key, data });
      },
      (error: unknown) => {
        if (!cancelled) setState((prev) => ({ key, data: prev.data, error }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  const loading = state.key !== key;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback(
    (updater: (prev: T | undefined) => T | undefined) => setState((prev) => ({ ...prev, data: updater(prev.data) })),
    [],
  );
  return { data: state.data, error: loading ? null : state.error, loading, reload, setData };
}

/** Envío de formularios/acciones: `busy` y último error de la API (para mostrarlo junto al formulario). */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (mounted.current) setError(e);
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
