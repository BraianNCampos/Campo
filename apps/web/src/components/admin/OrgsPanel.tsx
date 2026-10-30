'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Org } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { IconEdit, IconPlus } from '../icons';
import { RequireSection } from './AdminShell';
import { useLoad } from './hooks';
import { OrgDialog } from './OrgDialog';
import { IconOrg } from './org-icons';
import { ActiveBadge, ModuleChips } from './shared';
import { Button, btn, card, cardList, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';

function OrgsContent() {
  const orgs = useLoad(() => getAdminApi().listOrgs());
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; org: Org } | null>(null);
  const list = orgs.data;
  const upsert = (o: Org) => orgs.setData((prev) => (prev?.some((x) => x.id === o.id) ? prev.map((x) => (x.id === o.id ? o : x)) : [...(prev ?? []), o]));

  const actions = (o: Org) => (
    <>
      <Link href={`/admin/orgs/${encodeURIComponent(o.id)}`} className={btn('secondary')} aria-label={`Abrir ${o.name}`}>
        Abrir
      </Link>
      <Button onClick={() => setDialog({ kind: 'edit', org: o })} aria-label={`Editar ${o.name}`}>
        <IconEdit className="text-base" /> Editar
      </Button>
    </>
  );

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Cada cliente tiene su propio espacio y sólo ve los módulos que contrató."
        actions={
          <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
            <IconPlus className="text-lg" /> Nuevo cliente
          </Button>
        }
      />
      {orgs.error != null && <ErrorState error={orgs.error} onRetry={orgs.reload} />}
      {orgs.loading && !list && orgs.error == null && <LoadingBlock label="Cargando clientes…" />}
      {list && list.length === 0 && (
        <EmptyState icon={<IconOrg />} title="Todavía no hay clientes">
          Creá el primero con «Nuevo cliente», elegí sus módulos y después creale un administrador.
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="orgs-table">
              <caption className="sr-only">Clientes</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Cliente</th>
                  <th scope="col" className={th}>Módulos</th>
                  <th scope="col" className={th}>Plantas</th>
                  <th scope="col" className={th}>Usuarios</th>
                  <th scope="col" className={th}>Estado</th>
                  <th scope="col" className={`${th} text-right`}>Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((o) => (
                  <tr key={o.id} data-testid={`org-row-${o.id}`}>
                    <td className={td}>
                      <span className="block font-semibold">{o.name}</span>
                      <span className="block font-mono text-xs text-muted">{o.id}</span>
                    </td>
                    <td className={`${td} max-w-xs`}><ModuleChips modules={o.modules} /></td>
                    <td className={`${td} tabular-nums`}>{o.plants}</td>
                    <td className={`${td} tabular-nums`}>{o.users}</td>
                    <td className={td}><ActiveBadge active={o.active} /></td>
                    <td className={td}>
                      <div className="flex justify-end gap-2">{actions(o)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {list.map((o) => (
              <li key={o.id} className={card} data-testid={`org-card-${o.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-semibold break-words">{o.name}</p>
                    <p className="font-mono text-xs text-muted">{o.id}</p>
                  </div>
                  <ActiveBadge active={o.active} />
                </div>
                <div className="mt-2">
                  <ModuleChips modules={o.modules} />
                </div>
                <p className="mt-2 text-sm text-muted">
                  {o.plants} {o.plants === 1 ? 'planta' : 'plantas'} · {o.users} {o.users === 1 ? 'usuario' : 'usuarios'}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">{actions(o)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog?.kind === 'create' && <OrgDialog onClose={() => setDialog(null)} onSaved={upsert} />}
      {dialog?.kind === 'edit' && <OrgDialog org={dialog.org} onClose={() => setDialog(null)} onSaved={upsert} />}
    </>
  );
}

export function OrgsPanel() {
  return (
    <RequireSection section="orgs">
      <OrgsContent />
    </RequireSection>
  );
}
