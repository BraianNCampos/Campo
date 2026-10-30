'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Org } from '@campo/shared';
import { SelectField } from './fields';

/** Cliente elegido en la URL (`?org=<id>`); se conserva al recargar y se puede enlazar desde el detalle del cliente. */
export function useOrgParam(): [string, (id: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = params.get('org') ?? '';
  const set = (id: string) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('org', id);
    else next.delete('org');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };
  return [value, set];
}

/** Selector de cliente para el personal de plataforma. */
export function OrgFilterField({ orgs, value, onChange, label = 'Cliente', className }: { orgs: readonly Org[]; value: string; onChange: (id: string) => void; label?: string; className?: string }) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">Todos los clientes</option>
      {orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </SelectField>
  );
}
