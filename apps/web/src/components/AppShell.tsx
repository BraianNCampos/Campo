'use client';

import type { ReactNode } from 'react';
import { usePlantStore } from '@/store/plant-store';
import { LiveProvider } from './LiveProvider';
import { NoPlants } from './NoPlants';
import { SessionGate } from './SessionGate';
import { MasterLayout } from './shell/MasterLayout';

function WithPlant({ children }: { children: ReactNode }) {
  const plant = usePlantStore((s) => s.selected);
  if (!plant) return <NoPlants />;
  return (
    <LiveProvider plant={plant}>
      <MasterLayout>{children}</MasterLayout>
    </LiveProvider>
  );
}

/** Sesión + planta + stream en vivo + marco de navegación (compartido por `/`, `/m/*`, `/alarmas` y `/pared`). */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <WithPlant>{children}</WithPlant>
    </SessionGate>
  );
}
