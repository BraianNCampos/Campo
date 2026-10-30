'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ManagedUser, Org, Role } from '@campo/shared';
import { getAdminApi, CLIENT_ROLES, ROLES } from '@/lib/admin';
import { isPlatformAdmin } from '@/lib/admin/access';
import { validateUserForm, type FieldErrors, type UserForm } from '@/lib/admin/validation';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconPlus, IconUsers } from '../icons';
import { RequireSection } from './AdminShell';
import { SelectField, TextField } from './fields';
import { useLoad, useOrgs, useSubmit } from './hooks';
import { OrgFilterField, useOrgParam } from './OrgFilter';
import { Modal, ModalActions } from './Modal';
import { ActiveBadge, OrgName, PasswordMeter, PlantChecklist, PlantChips, ROLE_HELP, ROLE_LABEL, RoleBadge } from './shared';
import { ApiErrorAlert, Button, cardList, card, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';
import { UserDialog } from './UserDialog';

function CreateUserDialog({ orgs, defaultOrg, onClose, onCreated }: { orgs: Org[]; defaultOrg: string; onClose: () => void; onCreated: (u: ManagedUser) => void }) {
  const plants = usePlantStore((s) => s.plants);
  const actorRole = useSessionStore((s) => s.me?.role);
  const platform = isPlatformAdmin(actorRole);
  const [form, setForm] = useState<UserForm>({ email: '', password: '', role: 'viewer', plants: [], orgId: defaultOrg });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit();
  const set = <K extends keyof UserForm>(k: K, v: UserForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const roles = platform ? ROLES : CLIENT_ROLES;
  const hasOrg = platform && form.role !== 'platform_admin';
  // sólo plantas del cliente del usuario: un administrador de cliente ya recibe únicamente las suyas
  const selectable = platform ? plants.filter((p) => p.orgId === form.orgId) : plants;
  const seesAll = form.role === 'admin' || form.role === 'platform_admin';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateUserForm(form, { actorRole });
    setErrors(errs);
    if (!value) return;
    const created = await run(() => getAdminApi().createUser(value));
    if (created) {
      toast.success(`Usuario ${created.email} creado.`);
      onCreated(created);
      onClose();
    }
  }

  return (
    <Modal title="Nuevo usuario" onClose={onClose} closable={!busy}>
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <TextField label="Correo" type="email" autoComplete="off" value={form.email} onChange={(e) => set('email', e.target.value)} error={errors.email} data-autofocus />
        <div className="flex flex-col gap-2">
          <TextField
            label="Contraseña inicial"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            error={errors.password}
            hint={<PasswordMeter value={form.password} />}
          />
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="size-5 accent-[var(--color-accent)]" />
            Mostrar contraseña
          </label>
        </div>
        <SelectField label="Rol" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role, plants: [] }))} error={errors.role} hint={form.role ? ROLE_HELP[form.role as Role] : undefined}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </SelectField>
        {hasOrg && (
          <SelectField label="Cliente" value={form.orgId ?? ''} onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value, plants: [] }))} error={errors.orgId} hint="El usuario sólo va a ver lo de este cliente.">
            <option value="">Elegí un cliente…</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectField>
        )}
        {form.role === 'platform_admin' ? (
          <p className="text-sm text-muted">El personal de Campos Ingeniería no pertenece a ningún cliente y ve todas las plantas.</p>
        ) : seesAll ? (
          <p className="text-sm text-muted">Los administradores ven todas las plantas de su cliente.</p>
        ) : platform && !form.orgId ? (
          <p className="text-sm text-muted">Elegí primero el cliente para asignarle plantas.</p>
        ) : (
          <PlantChecklist plants={selectable} value={form.plants} onChange={(v) => set('plants', v)} error={errors.plants} />
        )}
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Crear usuario
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function UsersContent() {
  const meId = useSessionStore((s) => s.me?.id);
  const platform = isPlatformAdmin(useSessionStore((s) => s.me?.role));
  const orgs = useOrgs(platform);
  const [orgParam, setOrgParam] = useOrgParam();
  const orgFilter = platform ? orgParam : '';
  const users = useLoad(() => getAdminApi().listUsers({ orgId: orgFilter || undefined }), [orgFilter]);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);

  useEffect(() => {
    void useSessionStore.getState().refreshPlants();
  }, []);

  const list = users.data;
  const upsert = (u: ManagedUser) =>
    users.setData((prev) => (prev ? (prev.some((x) => x.id === u.id) ? prev.map((x) => (x.id === u.id ? u : x)) : [...prev, u]) : [u]));
  const managed = list?.find((u) => u.id === managing) ?? null;
  const you = (u: ManagedUser) => u.id === meId && <span className="ml-2 text-xs font-normal text-muted">(vos)</span>;

  return (
    <>
      <PageHeader
        title="Usuarios"
        description={platform ? 'Cuentas, roles y plantas de todos los clientes.' : 'Cuentas, roles y plantas asignadas. El administrador ve todas las plantas de su cliente.'}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus className="text-lg" /> Nuevo usuario
          </Button>
        }
      />
      {platform && (
        <form role="search" aria-label="Filtros de usuarios" className="mb-4 max-w-sm" onSubmit={(e) => e.preventDefault()}>
          <OrgFilterField orgs={orgs.data ?? []} value={orgParam} onChange={setOrgParam} />
        </form>
      )}
      {users.error != null && <ErrorState error={users.error} onRetry={users.reload} />}
      {users.loading && !list && users.error == null && <LoadingBlock label="Cargando usuarios…" />}
      {list && list.length === 0 && <EmptyState icon={<IconUsers />} title="No hay usuarios">Creá el primero con «Nuevo usuario».</EmptyState>}
      {list && list.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="users-table">
              <caption className="sr-only">Usuarios</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Correo</th>
                  {platform && <th scope="col" className={th}>Cliente</th>}
                  <th scope="col" className={th}>Rol</th>
                  <th scope="col" className={th}>Estado</th>
                  <th scope="col" className={th}>Plantas</th>
                  <th scope="col" className={`${th} text-right`}>Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((u) => (
                  <tr key={u.id} data-testid={`user-row-${u.email}`}>
                    <td className={`${td} font-semibold`}>
                      {u.email}
                      {you(u)}
                    </td>
                    {platform && <td className={td}><OrgName org={u.org} /></td>}
                    <td className={td}><RoleBadge role={u.role} /></td>
                    <td className={td}><ActiveBadge active={u.active} /></td>
                    <td className={td}><PlantChips role={u.role} plants={u.plants} /></td>
                    <td className={`${td} text-right`}>
                      <Button onClick={() => setManaging(u.id)} aria-label={`Gestionar ${u.email}`}>Gestionar</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {list.map((u) => (
              <li key={u.id} className={card} data-testid={`user-card-${u.email}`}>
                <p className="font-semibold break-all">
                  {u.email}
                  {you(u)}
                </p>
                {platform && (
                  <p className="text-sm text-muted">
                    <span className="sr-only">Cliente: </span>
                    {u.org?.name ?? 'Campos Ingeniería'}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RoleBadge role={u.role} />
                  <ActiveBadge active={u.active} />
                </div>
                <div className="mt-2">
                  <PlantChips role={u.role} plants={u.plants} />
                </div>
                <Button className="mt-3 w-full" onClick={() => setManaging(u.id)} aria-label={`Gestionar ${u.email}`}>
                  Gestionar
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {creating && <CreateUserDialog orgs={orgs.data ?? []} defaultOrg={orgFilter} onClose={() => setCreating(false)} onCreated={upsert} />}
      {managed && list && <UserDialog user={managed} users={list} onClose={() => setManaging(null)} onChanged={upsert} />}
    </>
  );
}

export function UsersPanel() {
  return (
    <RequireSection section="users">
      <UsersContent />
    </RequireSection>
  );
}
