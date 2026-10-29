'use client';

import { DesktopShell } from './DesktopShell';
import { useIsMobile } from './hooks';
import { LiveProvider } from './LiveProvider';
import { MobileShell } from './MobileShell';

function Skeleton() {
  return (
    <div className="flex h-dvh items-center justify-center text-muted" role="status" aria-label="Cargando">
      <div className="size-8 animate-spin rounded-full border-2 border-line border-t-accent" />
    </div>
  );
}

export function AppShell() {
  const isMobile = useIsMobile(); // undefined hasta montar: nada de Canvas por error
  return (
    <LiveProvider>
      {isMobile === undefined ? <Skeleton /> : isMobile ? <MobileShell /> : <DesktopShell />}
    </LiveProvider>
  );
}
