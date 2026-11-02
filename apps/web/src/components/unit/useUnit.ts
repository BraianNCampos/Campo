'use client';

import { useMemo } from 'react';
import type { AssetDef, ModuleId } from '@campo/shared';
import { unitModule } from '@/lib/modules/unit';
import { findAssetBySlug } from '@/lib/tags';
import { useLiveStore } from '@/store/live-store';
import { useActiveModuleIds } from '../modules/derived';

export type UnitState =
  | { status: 'loading' }
  | { status: 'notfound' }
  | { status: 'not-contracted'; module: ModuleId }
  | { status: 'ok'; def: AssetDef; module: ModuleId };

/**
 * Resuelve `/m/<módulo>/<tag>` contra el catálogo: espera a que cargue, exige que el activo pertenezca a ese módulo y que
 * el cliente lo tenga contratado (si no, «no está contratado» o «no encontrado»).
 */
export function useUnit(module: string, slug: string): UnitState {
  const catalog = useLiveStore((s) => s.catalog);
  const ready = useLiveStore((s) => s.catalogReady);
  const active = useActiveModuleIds();
  return useMemo<UnitState>(() => {
    const def = findAssetBySlug(catalog, slug);
    if (!def) return ready ? { status: 'notfound' } : { status: 'loading' };
    const own = unitModule(def);
    if (!own || own !== module) return { status: 'notfound' };
    if (!active.includes(own)) return { status: 'not-contracted', module: own };
    return { status: 'ok', def, module: own };
  }, [catalog, ready, active, module, slug]);
}
