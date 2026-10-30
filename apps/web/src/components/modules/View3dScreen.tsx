'use client';

import { useEffect } from 'react';
import { DesktopShell } from '../DesktopShell';
import { useIsMobile } from '../hooks';
import { MobileShell } from '../MobileShell';

/** Módulo «Vista 3D»: el gemelo digital de siempre. En móvil el Canvas sólo se monta si la persona lo pide. */
export function View3dScreen() {
  const isMobile = useIsMobile(); // undefined hasta montar: nada de Canvas por error
  useEffect(() => {
    document.title = 'Vista 3D · Campo';
  }, []);
  if (isMobile === undefined) return null;
  return (
    <div data-testid="module-screen" data-module="view3d" className="h-full">
      {isMobile ? <MobileShell /> : <DesktopShell />}
    </div>
  );
}
