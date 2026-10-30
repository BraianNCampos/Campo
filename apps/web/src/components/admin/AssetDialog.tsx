'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ASSET_KINDS, METRICS, MODEL_REF_PATTERN } from '@campo/shared';
import type { AssetDef, AssetType, ModelInfo, ModuleId } from '@campo/shared';
import { getAdminApi, ASSET_TYPES } from '@/lib/admin';
import { ModuleDisabledError } from '@/lib/admin/errors';
import { prettyJson } from '@/lib/admin/format';
import { formatBytes } from '@/lib/admin/models';
import type { AssetResult } from '@/lib/admin/types';
import {
  domainFormFrom,
  domainFromMetadataText,
  fieldsFromMetadataText,
  isTypeAllowed,
  layoutFormFrom,
  parseMetadata,
  scaleMetricsFor,
  syncDomainIntoText,
  syncMetadataText,
  validateAssetForm,
  validateDomainForm,
  validateLayoutForm,
  type AssetForm,
  type DomainForm,
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

/** Nombre legible de un tipo de activo (registro compartido). */
export const typeLabel = (t: AssetType) => ASSET_KINDS[t]?.label ?? t;

const UPLOAD = '__upload__';
/** Tamaño sugerido (m) del GLB normalizado a 1 unidad, según el tipo. */
const SCALE_HINT: Record<AssetType, string> = { tank: '3,5', pump: '2,5', valve: '1,2', sensor: '0,6', climate: '0,6', energy: '1,2', gas: '1,5', machine: '2,5', pressure: '0,6', flow: '0,8' };

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
    domain: domainFormFrom(meta),
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
  modules,
  onSaved,
  onModelUploaded,
}: {
  plant: string;
  /** Módulos contratados por el cliente dueño de la planta (`undefined` mientras se cargan: decide la API). */
  modules?: readonly ModuleId[];
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
  const { busy, error, run, clearError } = useSubmit();
  const set = <K extends keyof AssetForm>(k: K, v: AssetForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const liveMeta = parseMetadata(form.metadataText);
  const jsonOk = liveMeta.ok;
  const metaError = (metaTouched || errors.metadata) && !liveMeta.ok ? liveMeta.error : errors.metadata;
  // números no válidos o fuera de rango: en vivo; «falta X o Z»: sólo tras intentar guardar
  const domainErrors = form.domain ? validateDomainForm(form.domain, form.type).errors : {};
  const moduleError = error instanceof ModuleDisabledError ? error.message : undefined;
  const blocked = ASSET_TYPES.filter((t) => modules && !isTypeAllowed(t, modules) && t !== asset?.type);
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
  /** Los datos del equipo (capacidad, potencia contratada, escalas) también escriben en el JSON sin pisar otras claves. */
  function setDomain(update: (d: DomainForm) => DomainForm) {
    setForm((f) => {
      const domain = update(f.domain ?? domainFormFrom({}));
      const parsed = validateDomainForm(domain, f.type);
      const text = Object.keys(parsed.errors).length === 0 ? syncDomainIntoText(f.metadataText, parsed.value) : null;
      return { ...f, domain, ...(text !== null && { metadataText: text }) };
    });
  }
  function setMetadataText(text: string) {
    const fields = fieldsFromMetadataText(text);
    const domain = domainFromMetadataText(text);
    setForm((f) => ({ ...f, metadataText: text, ...(fields ?? {}), ...(domain && { domain }) }));
  }

  const currentRef = form.model3dRef;
  const known = models.some((m) => `model:${m.id}` === currentRef);
  // un valor antiguo (texto libre, p. ej. «tank») equivale a «sin modelo»: se muestra como procedural
  const selectValue = uploadMode ? UPLOAD : MODEL_REF_PATTERN.test(currentRef) ? currentRef : '';
  const candidates = useMemo(() => assets.filter((a) => a.id !== (asset?.id ?? form.id.trim())), [assets, asset?.id, form.id]);
  const orphans = form.connectsTo.filter((id) => !assets.some((a) => a.id === id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateAssetForm(form, { editing, keepRef: asset?.model3dRef, modules, originalType: asset?.type });
    setErrors(errs);
    setSubmitted(true);
    setMetaTouched(true);
    if (!value) return;
    const api = getAdminApi();
    const saved = await run<AssetResult>(() =>
      asset
        ? api.updateAsset(plant, asset.id, {
            name: value.name,
            ...(value.type !== asset.type && { type: value.type }),
            metadata: value.metadata,
            // el valor antiguo (texto libre) sólo se reenvía si se cambia; si no, se omite
            ...(value.model3dRef !== asset.model3dRef && { model3dRef: value.model3dRef }),
          })
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
            hint={editing ? 'El id no se puede cambiar una vez creado.' : 'Es el que publica el sensor por MQTT (p. ej. tk-05). No se puede cambiar después.'}
            data-autofocus={editing ? undefined : ''}
          />
          <TextField label="Nombre" value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} autoComplete="off" data-autofocus={editing ? '' : undefined} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Tipo"
            value={form.type}
            onChange={(e) => {
              clearError();
              setErrors((x) => ({ ...x, type: '' }));
              setForm((f) => ({ ...f, type: e.target.value as AssetType }));
            }}
            error={errors.type || moduleError}
            hint={blocked.length > 0 ? 'Los tipos marcados como «no contratado» necesitan un módulo que no está contratado. Para sumarlo, contactá a Campos Ingeniería.' : undefined}
          >
            {ASSET_TYPES.filter((t) => !blocked.includes(t)).map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
            {blocked.length > 0 && (
              <optgroup label="Requieren otro módulo">
                {blocked.map((t) => (
                  <option key={t} value={t} disabled>
                    {typeLabel(t)} (no contratado)
                  </option>
                ))}
              </optgroup>
            )}
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
            {MODEL_REF_PATTERN.test(currentRef) && !known && <option value={currentRef}>Modelo no encontrado ({currentRef})</option>}
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
            Metros desde el centro. Dejá X y Z vacíos para colocarlo automáticamente. La escala es el tamaño máximo del modelo en metros
            {form.type ? ` (sugerida para ${typeLabel(form.type as AssetType).toLowerCase()}: ${SCALE_HINT[form.type as AssetType]})` : ''}.
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
          {!jsonOk && <p className="mt-2 text-xs text-warn">Corregí el JSON de metadatos para editar estos campos.</p>}
        </fieldset>

        {form.domain && (form.type === 'tank' || form.type === 'energy' || scaleMetricsFor(form.type).length > 0) && (
          <fieldset className="rounded-xl border border-line p-3" disabled={!jsonOk} data-testid="domain-fields">
            <legend className="px-1 text-sm font-semibold">Datos del equipo (opcionales)</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {form.type === 'tank' && (
                <TextField
                  label="Capacidad (m³)"
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.domain.capacityM3}
                  onChange={(e) => setDomain((d) => ({ ...d, capacityM3: e.target.value }))}
                  error={domainErrors.capacityM3}
                  placeholder="60"
                  hint="Sirve para mostrar cuánto líquido hay, no sólo el porcentaje."
                />
              )}
              {form.type === 'energy' && (
                <TextField
                  label="Potencia contratada (kW)"
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.domain.contractedKw}
                  onChange={(e) => setDomain((d) => ({ ...d, contractedKw: e.target.value }))}
                  error={domainErrors.contractedKw}
                  placeholder="220"
                  hint="Se usa para avisar cuando el consumo se acerca a lo contratado."
                />
              )}
            </div>
            {scaleMetricsFor(form.type).length > 0 && (
              <div className="mt-3 flex flex-col gap-3">
                <p className="text-xs text-muted">Rango de las barras. Si lo dejás vacío se usa el habitual de cada medida.</p>
                {scaleMetricsFor(form.type).map((m) => {
                  const def = METRICS[m]!;
                  const r = form.domain?.scale[m] ?? { min: '', max: '' };
                  const put = (k: 'min' | 'max', v: string) => setDomain((d) => ({ ...d, scale: { ...d.scale, [m]: { ...(d.scale[m] ?? { min: '', max: '' }), [k]: v } } }));
                  return (
                    <fieldset key={m} className="grid grid-cols-2 gap-3" data-testid={`scale-${m}`}>
                      <legend className="col-span-2 mb-1 text-sm font-semibold">
                        {def.label}
                        {def.unit ? ` (${def.unit})` : ''}
                      </legend>
                      <TextField label="Mínimo" inputMode="decimal" autoComplete="off" value={r.min} onChange={(e) => put('min', e.target.value)} placeholder={String(def.scale.min)} />
                      <TextField label="Máximo" inputMode="decimal" autoComplete="off" value={r.max} onChange={(e) => put('max', e.target.value)} placeholder={String(def.scale.max)} />
                      {domainErrors[`scale:${m}`] && <p className="col-span-2 text-sm font-medium text-crit">{domainErrors[`scale:${m}`]}</p>}
                    </fieldset>
                  );
                })}
              </div>
            )}
            {!jsonOk && <p className="mt-2 text-xs text-warn">Corregí el JSON de metadatos para editar estos campos.</p>}
          </fieldset>
        )}

        <fieldset className="rounded-xl border border-line p-3" disabled={!jsonOk}>
          <legend className="px-1 text-sm font-semibold">Conectado a</legend>
          <p className="mb-2 text-xs text-muted">Se dibuja una tubería desde este activo hasta los marcados.</p>
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
          label="Metadatos (JSON)"
          rows={6}
          value={form.metadataText}
          onChange={(e) => setMetadataText(e.target.value)}
          onBlur={() => setMetaTouched(true)}
          error={metaError}
          spellCheck={false}
          placeholder='{"capacityM3": 60}'
          hint="Objeto JSON con datos libres del equipo. Incluye layout, connectsTo, capacityM3, contractedKw y scale, que se mantienen sincronizados con los campos de arriba."

        />
        {!moduleError && <ApiErrorAlert error={error} />}
        {submitted && Object.keys(layoutErrors).length > 0 && <Alert tone="error">Revisá la disposición en la planta: hay valores no válidos.</Alert>}
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

