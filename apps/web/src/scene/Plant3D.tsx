'use client';

import { useMemo } from 'react';
import { sceneEntries } from '@/lib/catalog';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { SceneCanvas } from './SceneCanvas';
import { SceneEntities, useSceneLayout } from './SceneEntities';
import { liveSceneData } from './scene-data';

/** Gemelo digital de la planta activa: los activos salen del catálogo (con su GLB o modelo procedural) y los valores del stream. */
export default function Plant3D() {
  const select = useUiStore((s) => s.select);
  // sólo cambian cuando cambia el conjunto de activos o el catálogo, no con cada mensaje de telemetría
  const ids = useLiveStore((s) => s.assetIds);
  const catalog = useLiveStore((s) => s.catalog);
  const plant = useLiveStore((s) => s.plant);
  const entries = useMemo(() => sceneEntries(ids, catalog), [ids, catalog]);
  const layout = useSceneLayout(entries);
  return (
    <SceneCanvas
      bounds={layout.bounds}
      data={liveSceneData}
      shadowKey={entries.map((e) => e.id).join()}
      label="Gemelo digital 3D de la planta. Usa la lista de activos para seleccionar equipos con teclado."
      onMissed={() => select(null)}
    >
      <SceneEntities key={plant} entries={entries} layout={layout} />
    </SceneCanvas>
  );
}
