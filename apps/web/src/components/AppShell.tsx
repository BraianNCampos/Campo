'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { showSectionNav } from '@/lib/modules/nav';
import { usePlantStore } from '@/store/plant-store';
import { Header } from './Header';
import { useIsMobile } from './hooks';
import { LiveProvider } from './LiveProvider';
import { useActiveModuleIds } from './modules/derived';
import { NoPlants } from './NoPlants';
import { OfflineBanner } from './OfflineBanner';
import { SessionGate, Skeleton } from './SessionGate';
import { BottomBar } from './shell/BottomBar';
import { Sidebar } from './shell/Sidebar';

function Frame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isMobile = useIsMobile(); // undefined hasta montar: nada de Canvas por error
  const moduleIds = useActiveModuleIds();
  if (pathname === '/pared') return <>{children}</>; // modo pared: pantalla completa, sin menús
  if (isMobile === undefined) return <Skeleton />;
  const sidebar = !isMobile && showSectionNav(moduleIds);
  return (
    <div className="relative flex h-dvh">
      {sidebar && <Sidebar moduleIds={moduleIds} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header brand={!sidebar} links={!sidebar} />
        <OfflineBanner />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </main>
        {isMobile && <BottomBar moduleIds={moduleIds} />}
      </div>
    </div>
  );
}

function WithPlant({ children }: { children: ReactNode }) {
  const plant = usePlantStore((s) => s.selected);
  if (!plant) return <NoPlants />;
  return (
    <LiveProvider plant={plant}>
      <Frame>{children}</Frame>
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
