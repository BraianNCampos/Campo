'use client';

import { useState, type FormEvent } from 'react';
import { SHELVE_MINUTES, SHELVE_PRESETS, validateShelve } from '@/lib/admin/alarms-api';
import { shelveAlarm } from '@/live/alarm-actions';
import { toast } from '@/store/toast-store';
import { Modal, ModalActions } from '../admin/Modal';
import { TextAreaField, TextField } from '../admin/fields';
import { useSubmit } from '../admin/hooks';
import { ApiErrorAlert, Button } from '../admin/ui';

const presetLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

/** Postergar una alarma: minutos (atajos o libre, 1–480) y motivo obligatorio. Queda en el diario con quién y por qué. */
export function ShelveDialog({ alarmId, assetName, onClose }: { alarmId: string; assetName: string; onClose: () => void }) {
  const [preset, setPreset] = useState<number | 'other'>(60);
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = validateShelve(preset === 'other' ? custom : preset, reason);
    setErrors(v.errors);
    if (!v.value) return;
    const value = v.value;
    const ok = await run(async () => {
      await shelveAlarm(alarmId, value);
      return true;
    });
    if (ok) {
      toast.success(`Postergaste la alarma de ${assetName} por ${presetLabel(value.minutes)}.`);
      onClose();
    }
  }

  return (
    <Modal
      title="Postergar alarma"
      description={`${assetName}: sale de la lista y vuelve sola cuando venza. Si la condición sigue, se avisa de nuevo. Queda registrado quién la postergó y por qué.`}
      onClose={onClose}
      closable={!busy}
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4" data-testid="shelve-form">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-semibold">¿Por cuánto tiempo?</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Duración">
            {SHELVE_PRESETS.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={preset === m} onClick={() => setPreset(m)} className={chipCls(preset === m)}>
                {presetLabel(m)}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={preset === 'other'} onClick={() => setPreset('other')} className={chipCls(preset === 'other')}>
              Otro
            </button>
          </div>
          {preset === 'other' && (
            <TextField
              label="Minutos"
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              error={errors.minutes}
              hint={`De ${SHELVE_MINUTES.min} a ${SHELVE_MINUTES.max} minutos (8 horas como máximo).`}
              autoComplete="off"
              data-autofocus
            />
          )}
        </fieldset>
        <TextAreaField
          label="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
          rows={3}
          maxLength={300}
          hint="Obligatorio. Por ejemplo: «sensor en calibración» o «mantenimiento de la bomba»."
          data-autofocus={preset === 'other' ? undefined : ''}
        />
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={busy}>Postergar alarma</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

const chipCls = (on: boolean) =>
  `min-h-11 min-w-14 rounded-lg border px-4 text-sm font-semibold ${on ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-surface-2 text-fg hover:bg-line'}`;
