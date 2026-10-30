'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModuleId, Org } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { useSessionStore } from '@/store/session-store';

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

/** Clientes (sólo para `platform_admin`; para el resto devuelve una lista vacía sin pedir nada). */
export function useOrgs(enabled: boolean): Loaded<Org[]> {
  const loaded = useLoad(() => (enabled ? getAdminApi().listOrgs() : Promise.resolve([] as Org[])), [enabled]);
  return loaded;
}

/**
 * Módulos contratados por un cliente: los de la sesión para el administrador de cliente; el personal de
 * plataforma los pide del cliente dueño. `undefined` mientras se cargan (en ese caso decide la API).
 */
export function useOrgModules(orgId: string | undefined): ModuleId[] | undefined {
  const me = useSessionStore((s) => s.me);
  const platform = me?.role === 'platform_admin';
  const org = useLoad(() => (platform && orgId ? getAdminApi().getOrg(orgId) : Promise.resolve(undefined)), [platform, orgId]);
  if (!platform) return me?.org?.modules;
  return org.data?.modules;
}
