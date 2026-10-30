import type { MetadataRoute } from 'next';
import { withBase } from '@/lib/base-path';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Campo — Monitoreo y alarmas para tu industria',
    short_name: 'Campo',
    description: 'Tu planta en tiempo real: valores en vivo, historial y alarmas.',
    id: '/',
    start_url: withBase('/'),
    scope: withBase('/'),
    display: 'standalone',
    orientation: 'any',
    background_color: '#0a1620',
    theme_color: '#0a1620',
    lang: 'es',
    categories: ['productivity', 'utilities'],
    icons: [
      { src: withBase('/icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: withBase('/icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: withBase('/icons/maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: withBase('/icons/icon.svg'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
