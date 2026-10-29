'use client';

import type { Plant, Role } from '@campo/shared';
import { passwordStrength } from '@/lib/admin/validation';
import { Badge } from './ui';
import { IconCheck, IconCritical, IconWarning } from '../icons';

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrador',
  engineer: 'Ingeniero',
  operator: 'Operador',
  viewer: 'Visor',
};

export const ROLE_HELP: Record<Role, string> = {
  admin: 'Acceso total: usuarios, plantas, reglas y auditoría.',
  engineer: 'Gestiona activos y reglas de las plantas asignadas.',
  operator: 'Ve las plantas asignadas y reconoce alarmas.',
  viewer: 'Sólo lectura de las plantas asignadas.',
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === 'admin' ? 'info' : 'neutral'}>{ROLE_LABEL[role]}</Badge>;
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
  if (role === 'admin') return <Badge tone="info">Todas</Badge>;
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

/** Indicador de longitud mínima de contraseña (texto + barra; el color nunca es la única señal). */
export function PasswordMeter({ value }: { value: string }) {
  const s = passwordStrength(value);
  return (
    <span className="flex items-center gap-2">
      {s.ok ? <IconCheck className="shrink-0 text-ok" /> : <IconCritical className="shrink-0 text-warn" />}
      <span className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 ${s.ok ? 'bg-ok' : 'bg-warn'}`} style={{ width: `${s.ratio * 100}%` }} />
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
