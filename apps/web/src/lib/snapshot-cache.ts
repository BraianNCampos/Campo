import type { AssetState } from '@campo/shared';

const KEY = 'campo.snapshot.v1';

export interface CachedSnapshot {
  plant: string;
  savedAt: number;
  assets: Record<string, AssetState>;
}

export function saveSnapshot(plant: string, assets: Record<string, AssetState>, now = Date.now()): void {
  try {
    const data: CachedSnapshot = { plant, savedAt: now, assets };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* cuota o modo privado */
  }
}

export function loadSnapshot(plant: string): CachedSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as CachedSnapshot;
    if (data.plant !== plant || typeof data.assets !== 'object' || data.assets === null) return null;
    return data;
  } catch {
    return null;
  }
}
