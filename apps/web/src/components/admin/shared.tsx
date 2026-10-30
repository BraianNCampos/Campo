'use client';

import { MODULES } from '@campo/shared';
import type { ModuleId, OrgSummary, Plant, Role } from '@campo/shared';
import { passwordStrength } from '@/lib/admin/validation';
import { Badge } from './ui';
import { IconCheck, IconCritical, IconWarning } from '../icons';

export const ROLE_LABEL: Record<Role, string> = {
  platform_admin: 'Campos Ingeniería',
  admin: 'Administrador',
  engineer: 'Ingeniero',
  operator: 'Operador',
  viewer: 'Visor',
};

export const ROLE_HELP: Record<Role, string> = {
  platform_admin: 'Personal de Campos Ingeniería: gestiona los clientes y ve todo.',
  admin: 'Administra su cliente: usuarios, plantas, reglas y auditoría.',
  engineer: 'Gestiona activos y reglas de las plantas asignadas.',
  operator: 'Ve las plantas asignadas y reconoce alarmas.',
  viewer: 'Sólo puede mirar las plantas asignadas.',
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === 'platform_admin' ? 'info' : 'neutral'}>{ROLE_LABEL[role]}</Badge>;
}

export const moduleLabel = (id: ModuleId) => MODULES.find((m) => m.id === id)?.label ?? id;

/** Módulos como chips discretos: neutros, con un punto verde azulado (el color queda para lo que avisa). */
export function ModuleChips({ modules, empty = 'Sin módulos' }: { modules: readonly ModuleId[]; empty?: string }) {
  if (modules.length === 0) return <span className="text-sm text-muted">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Módulos">
      {MODULES.filter((m) => modules.includes(m.id)).map((m) => (
        <li key={m.id} className="inline-flex min-h-6 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 text-xs font-semibold whitespace-nowrap">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-ok/80" />
          {m.label}
        </li>
      ))}
    </ul>
  );
}

/** Nombre del cliente (y su id en tipografía técnica); «Campos Ingeniería» si no tiene cliente. */
export function OrgName({ org, orgId }: { org?: Pick<OrgSummary, 'id' | 'name'> | null; orgId?: string | null }) {
  const id = org?.id ?? orgId ?? null;
  if (!id) return <span className="text-muted">Campos Ingeniería</span>;
  return (
    <span className="block min-w-0">
      <span className="block font-semibold">{org?.name ?? id}</span>
      <span className="block font-mono text-xs text-muted">{id}</span>
    </span>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge tone="success" icon={<IconCheck />}>
      Activo
    </Badge>
  ) : (
    <Badge tone="warning" icon={<IconWarning />}>
      Inactivo
    </Badge>
  );
}

export function PlantChips({ role, plants }: { role: Role; plants: string[] }) {
  if (role === 'admin' || role === 'platform_admin') return <Badge>Todas</Badge>;
  if (plants.length === 0) return <span className="text-sm text-muted">Sin plantas</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {plants.map((p) => (
        <Badge key={p}>
          <span className="font-mono">{p}</span>
        </Badge>
      ))}
    </span>
  );
}

/** Indicador de fortaleza: tres tramos + texto (el color nunca es la única señal). */
export function PasswordMeter({ value }: { value: string }) {
  const s = passwordStrength(value);
  const filled = s.ok ? s.level : Math.floor(s.ratio * 3); // sin llegar al mínimo: avance hacia los 12 caracteres
  return (
    <span className="flex items-center gap-2">
      {s.ok ? <IconCheck className="shrink-0 text-ok" /> : <IconCritical className="shrink-0 text-warn" />}
      <span className="flex w-16 shrink-0 gap-0.5" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1.5 flex-1 rounded-full ${filled >= n ? (s.ok ? 'bg-ok' : 'bg-warn') : 'bg-line'}`} />
        ))}
      </span>
      <span className={s.ok ? 'text-ok' : 'text-muted'}>{s.text}</span>
    </span>
  );
}

/** Multi-selección de plantas con casillas (≥44 px). */
export function PlantChecklist({
  plants,
  value,
  onChange,
  error,
  disabled,
}: {
  plants: Plant[];
  value: string[];
  onChange: (v: string[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-1" disabled={disabled}>
      <legend className="mb-1 text-sm font-semibold">Plantas</legend>
      {plants.length === 0 ? (
        <p className="text-sm text-muted">No hay plantas creadas todavía.</p>
      ) : (
        <div className="grid gap-x-3 sm:grid-cols-2">
          {plants.map((p) => {
            const checked = value.includes(p.id);
            return (
              <label key={p.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(checked ? value.filter((x) => x !== p.id) : [...value, p.id])}
                  className="size-5 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{p.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{p.id}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
      {error && <p className="text-sm font-medium text-crit">{error}</p>}
    </fieldset>
  );
}
