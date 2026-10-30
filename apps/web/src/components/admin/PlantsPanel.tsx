'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { Org, Plant } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { canManagePlants, isPlatformAdmin } from '@/lib/admin/access';
import { validatePlantForm, type FieldErrors } from '@/lib/admin/validation';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconEdit, IconPlant, IconPlus, IconTrash } from '../icons';
import { RequireSection } from './AdminShell';
import { SelectField, TextField } from './fields';
import { useLoad, useOrgs, useSubmit } from './hooks';
import { OrgFilterField, useOrgParam } from './OrgFilter';
import { OrgName } from './shared';
import { ConfirmDialog, Modal, ModalActions } from './Modal';
import { ApiErrorAlert, Button, btn, card, cardList, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';

function PlantDialog({ plant, orgs, defaultOrg, onClose, onSaved }: { plant?: Plant; orgs: Org[]; defaultOrg: string; onClose: () => void; onSaved: () => void }) {
  const editing = !!plant;
  const platform = isPlatformAdmin(useSessionStore((s) => s.me?.role));
  const [orgId, setOrgId] = useState(plant?.orgId ?? defaultOrg);
  const [id, setId] = useState(plant?.id ?? '');
  const [name, setName] = useState(plant?.name ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validatePlantForm({ id, name }, { editing });
    if (platform && !editing && !orgId) errs.orgId = 'Elegí el cliente dueño de la planta.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const api = getAdminApi();
    const saved = await run(() => (plant ? api.renamePlant(plant.id, name.trim()) : api.createPlant({ id: id.trim(), name: name.trim(), ...(platform && { orgId }) })));
    if (saved) {
      toast.success(editing ? `Planta ${saved.id} renombrada.` : `Planta ${saved.id} creada.`);
      onSaved();
      onClose();
    }
  }

  return (
    <Modal title={editing ? 'Renombrar planta' : 'Nueva planta'} onClose={onClose} closable={!busy} size="sm">
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <TextField
          label="Id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={editing}
          error={errors.id}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          hint={editing ? 'El id no se puede cambiar.' : 'Minúsculas, números, "-" o "_". Es el que usan los sensores al publicar por MQTT.'}
          data-autofocus={editing ? undefined : ''}
        />
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} autoComplete="off" data-autofocus={editing ? '' : undefined} />
        {platform && (
          <SelectField label="Cliente" value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={editing} error={errors.orgId} hint={editing ? 'Una planta no cambia de cliente.' : 'El cliente que va a ver esta planta.'}>
            <option value="">Elegí un cliente…</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectField>
        )}
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {editing ? 'Guardar' : 'Crear planta'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function PlantsContent() {
  const role = useSessionStore((s) => s.me?.role);
  const isAdmin = canManagePlants(role);
  const platform = isPlatformAdmin(role);
  const orgs = useOrgs(platform);
  const [orgParam, setOrgParam] = useOrgParam();
  const orgFilter = platform ? orgParam : '';
  const plants = useLoad(() => getAdminApi().listPlants({ orgId: orgFilter || undefined }), [orgFilter]);
  const orgName = (id: string) => orgs.data?.find((o) => o.id === id);
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'rename' | 'delete'; plant: Plant } | null>(null);
  const changed = () => {
    plants.reload();
    void useSessionStore.getState().refreshPlants();
  };
  const list = plants.data;

  const actions = (p: Plant) => (
    <>
      <Link href={`/admin/plants/${encodeURIComponent(p.id)}`} className={btn('secondary')} aria-label={`Activos de ${p.name}`}>
        Activos
      </Link>
      {isAdmin && (
        <>
          <Button onClick={() => setDialog({ kind: 'rename', plant: p })} aria-label={`Renombrar ${p.name}`}>
            <IconEdit className="text-base" /> Renombrar
          </Button>
          <Button variant="danger" onClick={() => setDialog({ kind: 'delete', plant: p })} aria-label={`Eliminar ${p.name}`}>
            <IconTrash className="text-base" /> Eliminar
          </Button>
        </>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title="Plantas y activos"
        description={isAdmin ? 'Creá plantas y gestioná el catálogo de activos de cada una.' : 'Catálogo de activos de tus plantas.'}
        actions={
          isAdmin && (
            <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
              <IconPlus className="text-lg" /> Nueva planta
            </Button>
          )
        }
      />
      {platform && (
        <form role="search" aria-label="Filtros de plantas" className="mb-4 max-w-sm" onSubmit={(e) => e.preventDefault()}>
          <OrgFilterField orgs={orgs.data ?? []} value={orgParam} onChange={setOrgParam} />
        </form>
      )}
      {plants.error != null && <ErrorState error={plants.error} onRetry={plants.reload} />}
      {plants.loading && !list && plants.error == null && <LoadingBlock label="Cargando plantas…" />}
      {list && list.length === 0 && (
        <EmptyState icon={<IconPlant />} title="No hay plantas">
          {isAdmin ? 'Creá la primera planta con «Nueva planta».' : 'No tenés plantas asignadas. Contactá a un administrador.'}
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="plants-table">
              <caption className="sr-only">Plantas</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Id</th>
                  <th scope="col" className={th}>Nombre</th>
                  {platform && <th scope="col" className={th}>Cliente</th>}
                  <th scope="col" className={th}>Activos</th>
                  <th scope="col" className={`${th} text-right`}>Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((p) => (
                  <tr key={p.id} data-testid={`plant-row-${p.id}`}>
                    <td className={`${td} font-mono`}>{p.id}</td>
                    <td className={`${td} font-semibold`}>{p.name}</td>
                    {platform && <td className={td}><OrgName org={orgName(p.orgId)} orgId={p.orgId} /></td>}
                    <td className={`${td} tabular-nums`}>{p.assets}</td>
                    <td className={td}>
                      <div className="flex flex-wrap justify-end gap-2">{actions(p)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {list.map((p) => (
              <li key={p.id} className={card} data-testid={`plant-card-${p.id}`}>
                <p className="text-base font-semibold">{p.name}</p>
                <p className="text-sm text-muted">
                  <span className="font-mono">{p.id}</span> · {p.assets} {p.assets === 1 ? 'activo' : 'activos'}
                </p>
                {platform && <p className="text-sm text-muted">Cliente: {orgName(p.orgId)?.name ?? p.orgId}</p>}
                <div className="mt-3 flex flex-col gap-2 [&>*]:w-full">{actions(p)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog?.kind === 'create' && <PlantDialog orgs={orgs.data ?? []} defaultOrg={orgFilter} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog?.kind === 'rename' && <PlantDialog plant={dialog.plant} orgs={orgs.data ?? []} defaultOrg="" onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Eliminar planta ${dialog.plant.name}`}
          description={
            <>
              Se borra la planta y se quita de las asignaciones de los usuarios. Si todavía tiene activos, primero tenés que eliminarlos.
            </>
          }
          confirmLabel="Eliminar planta"
          requireText={dialog.plant.id}
          onConfirm={async () => {
            await getAdminApi().deletePlant(dialog.plant.id);
            toast.success(`Planta ${dialog.plant.id} eliminada.`);
            changed();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function PlantsPanel() {
  return (
    <RequireSection section="plants">
      <PlantsContent />
    </RequireSection>
  );
}
