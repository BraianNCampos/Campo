/**
 * Prefijo de ruta cuando la web se publica bajo una subcarpeta (p. ej. GitHub Pages: `/Campo`).
 * Vacío en el despliegue normal. Se fija en el build con NEXT_PUBLIC_BASE_PATH.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Demo estática publicada como sitio (sin backend ni service worker). */
export const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === '1';

export const withBase = (path: string): string => `${BASE_PATH}${path}`;
