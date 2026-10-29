import path from 'node:path';
import type { NextConfig } from 'next';

// Raíz del monorepo: necesaria para importar `@campo/shared` (../../packages/shared)
// y para que `output: 'standalone'` trace los archivos correctos.
const repoRoot = path.resolve(__dirname, '../..');

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
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
