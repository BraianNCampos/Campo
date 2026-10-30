'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { AssetDef } from '@campo/shared';
import { ErrorBoundary } from '../ErrorBoundary';
import { useIsMobile } from '../hooks';
import { IconCube, IconEye } from '../icons';
import { Button, Spinner } from './ui';

function Placeholder({ children }: { children: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted" role="status">
      <IconCube className="text-4xl" />
      <p className="px-4 text-center text-sm">{children}</p>
    </div>
  );
}

// El bundle de three/R3F sólo se descarga cuando se muestra la vista previa.
const PlantPreview3D = dynamic(() => import('@/scene/PlantPreview3D'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-3 text-muted" role="status">
      <Spinner /> Cargando vista previa…
    </div>
  ),
});

/**
 * Vista previa 3D del catálogo que se está editando (sin telemetría: todos «sin datos»). En escritorio se
 * muestra sola; en móvil hay que pedirla («Ver vista previa»).
 */
export function PlantPreview({ assets }: { assets: readonly AssetDef[] | undefined }) {
  const isMobile = useIsMobile(); // undefined hasta montar en cliente
  const [wanted, setWanted] = useState(false);
  const show = isMobile === false || wanted;

  return (
    <section aria-labelledby="preview-title" data-testid="plant-preview" className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="preview-title" className="text-xl font-bold tracking-tight">
            Vista previa 3D
          </h3>
          <p className="mt-1 text-sm text-muted">Así se dibuja la planta con la disposición y los modelos actuales. Arrastra para orbitar.</p>
        </div>
        {isMobile && wanted && (
          <Button onClick={() => setWanted(false)}>Ocultar vista previa</Button>
        )}
      </div>
      {show ? (
        <div className="relative h-80 overflow-hidden rounded-2xl border border-line bg-[#0d141d] md:h-96">
          {!assets ? (
            <Placeholder>Cargando activos…</Placeholder>
          ) : assets.length === 0 ? (
            <Placeholder>La planta no tiene activos que dibujar.</Placeholder>
          ) : (
            <ErrorBoundary fallback={<Placeholder>No se pudo iniciar el 3D (WebGL no disponible).</Placeholder>}>
              <PlantPreview3D assets={assets} />
            </ErrorBoundary>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-4 py-8 text-center">
          <IconCube className="text-4xl text-accent" />
          <p className="max-w-xs text-sm text-muted">La vista 3D consume batería y datos, por eso no se carga sola en el móvil.</p>
          <Button variant="primary" onClick={() => setWanted(true)} className="w-full max-w-xs">
            <IconEye className="text-lg" /> Ver vista previa
          </Button>
        </div>
      )}
    </section>
  );
}
