'use client';

import { useMemo } from 'react';
import type { InterlockItem, Order, OrderCommand, Role } from '@campo/shared';
import { evaluateInterlocks, isControlEnabled, isControllableType, targetRange, type InterlockResult } from '@/lib/control/interlocks';
import { displayTag } from '@/lib/tags';
import { setpointOf } from '@/lib/modules/status';
import { useLiveStore } from '@/store/live-store';
import { selectActiveByAsset, useOrderStore } from '@/store/order-store';
import { useSessionStore } from '@/store/session-store';
import { useNow } from '../hooks';
import { useActiveModuleIds } from '../modules/derived';

/** Ids de los tanques y silos habilitados para control, ordenados por tag. */
export function useControllableIds(): { enabled: string[]; disabled: string[] } {
  const catalog = useLiveStore((s) => s.catalog);
  return useMemo(() => {
    const all = Object.values(catalog).filter((d) => isControllableType(d.type));
    const by = (a: (typeof all)[number], b: (typeof all)[number]) => displayTag(a.id, a).localeCompare(displayTag(b.id, b), 'en', { numeric: true });
    return {
      enabled: all.filter((d) => isControlEnabled(d)).sort(by).map((d) => d.id),
      disabled: all.filter((d) => !isControlEnabled(d)).sort(by).map((d) => d.id),
    };
  }, [catalog]);
}

export interface ControlRow {
  id: string;
  role: Role | null;
  level: number | undefined;
  setpoint: number | undefined;
  range: { min: number; max: number };
  order: Order | undefined;
  /** evalúa los enclavamientos de un comando con un objetivo */
  check(command: OrderCommand, target?: number): InterlockResult;
}

/** Todo lo que la tarjeta de control necesita de un activo: nivel, objetivo por defecto, orden en curso y enclavamientos. */
export function useControlRow(id: string): ControlRow {
  const def = useLiveStore((s) => s.catalog[id]);
  const state = useLiveStore((s) => s.assets[id]);
  const limits = useLiveStore((s) => s.limitsByAsset[id]);
  const alarms = useLiveStore((s) => s.alarms);
  const order = useOrderStore((s) => selectActiveByAsset(s)[id]);
  const role = useSessionStore((s) => s.me?.role ?? null);
  const moduleActive = useActiveModuleIds().includes('control');
  const now = useNow(1000);
  return useMemo(() => {
    const list = Object.values(alarms);
    return {
      id,
      role,
      level: state?.values.level,
      setpoint: setpointOf(def, state?.values, 'level'),
      range: targetRange(def),
      order,
      check: (command, target) =>
        evaluateInterlocks({ command, target, role, moduleActive, def, state, now, limits: limits ?? [], alarms: list, assetId: id, activeOrder: order ?? null }),
    };
  }, [id, def, state, limits, alarms, order, role, moduleActive, now]);
}

export const failing = (items: readonly InterlockItem[]): InterlockItem[] => items.filter((i) => !i.ok);
