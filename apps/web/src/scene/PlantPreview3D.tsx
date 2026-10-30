'use client';

import { useMemo } from 'react';
import type { AssetDef } from '@campo/shared';
import { entryOf } from '@/lib/catalog';
import { SceneCanvas } from './SceneCanvas';
import { SceneEntities, useSceneLayout } from './SceneEntities';
import { emptySceneData } from './scene-data';

/** Vista previa 3D del catálogo editado (administración): sin telemetría, todos los activos salen «sin datos». */
export default function PlantPreview3D({ assets }: { assets: readonly AssetDef[] }) {
  const entries = useMemo(() => assets.map(entryOf), [assets]);
  const layout = useSceneLayout(entries);
  return (
    <SceneCanvas
      bounds={layout.bounds}
      data={emptySceneData}
      shadowKey={entries.map((e) => e.id).join()}
      testId="preview-scene"
      label="Vista previa 3D de la disposición de la planta."
    >
      <SceneEntities entries={entries} layout={layout} />
    </SceneCanvas>
  );
}
