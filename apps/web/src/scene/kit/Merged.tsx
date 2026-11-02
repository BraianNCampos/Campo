'use client';

import { useEffect, useMemo } from 'react';
import type * as THREE from 'three';
import { disposeAll } from './geo';
import { kitMaterials, type KitMaterials } from './materials';
import { useQuality } from '../quality';

/** Construye (una vez por cambio de dependencias) las geometrías fusionadas de un activo y las libera al desmontar. */
export function useBuilt(build: () => Record<string, THREE.BufferGeometry>, deps: readonly unknown[]): Record<string, THREE.BufferGeometry> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(build, deps);
  useEffect(() => () => disposeAll(geo), [geo]);
  return geo;
}

export const useKitMaterials = (): KitMaterials => kitMaterials(useQuality());

/** Dibuja cada geometría fusionada con el material del kit de igual clave (opcionalmente sin sombras). */
export function Merged({ geo, shadows = true }: { geo: Record<string, THREE.BufferGeometry>; shadows?: boolean }) {
  const mats = useKitMaterials();
  return (
    <>
      {Object.entries(geo).map(([key, g]) => {
        const mat = mats[key as keyof KitMaterials];
        return mat ? <mesh key={key} geometry={g} material={mat} castShadow={shadows && !mat.transparent} receiveShadow={shadows} /> : null;
      })}
    </>
  );
}
