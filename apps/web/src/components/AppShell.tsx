'use client';

import { usePlantStore } from '@/store/plant-store';
import { DesktopShell } from './DesktopShell';
import { useIsMobile } from './hooks';
import { LiveProvider } from './LiveProvider';
import { MobileShell } from './MobileShell';
import { NoPlants } from './NoPlants';
import { SessionGate, Skeleton } from './SessionGate';

function Dashboard() {
  const plant = usePlantStore((s) => s.selected);
  const isMobile = useIsMobile(); // undefined hasta montar: nada de Canvas por error
  if (!plant) return <NoPlants />;
  return (
    <LiveProvider plant={plant}>
      {isMobile === undefined ? <Skeleton /> : isMobile ? <MobileShell /> : <DesktopShell />}
    </LiveProvider>
  );
}

export function AppShell() {
  return (
    <SessionGate>
      <Dashboard />
    </SessionGate>
  );
}
