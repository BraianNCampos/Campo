'use client';

import { useMemo, type ReactNode } from 'react';
import { modelIdOf, type SceneEntry } from '@/lib/catalog';
import { Pump } from './Pump';
import { Sensor } from './Sensor';
import { Tank } from './Tank';
import { Valve } from './Valve';
import { ModelAsset } from './ModelAsset';
import { Pipes } from './Pipes';
import { pipeSetFor, resolvePlacements, sceneBounds, type Bounds, type Placement } from './layout';

/** Modelo procedural de cada tipo. */
function Procedural({ entry, placement }: { entry: SceneEntry; placement: Placement }): ReactNode {
  const props = { id: entry.id, name: entry.name, placement };
  switch (entry.type) {
    case 'tank':
      return <Tank {...props} />;
    case 'pump':
      return <Pump {...props} />;
    case 'valve':
      return <Valve {...props} />;
    case 'sensor':
      return <Sensor {...props} />;
  }
}

function AssetNode({ entry, placement }: { entry: SceneEntry; placement: Placement }) {
  const procedural = <Procedural entry={entry} placement={placement} />;
  if (!modelIdOf(entry.model3dRef)) return procedural;
  return <ModelAsset id={entry.id} name={entry.name} type={entry.type} placement={placement} modelRef={entry.model3dRef} fallback={procedural} />;
}

/** Posiciones, límites y tuberías de una lista de activos (derivados una vez por cambio de catálogo). */
export function useSceneLayout(entries: readonly SceneEntry[]) {
  return useMemo(() => {
    const placements = resolvePlacements(entries);
    return { placements, bounds: sceneBounds(entries, placements) as Bounds, pipes: pipeSetFor(entries, placements) };
  }, [entries]);
}

/** Los activos del catálogo (cada uno por su tipo o su GLB) y sus tuberías. */
export function SceneEntities({ entries, layout }: { entries: readonly SceneEntry[]; layout: ReturnType<typeof useSceneLayout> }) {
  return (
    <>
      {layout.pipes && <Pipes key={layout.pipes.key} set={layout.pipes} />}
      {entries.map((e) => {
        const placement = layout.placements[e.id];
        return placement ? <AssetNode key={e.id} entry={e} placement={placement} /> : null;
      })}
    </>
  );
}
