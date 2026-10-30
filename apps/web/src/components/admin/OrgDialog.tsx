'use client';

import { useState, type FormEvent } from 'react';
import { MODULES } from '@campo/shared';
import type { ModuleId, Org } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { validateOrgForm, type FieldErrors } from '@/lib/admin/validation';
import { toast } from '@/store/toast-store';
import { Switch, TextField } from './fields';
import { useSubmit } from './hooks';
import { ConfirmDialog, Modal, ModalActions } from './Modal';
import { Alert, ApiErrorAlert, Button } from './ui';

/** Un interruptor por módulo, con su descripción tomada del registro compartido. */
export function ModuleSwitches({ value, onChange, error, disabled }: { value: ModuleId[]; onChange: (v: ModuleId[]) => void; error?: string; disabled?: boolean }) {
  return (
    <fieldset className="flex flex-col" disabled={disabled}>
      <legend className="mb-1 text-sm font-semibold">Módulos contratados</legend>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {MODULES.map((m) => {
          const on = value.includes(m.id);
          return (
            <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2" data-testid={`module-row-${m.id}`}>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{m.label}</p>
                <p className="text-xs text-muted">{m.description}</p>
              </div>
              <Switch
                checked={on}
                label={m.label}
                onText="Sí"
                offText="No"
                disabled={disabled}
                onChange={(v) => onChange(v ? MODULES.filter((x) => x.id === m.id || value.includes(x.id)).map((x) => x.id) : value.filter((x) => x !== m.id))}
              />
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-1 text-sm font-medium text-crit">{error}</p>}
    </fieldset>
  );
}

/** Alta y edición de un cliente. El id se elige al crear y no se cambia. Desactivarlo pide confirmación. */
export function OrgDialog({ org, onClose, onSaved }: { org?: Org; onClose: () => void; onSaved: (o: Org) => void }) {
  const editing = !!org;
  const [id, setId] = useState(org?.id ?? '');
  const [name, setName] = useState(org?.name ?? '');
  const [modules, setModules] = useState<ModuleId[]>(org?.modules ?? []);
  const [active, setActive] = useState(org?.active ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useSubmit();

  const removed = org ? org.modules.filter((m) => !modules.includes(m)) : [];
  const deactivating = !!org && org.active && !active;

  /** Lanza si la API rechaza (para mostrarlo dentro de la confirmación). */
  async function save(): Promise<Org> {
    const api = getAdminApi();
    const saved = org
      ? await api.updateOrg(org.id, {
          ...(name.trim() !== org.name && { name: name.trim() }),
          ...(modules.join() !== org.modules.join() && { modules }),
          ...(active !== org.active && { active }),
        })
      : await api.createOrg({ id: id.trim(), name: name.trim(), modules });
    toast.success(editing ? `Cliente ${saved.name} actualizado.` : `Cliente ${saved.name} creado.`);
    onSaved(saved);
    return saved;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validateOrgForm({ id, name, modules }, { editing });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (deactivating) return setConfirming(true);
    if (await run(save)) onClose();
  }

  return (
    <>
      <Modal title={editing ? `Editar cliente` : 'Nuevo cliente'} description={editing ? <span className="font-mono">{org.id}</span> : 'Elegí el nombre, el id y los módulos que contrató.'} onClose={onClose} closable={!busy} size="md">
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <TextField
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            autoComplete="off"
            hint="Como lo ve el cliente, por ejemplo «Agroindustria Ejemplo»."
            data-autofocus
          />
          <TextField
            label="Id del cliente"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={editing}
            error={errors.id}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            hint={editing ? 'El id no se puede cambiar.' : 'Minúsculas, números, "-" o "_". No se podrá cambiar después.'}
          />
          <ModuleSwitches value={modules} onChange={setModules} error={errors.modules} />
          {removed.length > 0 && (
            <Alert tone="info">Sacar un módulo no borra datos: se ocultan sus pantallas y los activos siguen guardados.</Alert>
          )}
          {editing && (
            <div className="flex flex-col gap-1 rounded-xl border border-line p-3">
              <p className="text-sm font-semibold">Estado del cliente</p>
              <Switch checked={active} onChange={setActive} label="Cliente activo" onText="Activo" offText="Inactivo" />
              <p className="text-xs text-muted">Un cliente inactivo no puede iniciar sesión: se corta el acceso de todos sus usuarios.</p>
            </div>
          )}
          <ApiErrorAlert error={error} />
          <ModalActions>
            <Button onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              {editing ? 'Guardar cambios' : 'Crear cliente'}
            </Button>
          </ModalActions>
        </form>
      </Modal>
      {confirming && org && (
        <ConfirmDialog
          title={`Desactivar a ${org.name}`}
          description={`Todos los usuarios de ${org.name} dejarán de poder iniciar sesión y sus sesiones abiertas se cortarán. Sus datos se conservan y podés volver a activarlo cuando quieras.`}
          confirmLabel="Sí, desactivar cliente"
          onConfirm={async () => {
            await save();
            onClose();
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
