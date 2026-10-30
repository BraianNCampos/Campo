import path from 'node:path';
import type { NextConfig } from 'next';

// Raíz del monorepo: necesaria para importar `@campo/shared` (../../packages/shared)
// y para que `output: 'standalone'` trace los archivos correctos.
const repoRoot = path.resolve(__dirname, '../..');

// NEXT_EXPORT=1 genera un sitio estático (demo sin backend, publicable en cualquier hosting estático).
const staticExport = process.env.NEXT_EXPORT === '1';

const nextConfig: NextConfig = {
  // carpeta de salida configurable: permite construir en paralelo (p. ej. dos e2e a la vez) sin pisar `.next`
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  output: staticExport ? 'export' : 'standalone',
  ...(staticExport ? { trailingSlash: true, images: { unoptimized: true } } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    if (staticExport) return [];
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
