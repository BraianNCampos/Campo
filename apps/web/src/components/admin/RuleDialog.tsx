'use client';

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { METRICS } from '@campo/shared';
import type { AlarmKind, AssetDef, AssetType } from '@campo/shared';
import { getAdminApi, ROC_DIRECTIONS, SEVERITIES, SUPPRESS_OPERATORS } from '@/lib/admin';
import {
  emptyRuleForm, KIND_HELP, KIND_NAME, LIMITS, OPERATOR_LABEL, operatorsFor, previewFromForm, ROC_LABEL, RULE_KINDS, ruleToForm,
  setpointMessage, setpointStatus, SUPPRESS_LABEL, validateRuleForm, withKind, type RuleForm,
} from '@/lib/admin/rule-form';
import { metricLabel, metricsForAssets, type FieldErrors } from '@/lib/admin/validation';
import type { AlarmRule, Operator, RocDirection, Severity, SuppressOperator } from '@/lib/admin/types';
import { usePlantStore } from '@/store/plant-store';
import { toast } from '@/store/toast-store';
import { IconInfo, IconWarning } from '../icons';
import { CheckField, SelectField, TextAreaField, TextField } from './fields';
import { useSubmit } from './hooks';
import { Modal, ModalActions } from './Modal';
import { ApiErrorAlert, Button } from './ui';

const SEVERITY_LABEL: Record<Severity, string> = { warning: 'Advertencia', critical: 'Crítica' };

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
      <legend className="mb-1 text-xs font-bold tracking-wide text-muted uppercase">{title}</legend>
      {hint && <p className="-mt-1 text-sm text-muted">{hint}</p>}
      {children}
    </fieldset>
  );
}

const Counter = ({ value, max }: { value: string; max: number }) => <span className={value.trim().length > max ? 'text-crit' : ''}>{value.trim().length}/{max}</span>;

/** Alta y edición de una regla de alarma ISA-18.2 (docs/architecture.md §12.1). */
export function RuleDialog({
  rule,
  defaultPlant,
  moduleTypes,
  onClose,
  onSaved,
}: {
  rule?: AlarmRule;
  defaultPlant: string;
  /** tipos del módulo elegido en el filtro (limita las sugerencias) */
  moduleTypes?: readonly AssetType[];
  onClose: () => void;
  onSaved: (r: AlarmRule) => void;
}) {
  const api = getAdminApi();
  const plants = usePlantStore((s) => s.plants);
  const listId = useId();
  const supId = useId();
  const [form, setForm] = useState<RuleForm>(rule ? ruleToForm(rule) : emptyRuleForm(defaultPlant));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [plantAssets, setPlantAssets] = useState<AssetDef[]>([]);
  const { busy, error, run } = useSubmit();
  const clear = (key: string) => setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    clear(k);
  };
  const setSup = <K extends keyof RuleForm['suppress']>(k: K, v: RuleForm['suppress'][K]) => {
    setForm((f) => ({ ...f, suppress: { ...f.suppress, [k]: v } }));
    clear(`suppress.${k}`);
  };

  // sugerencias de activos de la planta elegida (best-effort)
  useEffect(() => {
    let cancelled = false;
    if (!form.plant) return;
    api
      .listAssets(form.plant)
      .then((a) => !cancelled && setPlantAssets(a))
      .catch(() => !cancelled && setPlantAssets([]));
    return () => {
      cancelled = true;
    };
  }, [api, form.plant]);

  const scoped = useMemo(() => (moduleTypes && moduleTypes.length > 0 ? plantAssets.filter((a) => moduleTypes.includes(a.type)) : plantAssets), [plantAssets, moduleTypes]);
  // métricas según el tipo de los activos que abarca el id o patrón (registro compartido); sin coincidencias, ninguna sugerencia
  const suggested = useMemo(() => metricsForAssets(form.asset, scoped), [form.asset, scoped]);
  const supMetrics = useMemo(() => (form.suppress.asset.trim() ? metricsForAssets(form.suppress.asset, plantAssets) : []), [form.suppress.asset, plantAssets]);
  const metricDef = METRICS[form.metric.trim()];
  const preview = useMemo(() => previewFromForm(form, plantAssets), [form, plantAssets]);
  const spStatus = form.kind === 'DEV' ? setpointStatus(form.asset, form.metric, plantAssets) : 'unknown';
  const spNote = setpointMessage(spStatus, form.metric);
  const kind = form.kind;
  const isThreshold = kind !== 'DEV' && kind !== 'ROC';
  const unit = metricDef?.unit ? ` ${metricDef.unit}` : '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateRuleForm(form, { editing: !!rule });
    setErrors(errs);
    if (!value) return;
    const saved = await run(() => (rule ? api.updateRule(rule.id, value) : api.createRule(value)));
    if (saved) {
      toast.success(rule ? 'Regla actualizada.' : 'Regla creada.');
      onSaved(saved);
      onClose();
    }
  }

  const thresholdLabel = kind === 'DEV' ? 'Desvío máximo' : kind === 'ROC' ? 'Cambio máximo por minuto' : 'Umbral';
  const thresholdHint =
    kind === 'DEV' ? `Cuánto puede alejarse del setpoint${unit ? ` (en${unit})` : ''}, para arriba o para abajo.`
    : kind === 'ROC' ? `Cuánto puede cambiar en un minuto${unit ? ` (${unit.trim()}/min)` : ''}.`
    : metricDef ? `En ${metricDef.unit || 'valor sin unidad'}. Rango habitual: ${metricDef.scale.min} a ${metricDef.scale.max}.` : undefined;

  return (
    <Modal title={rule ? 'Editar regla de alarma' : 'Nueva regla de alarma'} onClose={onClose} closable={!busy} size="lg">
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Planta" value={form.plant} onChange={(e) => set('plant', e.target.value)} error={errors.plant} data-autofocus>
            <option value="">Elegí una planta…</option>
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </SelectField>
          <div>
            <TextField
              label="Activo o patrón"
              value={form.asset}
              onChange={(e) => set('asset', e.target.value)}
              error={errors.asset}
              list={listId}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="tk-*"
              hint="Id exacto (tk-01) o patrón con * (tk-*, *)."
            />
            <datalist id={listId}>
              <option value="*" />
              {scoped.map((a) => (
                <option key={a.id} value={a.id} label={a.name} />
              ))}
            </datalist>
          </div>
        </div>
        <div>
          <TextField label="Métrica" value={form.metric} onChange={(e) => set('metric', e.target.value)} error={errors.metric} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="level" />
          {suggested.length > 0 && (
            <div role="group" aria-label="Medidas sugeridas" className="mt-2 flex flex-wrap gap-1.5" data-testid="metric-suggestions">
              {suggested.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={form.metric.trim() === m}
                  onClick={() => set('metric', m)}
                  className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${form.metric.trim() === m ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-surface-2 text-fg hover:bg-line'}`}
                >
                  {metricLabel(m)}
                </button>
              ))}
            </div>
          )}
        </div>

        <Section title="Tipo de alarma">
          <div role="radiogroup" aria-label="Tipo de alarma" className="flex flex-wrap gap-2" data-testid="kind-picker">
            {RULE_KINDS.map((k: AlarmKind) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                data-testid={`kind-${k}`}
                onClick={() => setForm((f) => withKind(f, k))}
                className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${kind === k ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-surface-2 text-fg hover:bg-line'}`}
              >
                <span className="font-mono">{k}</span> <span className={kind === k ? '' : 'text-muted'}>{KIND_NAME[k]}</span>
              </button>
            ))}
          </div>
          <p className="flex items-start gap-2 text-sm text-muted" data-testid="kind-help"><IconInfo className="mt-0.5 shrink-0 text-base" />{KIND_HELP[kind]}</p>
          <div className={`grid gap-4 ${isThreshold ? 'sm:grid-cols-3' : kind === 'ROC' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            {isThreshold && (
              <SelectField label="Operador" value={form.operator} onChange={(e) => set('operator', e.target.value as Operator)} error={errors.operator}>
                {operatorsFor(kind).map((o) => (
                  <option key={o} value={o}>
                    {OPERATOR_LABEL[o]}
                  </option>
                ))}
              </SelectField>
            )}
            <TextField label={thresholdLabel} type="text" inputMode="decimal" value={form.threshold} onChange={(e) => set('threshold', e.target.value)} error={errors.threshold} autoComplete="off" placeholder={kind === 'DEV' ? '6' : '90'} hint={thresholdHint} />
            {kind === 'ROC' && (
              <>
                <TextField label="Ventana (s)" type="text" inputMode="numeric" value={form.rocWindowSeconds} onChange={(e) => set('rocWindowSeconds', e.target.value)} error={errors.rocWindowSeconds} autoComplete="off" hint={`Tiempo sobre el que se mide el cambio (${LIMITS.rocMin}–${LIMITS.rocMax} s).`} />
                <SelectField label="Dirección" value={form.rocDirection} onChange={(e) => set('rocDirection', e.target.value as RocDirection)} error={errors.rocDirection}>
                  {ROC_DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {ROC_LABEL[d]}
                    </option>
                  ))}
                </SelectField>
              </>
            )}
            <SelectField label="Severidad" value={form.severity} onChange={(e) => set('severity', e.target.value as Severity)} error={errors.severity} hint="Prioridad con la que se muestra.">
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </SelectField>
          </div>
          {spNote && (
            <p role="status" data-testid="sp-warning" className="flex items-start gap-2 rounded-lg border border-warn/60 bg-warn/10 px-3 py-2 text-sm text-warn">
              <IconWarning className="mt-0.5 shrink-0 text-base" /> <span><b>No evaluable por ahora.</b> {spNote}</span>
            </p>
          )}
        </Section>

        <Section title="Tiempos y banda muerta" hint="Evitan que una alarma salte y se normalice una y otra vez por una oscilación.">
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Mantener (s)" type="text" inputMode="numeric" value={form.forSeconds} onChange={(e) => set('forSeconds', e.target.value)} error={errors.forSeconds} hint="Segundos que debe sostenerse para activarse." autoComplete="off" />
            <TextField label="Retorno (s)" type="text" inputMode="numeric" value={form.offDelaySeconds} onChange={(e) => set('offDelaySeconds', e.target.value)} error={errors.offDelaySeconds} hint="Segundos que debe estar normal antes de normalizar." autoComplete="off" />
            <TextField label="Histéresis" type="text" inputMode="decimal" value={form.hysteresis} onChange={(e) => set('hysteresis', e.target.value)} error={errors.hysteresis} hint="Banda muerta: cuánto hay que volver para normalizar." autoComplete="off" />
          </div>
        </Section>

        <Section title="Supresión por estado" hint="Ejemplo: no avisar nivel bajo si la bomba está detenida por mantenimiento.">
          <CheckField label="No avisar mientras otro equipo esté en cierto estado" checked={form.suppressEnabled} onChange={(e) => set('suppressEnabled', e.target.checked)} />
          {form.suppressEnabled && (
            <div className="flex flex-col gap-3" data-testid="suppress-fields">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <TextField label="Activo a observar" value={form.suppress.asset} onChange={(e) => setSup('asset', e.target.value)} error={errors['suppress.asset']} list={supId} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="pump-01" />
                  <datalist id={supId}>
                    {plantAssets.map((a) => (
                      <option key={a.id} value={a.id} label={a.name} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <TextField label="Medida a observar" value={form.suppress.metric} onChange={(e) => setSup('metric', e.target.value)} error={errors['suppress.metric']} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="rpm" />
                  {supMetrics.length > 0 && (
                    <div role="group" aria-label="Medidas disponibles" className="mt-2 flex flex-wrap gap-1.5">
                      {supMetrics.map((m) => (
                        <button key={m} type="button" aria-pressed={form.suppress.metric.trim() === m} onClick={() => setSup('metric', m)} className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${form.suppress.metric.trim() === m ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-surface-2 text-fg hover:bg-line'}`}>
                          {metricLabel(m)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField label="Se suprime cuando" value={form.suppress.operator} onChange={(e) => setSup('operator', e.target.value as SuppressOperator)} error={errors['suppress.operator']}>
                  {SUPPRESS_OPERATORS.map((o) => (
                    <option key={o} value={o}>
                      {SUPPRESS_LABEL[o]}
                    </option>
                  ))}
                </SelectField>
                <TextField label="Valor de referencia" type="text" inputMode="decimal" value={form.suppress.value} onChange={(e) => setSup('value', e.target.value)} error={errors['suppress.value']} autoComplete="off" placeholder="1" />
              </div>
              <p className="text-xs text-muted">Mientras esa condición se cumpla sobre el último dato del activo observado, la alarma no se genera y se cuenta como suprimida.</p>
            </div>
          )}
        </Section>

        <Section title="Qué le decimos al operador" hint="La racionalización: por qué importa y qué hacer. Aparece en el detalle de la alarma.">
          <TextAreaField label="Descripción" value={form.description} onChange={(e) => set('description', e.target.value)} error={errors.description} rows={2} hint={<>Qué está pasando, en una frase. <Counter value={form.description} max={LIMITS.description} /></>} placeholder="Nivel muy alto en el tanque." />
          <TextAreaField label="Consecuencia" value={form.consequence} onChange={(e) => set('consequence', e.target.value)} error={errors.consequence} rows={2} hint={<>Qué pasa si no se atiende. <Counter value={form.consequence} max={LIMITS.consequence} /></>} placeholder="Riesgo de rebalse y pérdida de producto." />
          <TextAreaField label="Acción del operador" value={form.response} onChange={(e) => set('response', e.target.value)} error={errors.response} rows={2} hint={<>Qué tiene que hacer quien la recibe. <Counter value={form.response} max={LIMITS.response} /></>} placeholder="Cerrá la válvula de entrada y avisá a mantenimiento." />
        </Section>

        <Section title="Servicio">
          <CheckField label="Regla en servicio" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} hint="Si la sacás de servicio deja de avisar; queda registrado con el motivo." />
          {!form.enabled && (
            <TextField label="Motivo de fuera de servicio" value={form.outOfServiceReason} onChange={(e) => set('outOfServiceReason', e.target.value)} error={errors.outOfServiceReason} autoComplete="off" placeholder="Sensor en calibración" hint="Obligatorio (mínimo 3 caracteres)." />
          )}
        </Section>

        {preview && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted" data-testid="rule-preview">
            {preview.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        )}
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {rule ? 'Guardar cambios' : 'Crear regla'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
