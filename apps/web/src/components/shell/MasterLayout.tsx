'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { showSectionNav } from '@/lib/modules/nav';
import { Header } from '../Header';
import { useIsMobile } from '../hooks';
import { useActiveModuleIds } from '../modules/derived';
import { OfflineBanner } from '../OfflineBanner';
import { Skeleton } from '../SessionGate';
import { AlarmFooter } from './AlarmFooter';
import { BottomBar } from './BottomBar';
import { Sidebar } from './Sidebar';

/** Rutas que ocultan la plantilla a propósito (pantalla completa para TVs). */
export const BARE_ROUTES = ['/pared'];

/**
 * Plantilla maestra bloqueada (ISA-101, docs/ux-isa.md §2.1): cabecera, barra de navegación y pie global de alarmas
 * fijos; las pantallas sólo aportan el contenido de `<main>`. La navegación sale únicamente de `me.org.modules`
 * (más las secciones del núcleo: alarmas, modo pared, administración y cuenta). El modo pared la oculta.
 */
export function MasterLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isMobile = useIsMobile(); // undefined hasta montar: nada de Canvas por error
  const moduleIds = useActiveModuleIds();
  if (BARE_ROUTES.includes(pathname)) return <>{children}</>;
  if (isMobile === undefined) return <Skeleton />;
  const sidebar = !isMobile && showSectionNav(moduleIds);
  return (
    <div data-testid="master-layout" className="relative flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1">
        {sidebar && <Sidebar moduleIds={moduleIds} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Header brand={!sidebar} links={!sidebar} />
          <OfflineBanner />
          <main id="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {children}
          </main>
        </div>
      </div>
      <AlarmFooter />
      {isMobile && <BottomBar moduleIds={moduleIds} />}
    </div>
  );
}
