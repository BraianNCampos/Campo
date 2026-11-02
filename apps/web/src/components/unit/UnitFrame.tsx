'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { MODULES } from '@campo/shared';
import { moduleHref } from '@/lib/modules/nav';
import { IconBack, IconGrid } from '../icons';
import { LoadingBlock } from '../admin/ui';
import { NotContracted } from '../modules/NoModules';
import type { UnitState } from './useUnit';

/** Estados de la ruta del detalle: cargando, no encontrado, no contratado. Sólo `ok` muestra el contenido. */
export function UnitGate({ state, module, children }: { state: UnitState; module: string; children: (s: Extract<UnitState, { status: 'ok' }>) => ReactNode }) {
  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-md px-4 py-16" data-testid="unit-loading">
        <LoadingBlock label="Cargando el equipo…" />
      </div>
    );
  }
  if (state.status === 'not-contracted') return <NotContracted label={MODULES.find((m) => m.id === state.module)?.label} />;
  if (state.status === 'notfound') {
    const label = MODULES.find((m) => m.id === module);
    return (
      <div data-testid="unit-notfound" className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <IconGrid className="text-5xl text-muted" />
        <h1 className="text-xl font-bold">No encontramos ese equipo</h1>
        <p className="text-muted">Puede que el tag esté mal escrito, que el equipo ya no exista o que no sea de este módulo.</p>
        {label && (
          <Link prefetch={false} href={moduleHref(label.id)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold hover:bg-line">
            <IconBack className="text-base" /> Volver a {label.label}
          </Link>
        )}
      </div>
    );
  }
  return <>{children(state)}</>;
}
