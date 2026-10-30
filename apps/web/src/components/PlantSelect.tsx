'use client';

import { useMemo } from 'react';
import type { Plant } from '@campo/shared';
import { DEMO_ORGS } from '@/lib/demo-org';
import { config } from '@/lib/env';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';

/** Agrupa las plantas por cliente (sólo tiene sentido para el personal de plataforma, que ve varios). */
export function groupPlantsByOrg(plants: readonly Plant[], names: Record<string, string>): { orgId: string; name: string; plants: Plant[] }[] {
  const groups = new Map<string, Plant[]>();
  for (const p of plants) groups.set(p.orgId, [...(groups.get(p.orgId) ?? []), p]);
  return [...groups.entries()]
    .map(([orgId, list]) => ({ orgId, name: names[orgId] ?? orgId, plants: list }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

const label = (p: Plant) => (p.name === p.id ? p.id : `${p.name} (${p.id})`);

/** Selector de planta de la cabecera. No se muestra si el usuario sólo tiene una; agrupa por cliente para `platform_admin`. */
export function PlantSelect({ className = '' }: { className?: string }) {
  const plants = usePlantStore((s) => s.plants);
  const selected = usePlantStore((s) => s.selected);
  const select = usePlantStore((s) => s.select);
  const role = useSessionStore((s) => s.me?.role);
  const orgs = useSessionStore((s) => s.orgs);
  const groups = useMemo(() => {
    if (role !== 'platform_admin') return null;
    const names: Record<string, string> = Object.fromEntries((config.mock ? Object.values(DEMO_ORGS) : orgs ?? []).map((o) => [o.id, o.name]));
    for (const o of orgs ?? []) names[o.id] = o.name;
    const g = groupPlantsByOrg(plants, names);
    return g.length > 1 ? g : null;
  }, [role, plants, orgs]);
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
        {groups
          ? groups.map((g) => (
              <optgroup key={g.orgId} label={g.name}>
                {g.plants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {label(p)}
                  </option>
                ))}
              </optgroup>
            ))
          : plants.map((p) => (
              <option key={p.id} value={p.id}>
                {label(p)}
              </option>
            ))}
      </select>
    </label>
  );
}
