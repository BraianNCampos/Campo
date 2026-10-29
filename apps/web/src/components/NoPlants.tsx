'use client';

import Link from 'next/link';
import { useSessionStore } from '@/store/session-store';
import { btn } from './admin/ui';
import { Header } from './Header';
import { IconPlant } from './icons';

/** Usuario sin plantas (sin asignaciones, o instalación sin plantas creadas). */
export function NoPlants() {
  const role = useSessionStore((s) => s.me?.role);
  return (
    <div className="flex h-dvh flex-col">
      <Header bare />
      <main id="main" className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <IconPlant className="text-6xl text-muted" />
          <h2 className="text-xl font-bold">Sin plantas asignadas</h2>
          {role === 'admin' ? (
            <>
              <p className="text-muted">Todavía no hay plantas creadas. Crea la primera desde Administración.</p>
              <Link prefetch={false} href="/admin/plants" className={btn('primary')}>
                Ir a Plantas y activos
              </Link>
            </>
          ) : (
            <p className="text-muted">Contacta con un administrador para que te asigne una planta.</p>
          )}
        </div>
      </main>
    </div>
  );
}
