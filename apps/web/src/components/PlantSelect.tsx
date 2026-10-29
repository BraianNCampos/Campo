'use client';

import { usePlantStore } from '@/store/plant-store';

/** Selector de planta de la cabecera. No se muestra si el usuario sólo tiene una. */
export function PlantSelect({ className = '' }: { className?: string }) {
  const plants = usePlantStore((s) => s.plants);
  const selected = usePlantStore((s) => s.selected);
  const select = usePlantStore((s) => s.select);
  if (plants.length < 2) return null;
  return (
    <label className={`flex items-center gap-2 text-sm ${className}`}>
      <span className="font-semibold text-muted">Planta</span>
      <select
        data-testid="plant-select"
        value={selected ?? ''}
        onChange={(e) => select(e.target.value)}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm font-semibold text-fg"
      >
        {plants.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name === p.id ? p.id : `${p.name} (${p.id})`}
          </option>
        ))}
      </select>
    </label>
  );
}
