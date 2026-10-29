'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ManagedUser, Role } from '@campo/shared';
import { getAdminApi, ROLES } from '@/lib/admin';
import { validateUserForm, type FieldErrors, type UserForm } from '@/lib/admin/validation';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconPlus, IconUsers } from '../icons';
import { RequireSection } from './AdminShell';
import { SelectField, TextField } from './fields';
import { useLoad, useSubmit } from './hooks';
import { Modal, ModalActions } from './Modal';
import { ActiveBadge, PasswordMeter, PlantChecklist, PlantChips, ROLE_HELP, ROLE_LABEL, RoleBadge } from './shared';
import { ApiErrorAlert, Button, cardList, card, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';
import { UserDialog } from './UserDialog';

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (u: ManagedUser) => void }) {
  const plants = usePlantStore((s) => s.plants);
  const [form, setForm] = useState<UserForm>({ email: '', password: '', role: 'viewer', plants: [] });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit();
  const set = <K extends keyof UserForm>(k: K, v: UserForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateUserForm(form);
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
        <SelectField label="Rol" value={form.role} onChange={(e) => set('role', e.target.value as Role)} error={errors.role} hint={form.role ? ROLE_HELP[form.role as Role] : undefined}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </SelectField>
        {form.role === 'admin' ? (
          <p className="text-sm text-muted">Los administradores acceden a todas las plantas.</p>
        ) : (
          <PlantChecklist plants={plants} value={form.plants} onChange={(v) => set('plants', v)} error={errors.plants} />
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
  const users = useLoad(() => getAdminApi().listUsers());
  const meId = useSessionStore((s) => s.me?.id);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);

  useEffect(() => {
    void useSessionStore.getState().refreshPlants();
  }, []);

  const list = users.data;
  const upsert = (u: ManagedUser) =>
    users.setData((prev) => (prev ? (prev.some((x) => x.id === u.id) ? prev.map((x) => (x.id === u.id ? u : x)) : [...prev, u]) : [u]));
  const managed = list?.find((u) => u.id === managing) ?? null;

  return (
    <>
      <PageHeader
        title="Usuarios"
        description="Cuentas, roles y plantas asignadas. El administrador accede a todas las plantas."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus className="text-lg" /> Nuevo usuario
          </Button>
        }
      />
      {users.error != null && <ErrorState error={users.error} onRetry={users.reload} />}
      {users.loading && !list && users.error == null && <LoadingBlock label="Cargando usuarios…" />}
      {list && list.length === 0 && <EmptyState icon={<IconUsers />} title="No hay usuarios">Crea el primero con «Nuevo usuario».</EmptyState>}
      {list && list.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="users-table">
              <caption className="sr-only">Usuarios</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Correo</th>
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
                      {u.id === meId && <span className="ml-2 text-xs font-normal text-muted">(tú)</span>}
                    </td>
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
                  {u.id === meId && <span className="ml-2 text-xs font-normal text-muted">(tú)</span>}
                </p>
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
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={upsert} />}
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
