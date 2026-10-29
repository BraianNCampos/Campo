import { create } from 'zustand';
import type { Plant } from '@campo/shared';
import { config } from '@/lib/env';

const KEY = 'campo.plant';

export function readStoredPlant(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeStoredPlant(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* noop */
  }
}

/**
 * Planta activa: la actual si sigue existiendo; si no, la última recordada; si no, la de la
 * configuración (`NEXT_PUBLIC_PLANT`); si no, la primera. `null` si el usuario no tiene plantas.
 */
export function resolveSelectedPlant(
  plants: readonly Pick<Plant, 'id'>[],
  current: string | null,
  stored: string | null,
  preferred: string,
): string | null {
  const has = (id: string | null): id is string => !!id && plants.some((p) => p.id === id);
  if (has(current)) return current;
  if (has(stored)) return stored;
  if (has(preferred)) return preferred;
  return plants[0]?.id ?? null;
}

interface PlantState {
  plants: Plant[];
  selected: string | null;
  setPlants(plants: Plant[]): void;
  /** Cambia la planta activa (y la recuerda). Ignora ids que el usuario no tiene. */
  select(id: string): void;
  reset(): void;
}

export const usePlantStore = create<PlantState>()((set, get) => ({
  plants: [],
  selected: null,
  setPlants(plants) {
    const selected = resolveSelectedPlant(plants, get().selected, readStoredPlant(), config.plant);
    if (selected) writeStoredPlant(selected);
    set({ plants, selected });
  },
  select(id) {
    if (!get().plants.some((p) => p.id === id) || get().selected === id) return;
    writeStoredPlant(id);
    set({ selected: id });
  },
  reset() {
    set({ plants: [], selected: null });
  },
}));
