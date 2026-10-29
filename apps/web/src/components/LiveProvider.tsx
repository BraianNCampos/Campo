'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { config } from '@/lib/env';
import { getToken } from '@/lib/auth';
import { startLive } from '@/live/start-live';
import { useLiveStore } from '@/store/live-store';

/** Arranca la fuente de datos (demo o WS) y redirige a /login si falta sesión. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const connection = useLiveStore((s) => s.connection);

  useEffect(() => {
    if (!config.mock && !getToken()) {
      router.replace('/login');
      return;
    }
    return startLive();
  }, [router]);

  useEffect(() => {
    if (!config.mock && connection === 'unauthorized') router.replace('/login');
  }, [connection, router]);

  return <>{children}</>;
}
