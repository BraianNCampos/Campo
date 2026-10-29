'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Role } from '@campo/shared';
import { getAdminApi, getDemoRole, ROLES, setDemoRole } from '@/lib/admin';
import { DEMO_PASSWORD } from '@/lib/admin/mock-api';
import { validatePasswordChange, type FieldErrors } from '@/lib/admin/validation';
import { setToken } from '@/lib/auth';
import { config } from '@/lib/env';
import { signOut, useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconLogout } from '../icons';
import { RequireSection } from './AdminShell';
import { SelectField, TextField } from './fields';
import { useSubmit } from './hooks';
import { PasswordMeter, PlantChips, ROLE_HELP, ROLE_LABEL, RoleBadge } from './shared';
import { Alert, ApiErrorAlert, Button, card, PageHeader } from './ui';

function PasswordForm() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const { busy, error, run, clearError } = useSubmit();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    clearError();
    const errs = validatePasswordChange(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const res = await run(() => getAdminApi().changePassword({ currentPassword: form.current, newPassword: form.next }));
    if (res) {
      if (!config.mock) setToken(res.accessToken); // el token anterior queda revocado: se guarda el nuevo
      setForm({ current: '', next: '', confirm: '' });
      toast.success('Contraseña cambiada. Tu sesión sigue abierta con un token nuevo.');
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className={`${card} flex max-w-xl flex-col gap-4`} aria-labelledby="pw-title">
      <h3 id="pw-title" className="text-lg font-bold">
        Cambiar contraseña
      </h3>
      <TextField label="Contraseña actual" type="password" autoComplete="current-password" value={form.current} onChange={(e) => set('current', e.target.value)} error={errors.current} />
      <TextField
        label="Contraseña nueva"
        type="password"
        autoComplete="new-password"
        value={form.next}
        onChange={(e) => set('next', e.target.value)}
        error={errors.next}
        hint={<PasswordMeter value={form.next} />}
      />
      <TextField label="Repite la contraseña nueva" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} error={errors.confirm} />
      <ApiErrorAlert error={error} />
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Cambiar contraseña
        </Button>
      </div>
    </form>
  );
}

function DemoRoleSwitch() {
  const [role, setRole] = useState<Role>(getDemoRole);
  return (
    <section className={`${card} flex max-w-xl flex-col gap-3`} aria-labelledby="demo-title">
      <h3 id="demo-title" className="text-lg font-bold">
        Modo demo
      </h3>
      <Alert tone="info">
        Los datos de administración viven en memoria y se reinician al recargar. La contraseña inicial de los usuarios demo es{' '}
        <code className="rounded bg-bg px-1 font-mono" data-testid="demo-password">
          {DEMO_PASSWORD}
        </code>
        .
      </Alert>
      <SelectField label="Rol de esta sesión demo" value={role} onChange={(e) => setRole(e.target.value as Role)} hint={ROLE_HELP[role]}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </SelectField>
      <div>
        <Button
          onClick={() => {
            setDemoRole(role);
            window.location.reload(); // recarga completa: reinicia sesión y datos demo
          }}
        >
          Cambiar rol y recargar
        </Button>
      </div>
    </section>
  );
}

function AccountContent() {
  const router = useRouter();
  const me = useSessionStore((s) => s.me);
  if (!me) return null;
  return (
    <>
      <PageHeader title="Mi cuenta" description="Tus datos de acceso y seguridad." />
      <div className="flex flex-col gap-5">
        <section className={`${card} max-w-xl`} aria-labelledby="me-title">
          <h3 id="me-title" className="sr-only">
            Datos de la cuenta
          </h3>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted">Correo</dt>
            <dd className="font-semibold break-all" data-testid="account-email">{me.email}</dd>
            <dt className="text-muted">Rol</dt>
            <dd><RoleBadge role={me.role} /></dd>
            <dt className="text-muted">Plantas</dt>
            <dd><PlantChips role={me.role} plants={me.plants} /></dd>
          </dl>
        </section>
        <PasswordForm />
        {config.mock ? (
          <DemoRoleSwitch />
        ) : (
          <div>
            <Button
              onClick={() => {
                signOut();
                router.replace('/login');
              }}
            >
              <IconLogout className="text-lg" /> Cerrar sesión
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

export function AccountPanel() {
  return (
    <RequireSection section="account">
      <AccountContent />
    </RequireSection>
  );
}
