'use client';

import { useState, type FormEvent } from 'react';
import type { ManagedUser, Org } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { validateOrgAdminForm, type FieldErrors } from '@/lib/admin/validation';
import { toast } from '@/store/toast-store';
import { TextField } from './fields';
import { useSubmit } from './hooks';
import { Modal, ModalActions } from './Modal';
import { PasswordMeter } from './shared';
import { ApiErrorAlert, Button } from './ui';

/** Crea el primer administrador de un cliente (correo y contraseña ≥ 12). */
export function OrgAdminDialog({ org, onClose, onCreated }: { org: Org; onClose: () => void; onCreated: (u: ManagedUser) => void }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateOrgAdminForm(form);
    setErrors(errs);
    if (!value) return;
    const created = await run(() => getAdminApi().createOrgAdmin(org.id, value));
    if (created) {
      toast.success(`Administrador ${created.email} creado para ${org.name}.`);
      onCreated(created);
      onClose();
    }
  }

  return (
    <Modal title="Crear administrador del cliente" description={<>Va a administrar a <strong>{org.name}</strong>: sus usuarios, plantas y reglas.</>} onClose={onClose} closable={!busy} size="sm">
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <TextField label="Correo" type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={errors.email} data-autofocus />
        <div className="flex flex-col gap-2">
          <TextField
            label="Contraseña inicial"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            error={errors.password}
            hint={<PasswordMeter value={form.password} />}
          />
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="size-5 accent-[var(--color-accent)]" />
            Mostrar contraseña
          </label>
        </div>
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Crear administrador
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
