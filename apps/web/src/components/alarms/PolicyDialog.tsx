'use client';

import { useState, type FormEvent } from 'react';
import type { AlarmPolicy } from '@campo/shared';
import { validatePolicy } from '@/lib/admin/alarms-api';
import { getAlarmsApi } from '@/live/alarm-api';
import { toast } from '@/store/toast-store';
import { Modal, ModalActions } from '../admin/Modal';
import { TextField } from '../admin/fields';
import { useSubmit } from '../admin/hooks';
import { ApiErrorAlert, Button } from '../admin/ui';

/** Edita la política de alarmas de la planta (sólo admin): objetivos contra los que se mide la salud. */
export function PolicyDialog({ plant, policy, onClose, onSaved }: { plant: string; policy: AlarmPolicy; onClose: () => void; onSaved: (p: AlarmPolicy) => void }) {
  const [form, setForm] = useState({ ratePerDay: String(policy.ratePerDay), peak10min: String(policy.peak10min), staleHours: String(policy.staleHours) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = validatePolicy(form);
    setErrors(v.errors);
    if (!v.value) return;
    const value = v.value;
    const saved = await run(() => getAlarmsApi().setPolicy(plant, value));
    if (saved) {
      toast.success('Política de alarmas actualizada.');
      onSaved(saved);
      onClose();
    }
  }

  return (
    <Modal title="Política de alarmas" description="Los objetivos contra los que medimos la salud de las alarmas de esta planta. Los valores de arranque siguen las referencias habituales (EEMUA 191 e ISA-18.2)." onClose={onClose} closable={!busy}>
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4" data-testid="policy-form">
        <TextField label="Máximo de alarmas por día" inputMode="numeric" value={form.ratePerDay} onChange={(e) => set('ratePerDay', e.target.value)} error={errors.ratePerDay} hint="Lo que una persona puede atender bien en un día: unas 150." autoComplete="off" data-autofocus />
        <TextField label="Máximo en 10 minutos" inputMode="numeric" value={form.peak10min} onChange={(e) => set('peak10min', e.target.value)} error={errors.peak10min} hint="Tras una perturbación no deberían llegar más de unas 10 alarmas juntas." autoComplete="off" />
        <TextField label="Horas para considerar «estancada»" inputMode="numeric" value={form.staleHours} onChange={(e) => set('staleHours', e.target.value)} error={errors.staleHours} hint="Una alarma activa por más tiempo que esto figura como estancada." autoComplete="off" />
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={busy}>Guardar política</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
