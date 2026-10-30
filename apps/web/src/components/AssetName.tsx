'use client';

import { useAssetName } from './useAsset';

/** Nombre de un activo (catálogo o deducido del id) para listas donde no se usa `useAsset`. */
export function AssetName({ id }: { id: string }) {
  return <>{useAssetName(id)}</>;
}
