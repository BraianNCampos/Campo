'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { config } from '@/lib/env';
import { signOut, useSessionStore } from '@/store/session-store';
import { Logo } from './Brand';
import { Button } from './admin/ui';

export function Skeleton() {
  return (
    <div className="flex h-dvh items-center justify-center text-muted" role="status" aria-label="Cargando">
      <div className="size-8 animate-spin rounded-full border-2 border-line border-t-accent" />
    </div>
  );
}

/** Garantiza sesión + plantas cargadas (`/api/me`, `/api/plants`) antes de pintar a sus hijos. */
export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const status = useSessionStore((s) => s.status);
  const error = useSessionStore((s) => s.error);

  useEffect(() => {
    if (!config.mock && !getToken()) {
      router.replace('/login');
      return;
    }
    if (useSessionStore.getState().status === 'idle') void useSessionStore.getState().load();
  }, [router]);

  if (status === 'ready') return <>{children}</>;
  if (status === 'error') {
    return (
      <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-4 text-center">
        <div className="mx-auto">
          <Logo />
        </div>
        <h1 className="text-xl font-bold">No se pudo cargar tu sesión</h1>
        <p role="alert" className="rounded-lg border border-crit/60 bg-crit/15 px-3 py-2 text-sm font-semibold text-crit">
          {error}
        </p>
        <div className="flex flex-col gap-2">
          <Button variant="primary" onClick={() => void useSessionStore.getState().load()}>
            Reintentar
          </Button>
          {!config.mock && (
            <Button
              onClick={() => {
                signOut();
                router.replace('/login');
              }}
            >
              Cerrar sesión
            </Button>
          )}
        </div>
      </main>
    );
  }
  return <Skeleton />;
}
