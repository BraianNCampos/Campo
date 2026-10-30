'use client';

import { useMemo, useSyncExternalStore } from 'react';
import type { ModuleId } from '@campo/shared';
import { MODULES } from '@campo/shared';
import { activeModuleIds } from '@/lib/modules/nav';
import { moduleKpis, type Kpi } from '@/lib/modules/kpis';
import { countItems, moduleBadges, moduleItems, sameBadges, type Counts, type ModuleBadge, type ModuleItem } from '@/lib/modules/summary';
import { useLiveStore, type LiveData } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import type { CardStatus } from '@/lib/modules/status';

/**
 * Valor derivado del estado vivo que se recalcula como máximo cada `intervalMs` (y sólo notifica si cambia de verdad):
 * los agregados (resúmenes, insignias) no deben re-renderizar la pantalla en cada mensaje de telemetría.
 */
export function createThrottledDerived<T>(select: (s: LiveData) => T, equal: (a: T, b: T) => boolean, intervalMs = 1000) {
  let value = select(useLiveStore.getState());
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off: (() => void) | null = null;
  const flush = () => {
    timer = null;
    const next = select(useLiveStore.getState());
    if (!equal(value, next)) {
      value = next;
      listeners.forEach((l) => l());
    }
  };
  return {
    getSnapshot: () => value,
    subscribe(l: () => void) {
      listeners.add(l);
      if (listeners.size === 1) {
        off = useLiveStore.subscribe(() => {
          if (!timer) timer = setTimeout(flush, intervalMs);
        });
        flush(); // el valor pudo quedar viejo mientras nadie escuchaba
      }
      return () => {
        listeners.delete(l);
        if (listeners.size === 0) {
          off?.();
          off = null;
          if (timer) clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}

/** `key` identifica el selector: cuando cambia, se crea un derivado nuevo (los selectores se pasan como cierres nuevos en cada render). */
export function useThrottledLive<T>(key: string, select: (s: LiveData) => T, equal: (a: T, b: T) => boolean, intervalMs = 1000): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => createThrottledDerived(select, equal, intervalMs), [key]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ModuleSummary {
  ids: string[];
  statuses: Record<string, CardStatus>;
  kpis: Kpi[];
  counts: Counts;
}

function summarize(module: ModuleId, s: LiveData): ModuleSummary {
  const items: ModuleItem[] = moduleItems(module, s);
  return {
    ids: items.map((i) => i.id),
    statuses: Object.fromEntries(items.map((i) => [i.id, i.status])),
    kpis: moduleKpis(module, items),
    counts: countItems(items),
  };
}

/** Resumen vivo de un módulo (activos, estados, KPIs), refrescado como máximo cada segundo. */
export function useModuleSummary(module: ModuleId): ModuleSummary {
  return useThrottledLive(`summary:${module}`, (s) => summarize(module, s), json);
}

/** Insignias de atención por módulo (navegación). */
export function useModuleBadges(modules: readonly ModuleId[]): Record<string, ModuleBadge> {
  const key = modules.join(',');
  return useThrottledLive(`badges:${key}`, (s) => moduleBadges(key ? (key.split(',') as ModuleId[]) : [], s), sameBadges);
}

const EMPTY_ORGS: never[] = [];

/** Módulos que ve el usuario en la planta elegida. */
export function useActiveModuleIds(): ModuleId[] {
  const me = useSessionStore((s) => s.me);
  const orgs = useSessionStore((s) => s.orgs ?? EMPTY_ORGS);
  const plantOrgId = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.orgId ?? null);
  return useMemo(() => activeModuleIds(me?.org, me?.role, plantOrgId, orgs), [me, orgs, plantOrgId]);
}

export const moduleDef = (id: ModuleId) => MODULES.find((m) => m.id === id)!;
