'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { MODULES } from '@campo/shared';
import type { ManagedUser } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { toast } from '@/store/toast-store';
import { IconBack, IconEdit, IconPlant, IconTrash, IconUsers } from '../icons';
import { RequireSection } from './AdminShell';
import { useLoad } from './hooks';
import { ConfirmDialog } from './Modal';
import { OrgAdminDialog } from './OrgAdminDialog';
import { OrgDialog } from './OrgDialog';
import { ActiveBadge, PlantChips, RoleBadge } from './shared';
import { Alert, Button, btn, card, EmptyState, ErrorState, LoadingBlock, PageHeader } from './ui';

function OrgDetailContent() {
  const router = useRouter();
  const orgId = decodeURIComponent(String(useParams<{ org: string }>().org ?? ''));
  const org = useLoad(() => getAdminApi().getOrg(orgId), [orgId]);
  const plants = useLoad(() => getAdminApi().listPlants({ orgId }), [orgId]);
  const users = useLoad(() => getAdminApi().listUsers({ orgId }), [orgId]);
  const [dialog, setDialog] = useState<'edit' | 'admin' | 'delete' | null>(null);
  const o = org.data;
  const refresh = () => {
    org.reload();
    plants.reload();
    users.reload();
  };
  const enc = encodeURIComponent(orgId);

  return (
    <>
      <Link href="/admin/orgs" className={btn('ghost', '-ml-3 mb-1')}>
        <IconBack className="text-base" /> Clientes
      </Link>
      {org.error != null && <ErrorState error={org.error} onRetry={org.reload} />}
      {org.loading && !o && org.error == null && <LoadingBlock label="Cargando cliente…" />}
      {o && (
        <div data-testid="org-detail" className="flex flex-col gap-5">
          <PageHeader
            title={o.name}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{o.id}</span>
                <ActiveBadge active={o.active} />
              </span>
            }
            actions={
              <>
                <Button onClick={() => setDialog('edit')}>
                  <IconEdit className="text-base" /> Editar
                </Button>
                <Button onClick={() => setDialog('admin')}>Crear administrador del cliente</Button>
                <Button variant="danger" onClick={() => setDialog('delete')}>
                  <IconTrash className="text-base" /> Eliminar
                </Button>
              </>
            }
          />
          {!o.active && (
            <Alert tone="warning">Este cliente está inactivo: sus usuarios no pueden iniciar sesión. Reactivalo desde «Editar».</Alert>
          )}

          <section className={card} aria-labelledby="org-modules">
            <h3 id="org-modules" className="mb-3 text-lg font-bold">
              Módulos activos
            </h3>
            {o.modules.length === 0 ? (
              <p className="text-sm text-muted">No tiene módulos contratados.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="org-modules">
                {MODULES.filter((m) => o.modules.includes(m.id)).map((m) => (
                  <li key={m.id}>
                    <p className="text-sm font-semibold">{m.label}</p>
                    <p className="text-xs text-muted">{m.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={card} aria-labelledby="org-plants" data-testid="org-plants">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 id="org-plants" className="text-lg font-bold">
                Plantas ({o.plants})
              </h3>
              <Link href={`/admin/plants?org=${enc}`} className={btn('secondary')}>
                Ver en Plantas y activos
              </Link>
            </div>
            {plants.error != null && <ErrorState error={plants.error} onRetry={plants.reload} />}
            {plants.loading && !plants.data && <LoadingBlock label="Cargando plantas…" />}
            {plants.data && plants.data.length === 0 && <EmptyState icon={<IconPlant />} title="Sin plantas">Todavía no tiene plantas. Las crea su administrador o vos desde «Plantas y activos».</EmptyState>}
            {plants.data && plants.data.length > 0 && (
              <ul className="divide-y divide-line">
                {plants.data.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block font-semibold">{p.name}</span>
                      <span className="block font-mono text-xs text-muted">
                        {p.id} · {p.assets} {p.assets === 1 ? 'activo' : 'activos'}
                      </span>
                    </span>
                    <Link href={`/admin/plants/${encodeURIComponent(p.id)}`} className={btn('secondary')} aria-label={`Activos de ${p.name}`}>
                      Activos
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={card} aria-labelledby="org-users" data-testid="org-users">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 id="org-users" className="text-lg font-bold">
                Usuarios ({o.users})
              </h3>
              <div className="flex flex-wrap gap-2">
                <Link href={`/admin/users?org=${enc}`} className={btn('secondary')}>
                  Ver en Usuarios
                </Link>
                <Link href={`/admin/audit?org=${enc}`} className={btn('secondary')}>
                  Auditoría del cliente
                </Link>
              </div>
            </div>
            {users.error != null && <ErrorState error={users.error} onRetry={users.reload} />}
            {users.loading && !users.data && <LoadingBlock label="Cargando usuarios…" />}
            {users.data && users.data.length === 0 && (
              <EmptyState icon={<IconUsers />} title="Sin usuarios">
                Creá el administrador del cliente para que pueda entrar y armar su equipo.
              </EmptyState>
            )}
            {users.data && users.data.length > 0 && (
              <ul className="divide-y divide-line">
                {users.data.map((u: ManagedUser) => (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`org-user-${u.email}`}>
                    <span className="min-w-0 font-semibold break-all">{u.email}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <RoleBadge role={u.role} />
                      <ActiveBadge active={u.active} />
                      <span className="hidden sm:inline">
                        <PlantChips role={u.role} plants={u.plants} />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {o && dialog === 'edit' && <OrgDialog org={o} onClose={() => setDialog(null)} onSaved={() => refresh()} />}
      {o && dialog === 'admin' && <OrgAdminDialog org={o} onClose={() => setDialog(null)} onCreated={() => refresh()} />}
      {o && dialog === 'delete' && (
        <ConfirmDialog
          title={`Eliminar el cliente ${o.name}`}
          description="Se borra el cliente. Sólo es posible si ya no tiene plantas ni usuarios; si los tiene, te mostramos qué falta eliminar."
          confirmLabel="Eliminar cliente"
          requireText={o.id}
          onConfirm={async () => {
            await getAdminApi().deleteOrg(o.id);
            toast.success(`Cliente ${o.name} eliminado.`);
            router.replace('/admin/orgs');
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function OrgDetail() {
  return (
    <RequireSection section="orgs">
      <OrgDetailContent />
    </RequireSection>
  );
}
