'use client';

import { useEffect } from 'react';
import { STATIC_DEMO, withBase } from '@/lib/base-path';

export function ServiceWorkerRegister() {
  useEffect(() => {
    // la demo estática publicada como sitio no usa service worker (evita cachés viejas entre versiones)
    if (STATIC_DEMO || process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(withBase('/sw.js'), { scope: withBase('/') }).catch(() => {
      /* sin SW la app sigue funcionando online */
    });
  }, []);
  return null;
}
