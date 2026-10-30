'use client';

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { ID_PATTERN, METRICS, MODULES } from '@campo/shared';
import type { AssetDef, AssetType, ModuleId } from '@campo/shared';
import { getAdminApi, OPERATORS, SEVERITIES } from '@/lib/admin';
import {
  describeRule,
  emptyRuleForm,
  metricLabel,
  metricsForAssets,
  OPERATOR_LABEL,
  OPERATOR_SYMBOL,
  ruleMatchesAsset,
  validateRuleForm,
  type FieldErrors,
  type RuleForm,
} from '@/lib/admin/validation';
import type { AlarmRule, Operator, Severity } from '@/lib/admin/types';
import { errorMessage } from '@/lib/admin/errors';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconCritical, IconEdit, IconPlus, IconRules, IconTrash, IconWarning } from '../icons';
import { RequireSection } from './AdminShell';
import { CheckField, SelectField, Switch, TextField } from './fields';
import { useLoad, useSubmit } from './hooks';
import { ConfirmDialog, Modal, ModalActions } from './Modal';
import { Alert, ApiErrorAlert, Badge, Button, btn, card, cardList, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';

const SEVERITY_LABEL: Record<Severity, string> = { warning: 'Advertencia', critical: 'Crítica' };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return severity === 'critical' ? (
    <Badge tone="error" icon={<IconCritical />}>
      Crítica
    </Badge>
  ) : (
    <Badge tone="warning" icon={<IconWarning />}>
      Advertencia
    </Badge>
  );
}

const toForm = (r: AlarmRule): RuleForm => ({
  plant: r.plant,
  asset: r.asset,
  metric: r.metric,
  operator: r.operator,
  threshold: String(r.threshold),
  severity: r.severity,
  forSeconds: String(r.forSeconds),
  hysteresis: String(r.hysteresis),
  enabled: r.enabled,
});

function RuleDialog({ rule, defaultPlant, moduleTypes, onClose, onSaved }: { rule?: AlarmRule; defaultPlant: string; /** tipos del módulo elegido en el filtro (limita las sugerencias) */ moduleTypes?: readonly AssetType[]; onClose: () => void; onSaved: (r: AlarmRule) => void }) {
  const api = getAdminApi();
  const plants = usePlantStore((s) => s.plants);
  const listId = useId();
  const [form, setForm] = useState<RuleForm>(rule ? toForm(rule) : emptyRuleForm(defaultPlant));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [plantAssets, setPlantAssets] = useState<AssetDef[]>([]);
  const { busy, error, run } = useSubmit();
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setForm((f) => ({ ...f, [k]: v }));

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
  const metricDef = METRICS[form.metric.trim()];

  const preview = useMemo(() => {
    const t = Number(form.threshold);
    const h = Number(form.hysteresis);
    const f = Number(form.forSeconds);
    if (!form.metric.trim() || form.threshold.trim() === '' || !Number.isFinite(t) || !form.operator) return null;
    return describeRule({ metric: form.metric.trim(), operator: form.operator as Operator, threshold: t, forSeconds: Number.isFinite(f) ? f : 0, hysteresis: Number.isFinite(h) ? h : 0 });
  }, [form]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateRuleForm(form);
    setErrors(errs);
    if (!value) return;
    const saved = await run(() => (rule ? api.updateRule(rule.id, value) : api.createRule(value)));
    if (saved) {
      toast.success(rule ? 'Regla actualizada.' : 'Regla creada.');
      onSaved(saved);
      onClose();
    }
  }

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
        <div className="grid gap-4 sm:grid-cols-3">
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
          <SelectField label="Operador" value={form.operator} onChange={(e) => set('operator', e.target.value as Operator)} error={errors.operator}>
            {OPERATORS.map((o) => (
              <option key={o} value={o}>
                {OPERATOR_LABEL[o]}
              </option>
            ))}
          </SelectField>
          <TextField label="Umbral" type="text" inputMode="decimal" value={form.threshold} onChange={(e) => set('threshold', e.target.value)} error={errors.threshold} autoComplete="off" placeholder="90" hint={metricDef ? `En ${metricDef.unit || 'valor sin unidad'}. Rango habitual: ${metricDef.scale.min} a ${metricDef.scale.max}.` : undefined} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Severidad" value={form.severity} onChange={(e) => set('severity', e.target.value as Severity)} error={errors.severity}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </SelectField>
          <TextField label="Mantener (s)" type="text" inputMode="numeric" value={form.forSeconds} onChange={(e) => set('forSeconds', e.target.value)} error={errors.forSeconds} hint="Segundos que debe sostenerse." autoComplete="off" />
          <TextField label="Histéresis" type="text" inputMode="decimal" value={form.hysteresis} onChange={(e) => set('hysteresis', e.target.value)} error={errors.hysteresis} hint="Banda para normalizar." autoComplete="off" />
        </div>
        <CheckField label="Regla activa" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        {preview && (
          <p className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted" data-testid="rule-preview">
            {preview}
          </p>
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

const condition = (r: AlarmRule) => `${r.metric} ${OPERATOR_SYMBOL[r.operator]} ${r.threshold}`;
const timing = (r: AlarmRule) => `${r.forSeconds} s${r.hysteresis ? ` · hist. ${r.hysteresis}` : ''}`;

/** Parámetros de la URL: `?plant=<id>&module=<id>` (los enlaza la pantalla de cada módulo). Sólo se aceptan valores conocidos. */
function useRuleParams(plantIds: readonly string[]): { plant: string; module: ModuleId | '' } {
  const params = useSearchParams();
  const plant = params.get('plant') ?? '';
  const mod = params.get('module') ?? '';
  return {
    plant: ID_PATTERN.test(plant) && plantIds.includes(plant) ? plant : '',
    module: MODULES.some((m) => m.id === mod) ? (mod as ModuleId) : '',
  };
}

function RulesContent() {
  const rules = useLoad(() => getAdminApi().listRules());
  const plants = usePlantStore((s) => s.plants);
  const selected = usePlantStore((s) => s.selected);
  const role = useSessionStore((s) => s.me?.role);
  const initial = useRuleParams(plants.map((p) => p.id));
  const [fPlant, setFPlant] = useState(initial.plant);
  const [fModule, setFModule] = useState<ModuleId | ''>(initial.module);
  // si el enlace cambia (otra pantalla de módulo) se vuelven a aplicar sus parámetros
  const [seen, setSeen] = useState(initial);
  if (seen.plant !== initial.plant || seen.module !== initial.module) {
    setSeen(initial);
    setFPlant(initial.plant);
    setFModule(initial.module);
  }
  const [fAsset, setFAsset] = useState('');
  const [fSeverity, setFSeverity] = useState<'' | Severity>('');
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit' | 'delete'; rule: AlarmRule } | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // El filtro por módulo necesita saber de qué tipo es cada activo: se piden los catálogos de las plantas en juego.
  const moduleDef = MODULES.find((m) => m.id === fModule);
  const moduleTypes = moduleDef && moduleDef.assetTypes.length > 0 ? moduleDef.assetTypes : undefined;
  const scopePlants = fPlant ? [fPlant] : plants.map((p) => p.id);
  const catalogs = useLoad(async () => {
    if (!moduleTypes) return {} as Record<string, AssetDef[]>;
    const api = getAdminApi();
    const entries = await Promise.all(scopePlants.map(async (p) => [p, await api.listAssets(p).catch(() => [] as AssetDef[])] as const));
    return Object.fromEntries(entries);
  }, [fModule, scopePlants.join()]);

  const all = rules.data;
  const filtered = useMemo(
    () =>
      (all ?? []).filter((r) => {
        if (fPlant && r.plant !== fPlant) return false;
        if (fSeverity && r.severity !== fSeverity) return false;
        if (fAsset.trim() && !(r.asset.includes(fAsset.trim()) || ruleMatchesAsset(r.asset, fAsset.trim()))) return false;
        if (moduleTypes) {
          const inModule = (catalogs.data?.[r.plant] ?? []).filter((a) => moduleTypes.includes(a.type));
          if (!inModule.some((a) => ruleMatchesAsset(r.asset, a.id))) return false;
        }
        return true;
      }),
    [all, fPlant, fAsset, fSeverity, moduleTypes, catalogs.data],
  );
  const filteringModule = !!moduleTypes && catalogs.loading && !catalogs.data;
  const upsert = (r: AlarmRule) =>
    rules.setData((prev) => (prev?.some((x) => x.id === r.id) ? prev.map((x) => (x.id === r.id ? r : x)) : [...(prev ?? []), r]));

  async function toggle(r: AlarmRule, enabled: boolean) {
    setToggling(r.id);
    setToggleError(null);
    try {
      const u = await getAdminApi().updateRule(r.id, { enabled });
      upsert(u);
      toast.success(`Regla ${enabled ? 'activada' : 'desactivada'}.`);
    } catch (e) {
      setToggleError(errorMessage(e));
    } finally {
      setToggling(null);
    }
  }

  const rowActions = (r: AlarmRule) => (
    <>
      <Button onClick={() => setDialog({ kind: 'edit', rule: r })} aria-label={`Editar regla ${r.asset} ${condition(r)}`}>
        <IconEdit className="text-base" /> Editar
      </Button>
      <Button variant="danger" onClick={() => setDialog({ kind: 'delete', rule: r })} aria-label={`Eliminar regla ${r.asset} ${condition(r)}`}>
        <IconTrash className="text-base" /> Eliminar
      </Button>
    </>
  );
  const sw = (r: AlarmRule) => (
    <Switch checked={r.enabled} disabled={toggling === r.id} onChange={(v) => void toggle(r, v)} label={`Regla ${r.asset} ${condition(r)}: ${r.enabled ? 'activa' : 'inactiva'}`} />
  );

  return (
    <>
      <PageHeader
        title="Reglas de alarma"
        description="Cuándo se activa una alarma para un activo (o un patrón de activos) de una planta."
        actions={
          <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
            <IconPlus className="text-lg" /> Nueva regla
          </Button>
        }
      />
      {moduleDef && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="module-filter">
          <span className="text-muted">Mostrando sólo las reglas de</span>
          <span className="inline-flex min-h-6 items-center rounded-full border border-line bg-surface-2 px-2.5 text-xs font-semibold">{moduleDef.label}</span>
          <button type="button" onClick={() => setFModule('')} className={btn('ghost', 'min-h-11')}>
            Quitar filtro
          </button>
        </p>
      )}
      <form role="search" aria-label="Filtros de reglas" className="mb-4 grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()}>
        <SelectField label="Planta" value={fPlant} onChange={(e) => setFPlant(e.target.value)}>
          <option value="">Todas</option>
          {plants.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>
        <TextField label="Activo" value={fAsset} onChange={(e) => setFAsset(e.target.value)} placeholder="tk-01" autoComplete="off" />
        <SelectField label="Severidad" value={fSeverity} onChange={(e) => setFSeverity(e.target.value as '' | Severity)}>
          <option value="">Todas</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}
            </option>
          ))}
        </SelectField>
      </form>
      {toggleError && (
        <Alert tone="error" onDismiss={() => setToggleError(null)} className="mb-4">
          {toggleError}
        </Alert>
      )}
      {rules.error != null && <ErrorState error={rules.error} onRetry={rules.reload} />}
      {rules.loading && !all && rules.error == null && <LoadingBlock label="Cargando reglas…" />}
      {all && all.length === 0 && (
        <EmptyState icon={<IconRules />} title="No hay reglas de alarma">
          {role === 'viewer' || role === 'operator' ? '' : 'Creá la primera con «Nueva regla».'}
        </EmptyState>
      )}
      {all && all.length > 0 && filtered.length === 0 && !filteringModule && <EmptyState title="Ninguna regla coincide con los filtros">Cambiá o limpiá los filtros.</EmptyState>}
      {filtered.length > 0 && (
        <>
          <p className="mb-2 text-sm text-muted" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'regla' : 'reglas'}
          </p>
          <div className={tableWrap}>
            <table className="w-full" data-testid="rules-table">
              <caption className="sr-only">Reglas de alarma</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Planta</th>
                  <th scope="col" className={th}>Activo</th>
                  <th scope="col" className={th}>Condición</th>
                  <th scope="col" className={th}>Severidad</th>
                  <th scope="col" className={th}>Mantener</th>
                  <th scope="col" className={th}>Estado</th>
                  <th scope="col" className={`${th} text-right`}>Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((r) => (
                  <tr key={r.id} data-testid={`rule-row-${r.id}`}>
                    <td className={`${td} font-mono`}>{r.plant}</td>
                    <td className={`${td} font-mono`}>{r.asset}</td>
                    <td className={`${td} font-mono font-semibold`}>{condition(r)}</td>
                    <td className={td}><SeverityBadge severity={r.severity} /></td>
                    <td className={`${td} text-muted`}>{timing(r)}</td>
                    <td className={td}>{sw(r)}</td>
                    <td className={td}>
                      <div className="flex flex-wrap justify-end gap-2">{rowActions(r)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {filtered.map((r) => (
              <li key={r.id} className={card} data-testid={`rule-card-${r.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-mono text-base font-semibold">{condition(r)}</p>
                  <SeverityBadge severity={r.severity} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  <span className="font-mono">{r.plant}</span> / <span className="font-mono">{r.asset}</span> · {timing(r)}
                </p>
                <div className="mt-1">{sw(r)}</div>
                <div className="mt-2 grid grid-cols-2 gap-2">{rowActions(r)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog?.kind === 'create' && <RuleDialog defaultPlant={fPlant || selected || ''} moduleTypes={moduleTypes} onClose={() => setDialog(null)} onSaved={upsert} />}
      {dialog?.kind === 'edit' && <RuleDialog rule={dialog.rule} defaultPlant={dialog.rule.plant} onClose={() => setDialog(null)} onSaved={upsert} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Eliminar regla de alarma"
          description={
            <>
              Se eliminará la regla <span className="font-mono">{dialog.rule.asset} {condition(dialog.rule)}</span> de la planta <span className="font-mono">{dialog.rule.plant}</span>. Las alarmas activas dejan de evaluarse.
            </>
          }
          confirmLabel="Eliminar regla"
          onConfirm={async () => {
            await getAdminApi().deleteRule(dialog.rule.id);
            rules.setData((prev) => (prev ?? []).filter((x) => x.id !== dialog.rule.id));
            toast.success('Regla eliminada.');
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function RulesPanel() {
  return (
    <RequireSection section="rules">
      <RulesContent />
    </RequireSection>
  );
}
