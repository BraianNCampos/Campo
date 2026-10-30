'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { MODEL_REF_PATTERN } from '@campo/shared';
import type { AssetDef, AssetType, ModelInfo } from '@campo/shared';
import { getAdminApi, ASSET_TYPES } from '@/lib/admin';
import { prettyJson } from '@/lib/admin/format';
import { formatBytes } from '@/lib/admin/models';
import type { AssetResult } from '@/lib/admin/types';
import {
  fieldsFromMetadataText,
  layoutFormFrom,
  parseMetadata,
  syncMetadataText,
  validateAssetForm,
  validateLayoutForm,
  type AssetForm,
  type FieldErrors,
  type LayoutForm,
} from '@/lib/admin/validation';
import { parseConnectsTo } from '@/lib/catalog';
import { toast } from '@/store/toast-store';
import { CheckField, SelectField, TextAreaField, TextField } from './fields';
import { useSubmit } from './hooks';
import { Modal, ModalActions } from './Modal';
import { ModelUploader } from './ModelUploader';
import { Alert, ApiErrorAlert, Button } from './ui';

export const TYPE_LABEL: Record<AssetType, string> = { tank: 'Tanque', pump: 'Bomba', valve: 'Válvula', sensor: 'Sensor' };

const UPLOAD = '__upload__';
/** Tamaño sugerido (m) del GLB normalizado a 1 unidad, según el tipo. */
const SCALE_HINT: Record<AssetType, string> = { tank: '3,5', pump: '2,5', valve: '1,2', sensor: '0,6' };

function initialForm(asset?: AssetDef): AssetForm {
  const meta = asset?.metadata ?? {};
  return {
    id: asset?.id ?? '',
    name: asset?.name ?? '',
    type: asset?.type ?? 'tank',
    model3dRef: asset?.model3dRef ?? '',
    layout: layoutFormFrom(meta),
    connectsTo: parseConnectsTo(meta),
    metadataText: Object.keys(meta).length > 0 ? prettyJson(meta) : '',
  };
}

const LAYOUT_INPUTS: { key: keyof LayoutForm; label: string; err: string }[] = [
  { key: 'x', label: 'Posición X (m)', err: 'layoutX' },
  { key: 'z', label: 'Posición Z (m)', err: 'layoutZ' },
  { key: 'y', label: 'Altura Y (m)', err: 'layoutY' },
  { key: 'rotY', label: 'Rotación (°)', err: 'layoutRotY' },
  { key: 'scale', label: 'Escala', err: 'layoutScale' },
];

/** Alta/edición de un activo: tipo, modelo 3D, disposición en planta, conexiones y metadatos JSON (sincronizados). */
export function AssetDialog({
  plant,
  asset,
  assets,
  models,
  onClose,
  onSaved,
  onModelUploaded,
}: {
  plant: string;
  asset?: AssetDef;
  /** catálogo de la planta (para elegir a qué activos se conecta) */
  assets: readonly AssetDef[];
  models: readonly ModelInfo[];
  onClose: () => void;
  onSaved: (a: AssetDef, warnings: string[]) => void;
  onModelUploaded: (m: ModelInfo) => void;
}) {
  const editing = !!asset;
  const [form, setForm] = useState<AssetForm>(() => initialForm(asset));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [metaTouched, setMetaTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [uploadMode, setUploadMode] = useState(false);
  const { busy, error, run } = useSubmit();
  const set = <K extends keyof AssetForm>(k: K, v: AssetForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const liveMeta = parseMetadata(form.metadataText);
  const jsonOk = liveMeta.ok;
  const metaError = (metaTouched || errors.metadata) && !liveMeta.ok ? liveMeta.error : errors.metadata;
  // números no válidos o fuera de rango: en vivo; «falta X o Z»: sólo tras intentar guardar
  const layoutErrors = Object.fromEntries(Object.entries(validateLayoutForm(form.layout).errors).filter(([, m]) => submitted || !m.startsWith('Indica X y Z')));

  /** Los campos escriben en el JSON avanzado (sin tocar el resto de claves) y el JSON actualiza los campos. */
  function setLayoutField(key: keyof LayoutForm, value: string) {
    setForm((f) => {
      const layout = { ...f.layout, [key]: value };
      const parsed = validateLayoutForm(layout);
      const text = parsed.value !== undefined ? syncMetadataText(f.metadataText, parsed.value, undefined) : null;
      return { ...f, layout, ...(text !== null && { metadataText: text }) };
    });
  }
  function toggleConnection(id: string, on: boolean) {
    setForm((f) => {
      const connectsTo = on ? [...f.connectsTo, id] : f.connectsTo.filter((x) => x !== id);
      const text = syncMetadataText(f.metadataText, undefined, connectsTo);
      return { ...f, connectsTo, ...(text !== null && { metadataText: text }) };
    });
  }
  function setMetadataText(text: string) {
    const fields = fieldsFromMetadataText(text);
    setForm((f) => ({ ...f, metadataText: text, ...(fields ?? {}) }));
  }

  const currentRef = form.model3dRef;
  const known = models.some((m) => `model:${m.id}` === currentRef);
  const selectValue = uploadMode ? UPLOAD : currentRef;
  const candidates = useMemo(() => assets.filter((a) => a.id !== (asset?.id ?? form.id.trim())), [assets, asset?.id, form.id]);
  const orphans = form.connectsTo.filter((id) => !assets.some((a) => a.id === id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateAssetForm(form, { editing });
    setErrors(errs);
    setSubmitted(true);
    setMetaTouched(true);
    if (!value) return;
    const api = getAdminApi();
    const saved = await run<AssetResult>(() =>
      asset
        ? api.updateAsset(plant, asset.id, { name: value.name, type: value.type, model3dRef: value.model3dRef, metadata: value.metadata })
        : api.createAsset(plant, value),
    );
    if (saved) {
      toast.success(editing ? `Activo ${saved.id} actualizado.` : `Activo ${saved.id} creado.`);
      onSaved(saved, saved.warnings ?? []);
      onClose();
    }
  }

  return (
    <Modal title={editing ? `Editar activo ${asset.id}` : 'Nuevo activo'} onClose={onClose} closable={!busy} size="lg">
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Id"
            value={form.id}
            onChange={(e) => set('id', e.target.value)}
            disabled={editing}
            error={errors.id}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            hint={editing ? 'El id no se puede cambiar una vez creado.' : 'Es el que publica el sensor en MQTT (p. ej. tk-05). No se podrá cambiar.'}
            data-autofocus={editing ? undefined : ''}
          />
          <TextField label="Nombre" value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} autoComplete="off" data-autofocus={editing ? '' : undefined} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Tipo" value={form.type} onChange={(e) => set('type', e.target.value as AssetType)} error={errors.type}>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Modelo 3D"
            value={selectValue}
            error={errors.model3dRef}
            onChange={(e) => {
              const v = e.target.value;
              setUploadMode(v === UPLOAD);
              if (v !== UPLOAD) set('model3dRef', v);
            }}
            hint="Procedural: el dibujo genérico del tipo. O un modelo GLB de esta planta."
          >
            <option value="">Procedural (según el tipo)</option>
            {models.map((m) => (
              <option key={m.id} value={`model:${m.id}`}>
                {m.name} ({formatBytes(m.size)})
              </option>
            ))}
            {currentRef && !known && (
              <option value={currentRef}>{MODEL_REF_PATTERN.test(currentRef) ? `Modelo no encontrado (${currentRef})` : `Referencia no válida (${currentRef})`}</option>
            )}
            <option value={UPLOAD}>Subir nuevo…</option>
          </SelectField>
        </div>
        {uploadMode && (
          <ModelUploader
            plant={plant}
            compact
            onUploaded={(m) => {
              onModelUploaded(m);
              set('model3dRef', `model:${m.id}`);
              setUploadMode(false);
            }}
          />
        )}

        <fieldset className="rounded-xl border border-line p-3" disabled={!jsonOk}>
          <legend className="px-1 text-sm font-semibold">Disposición en la planta</legend>
          <p className="mb-3 text-xs text-muted">
            Metros desde el centro. Deja X y Z vacíos para colocarlo automáticamente. La escala es el tamaño máximo del modelo en metros
            {form.type ? ` (sugerida para ${TYPE_LABEL[form.type as AssetType].toLowerCase()}: ${SCALE_HINT[form.type as AssetType]})` : ''}.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {LAYOUT_INPUTS.map(({ key, label, err }) => (
              <TextField
                key={key}
                label={label}
                inputMode="decimal"
                autoComplete="off"
                value={form.layout[key]}
                onChange={(e) => setLayoutField(key, e.target.value)}
                error={layoutErrors[err]}
                placeholder={key === 'scale' ? '1' : key === 'x' || key === 'z' ? '0' : ''}
                data-testid={`layout-${key}`}
              />
            ))}
          </div>
          {!jsonOk && <p className="mt-2 text-xs text-warn">Corrige el JSON de metadatos para editar estos campos.</p>}
        </fieldset>

        <fieldset className="rounded-xl border border-line p-3" disabled={!jsonOk}>
          <legend className="px-1 text-sm font-semibold">Conectado a</legend>
          <p className="mb-2 text-xs text-muted">Dibuja una tubería desde este activo hasta los marcados.</p>
          {candidates.length === 0 && orphans.length === 0 ? (
            <p className="text-sm text-muted">No hay otros activos en la planta.</p>
          ) : (
            <div className="grid max-h-44 gap-x-4 overflow-y-auto sm:grid-cols-2" data-testid="connects-to">
              {[...candidates.map((a) => ({ id: a.id, label: `${a.name} (${a.id})` })), ...orphans.map((id) => ({ id, label: `${id} (no existe)` }))].map((o) => (
                <CheckField key={o.id} label={o.label} checked={form.connectsTo.includes(o.id)} onChange={(e) => toggleConnection(o.id, e.target.checked)} />
              ))}
            </div>
          )}
          {errors.connectsTo && <p className="mt-1 text-sm font-medium text-crit">{errors.connectsTo}</p>}
        </fieldset>

        <TextAreaField
          label="Metadatos (JSON avanzado)"
          rows={6}
          value={form.metadataText}
          onChange={(e) => setMetadataText(e.target.value)}
          onBlur={() => setMetaTouched(true)}
          error={metaError}
          spellCheck={false}
          placeholder='{"capacityL": 5000}'
          hint="Objeto JSON con datos libres del equipo. Incluye layout y connectsTo, que se mantienen sincronizados con los campos de arriba."
        />
        <ApiErrorAlert error={error} />
        {submitted && Object.keys(layoutErrors).length > 0 && <Alert tone="error">Revisa la disposición en la planta: hay valores no válidos.</Alert>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {editing ? 'Guardar cambios' : 'Crear activo'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

