'use client';

import dynamic from 'next/dynamic';
import { ErrorBoundary } from './ErrorBoundary';
import { IconCube } from './icons';

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-muted" role="status">
      <IconCube className="text-4xl" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

// El bundle de three/R3F sólo se descarga cuando se monta esta vista.
const Plant3D = dynamic(() => import('@/scene/Plant3D'), {
  ssr: false,
  loading: () => <Placeholder text="Cargando gemelo digital…" />,
});

export function PlantView() {
  return (
    <ErrorBoundary fallback={<Placeholder text="No pudimos iniciar el 3D (WebGL no está disponible)." />}>
      <Plant3D />
    </ErrorBoundary>
  );
}
