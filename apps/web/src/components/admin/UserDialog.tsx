'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { ManagedUser, Role } from '@campo/shared';
import { getAdminApi, ROLES } from '@/lib/admin';
import { validatePassword } from '@/lib/admin/validation';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { CheckField, SelectField, TextField } from './fields';
import { useSubmit } from './hooks';
import { ConfirmDialog, Modal } from './Modal';
import { PasswordMeter, PlantChecklist, ROLE_HELP, ROLE_LABEL } from './shared';
import { Alert, ApiErrorAlert, Button } from './ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-bold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

type Pending = null | 'self-degrade' | 'deactivate' | 'revoke' | 'password';

/** Gestión de un usuario: rol/estado, plantas, contraseña, sesiones. Cada bloque guarda por separado. */
export function UserDialog({ user, users, onClose, onChanged }: { user: ManagedUser; users: ManagedUser[]; onClose: () => void; onChanged: (u: ManagedUser) => void }) {
  const api = getAdminApi();
  const plants = usePlantStore((s) => s.plants);
  const me = useSessionStore((s) => s.me);
  const isSelf = me?.id === user.id;
  const lastAdmin = user.role === 'admin' && user.active && users.filter((u) => u.role === 'admin' && u.active).length <= 1;

  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [assigned, setAssigned] = useState<string[]>(user.plants);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending>(null);
  const roleSub = useSubmit();
  const plantsSub = useSubmit();
  const sessSub = useSubmit();

  const roleDirty = role !== user.role || active !== user.active;
  const degrades = isSelf && user.role === 'admin' && (role !== 'admin' || !active);
  const plantsDirty = [...assigned].sort().join() !== [...user.plants].sort().join();

  /** Lanza si la API rechaza (409 último admin, 403…). */
  async function saveRole() {
    const patch = { ...(role !== user.role && { role }), ...(active !== user.active && { active }) };
    const updated = await api.updateUser(user.id, patch);
    onChanged(updated);
    toast.success(`Cambios guardados para ${updated.email}.`);
    if (isSelf) void api.me().then((m) => useSessionStore.getState().setMe(m)).catch(() => {});
  }

  function onRoleSubmit(e: FormEvent) {
    e.preventDefault();
    if (degrades) setPending('self-degrade');
    else void roleSub.run(saveRole);
  }

  async function savePlants(e: FormEvent) {
    e.preventDefault();
    const updated = await plantsSub.run(() => api.setUserPlants(user.id, assigned));
    if (!updated) return;
    onChanged(updated);
    toast.success(`Plantas de ${updated.email} actualizadas.`);
    if (isSelf) void api.me().then((m) => useSessionStore.getState().setMe(m)).catch(() => {});
  }

  function onPasswordSubmit(e: FormEvent) {
    e.preventDefault();
    const err = validatePassword(password).password;
    setPwError(err);
    if (!err) setPending('password');
  }

  return (
    <>
      <Modal title={`Gestionar usuario`} description={<span className="break-all">{user.email}{isSelf ? ' (tú)' : ''}</span>} onClose={onClose} size="lg">
        <div className="flex flex-col gap-5">
          <Section title="Rol y estado">
            <form onSubmit={onRoleSubmit} className="flex flex-col gap-3">
              <SelectField label="Rol" value={role} onChange={(e) => setRole(e.target.value as Role)} hint={ROLE_HELP[role]}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </SelectField>
              <CheckField label="Usuario activo" checked={active} onChange={(e) => setActive(e.target.checked)} hint="Un usuario inactivo no puede iniciar sesión." />
              {lastAdmin && (
                <Alert tone="warning">Es el último administrador activo: la API no permitirá degradarlo ni desactivarlo.</Alert>
              )}
              {degrades && (
                <Alert tone="warning">Estás cambiando tu propio acceso. Perderás los permisos de administrador en cuanto guardes.</Alert>
              )}
              <ApiErrorAlert error={roleSub.error} />
              <div>
                <Button type="submit" variant="primary" busy={roleSub.busy} disabled={!roleDirty}>
                  Guardar rol y estado
                </Button>
              </div>
            </form>
          </Section>

          <Section title="Plantas asignadas">
            <form onSubmit={(e) => void savePlants(e)} className="flex flex-col gap-3">
              {user.role === 'admin' ? (
                <p className="text-sm text-muted">Los administradores acceden a todas las plantas; las asignaciones no se aplican.</p>
              ) : null}
              <PlantChecklist plants={plants} value={assigned} onChange={setAssigned} />
              <ApiErrorAlert error={plantsSub.error} />
              <div>
                <Button type="submit" variant="primary" busy={plantsSub.busy} disabled={!plantsDirty}>
                  Guardar plantas
                </Button>
              </div>
            </form>
          </Section>

          <Section title="Restablecer contraseña">
            <form onSubmit={onPasswordSubmit} noValidate className="flex flex-col gap-3">
              <TextField
                label="Nueva contraseña"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={pwError}
                hint={<PasswordMeter value={password} />}
              />
              <div>
                <Button type="submit">
                  Restablecer contraseña
                </Button>
              </div>
            </form>
          </Section>

          <Section title="Sesiones y acceso">
            <p className="text-sm text-muted">Revocar cierra todas las sesiones abiertas del usuario; tendrá que iniciar sesión de nuevo.</p>
            <ApiErrorAlert error={sessSub.error} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setPending('revoke')}>Revocar sesiones</Button>
              {user.active ? (
                <Button variant="danger" onClick={() => setPending('deactivate')}>
                  Desactivar usuario
                </Button>
              ) : (
                <Button
                  onClick={() =>
                    void sessSub.run(async () => {
                      const u = await api.updateUser(user.id, { active: true });
                      setActive(true);
                      onChanged(u);
                      toast.success(`${u.email} reactivado.`);
                    })
                  }
                >
                  Reactivar usuario
                </Button>
              )}
            </div>
          </Section>
        </div>
      </Modal>

      {pending === 'self-degrade' && (
        <ConfirmDialog
          title="¿Quitarte permisos a ti mismo?"
          description="Vas a degradar o desactivar tu propia cuenta de administrador. Perderás el acceso a Usuarios y Auditoría y no podrás deshacerlo tú."
          confirmLabel="Sí, cambiar mi acceso"
          onConfirm={saveRole}
          onClose={() => setPending(null)}
        />
      )}
      {pending === 'deactivate' && (
        <ConfirmDialog
          title="Desactivar usuario"
          description={`${user.email} dejará de poder iniciar sesión y sus sesiones se cerrarán.${isSelf ? ' Es tu propia cuenta.' : ''}`}
          confirmLabel="Desactivar"
          onConfirm={async () => {
            const u = await api.updateUser(user.id, { active: false });
            setActive(false);
            onChanged(u);
            toast.success(`${u.email} desactivado.`);
          }}
          onClose={() => setPending(null)}
        />
      )}
      {pending === 'revoke' && (
        <ConfirmDialog
          title="Revocar sesiones"
          description={`Se cerrarán todas las sesiones de ${user.email}.`}
          confirmLabel="Revocar sesiones"
          onConfirm={async () => {
            onChanged(await api.revokeUserSessions(user.id));
            toast.success(`Sesiones de ${user.email} revocadas.`);
          }}
          onClose={() => setPending(null)}
        />
      )}
      {pending === 'password' && (
        <ConfirmDialog
          title="Restablecer contraseña"
          description={`Se cambiará la contraseña de ${user.email} y se cerrarán sus sesiones.`}
          confirmLabel="Restablecer"
          onConfirm={async () => {
            const u = await api.updateUser(user.id, { password });
            setPassword('');
            onChanged(u);
            toast.success(`Contraseña de ${u.email} restablecida; sus sesiones se han cerrado.`);
          }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
