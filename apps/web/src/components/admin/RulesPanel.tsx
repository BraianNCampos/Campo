'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { ID_PATTERN, MODULES } from '@campo/shared';
import type { AssetDef, ModuleId } from '@campo/shared';
import { getAdminApi, SEVERITIES } from '@/lib/admin';
import { ruleMatchesAsset } from '@/lib/admin/validation';
import { conditionText, kindOf } from '@/lib/admin/rule-form';
import type { AlarmRule, Severity } from '@/lib/admin/types';
import { errorMessage } from '@/lib/admin/errors';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconCritical, IconEdit, IconPlus, IconRules, IconTrash, IconWarning } from '../icons';
import { KindBadge } from '../alarms/badges';
import { RequireSection } from './AdminShell';
import { RuleDialog } from './RuleDialog';
import { SelectField, Switch, TextField } from './fields';
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

const condition = conditionText;
const timing = (r: AlarmRule) => `${r.forSeconds} s${r.offDelaySeconds ? ` → ${r.offDelaySeconds} s` : ''}${r.hysteresis ? ` · hist. ${r.hysteresis}` : ''}`;

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

/** Sacar una regla de servicio: el motivo es obligatorio (≥ 3 caracteres) y queda auditado (`rule.out_of_service`). */
function OutOfServiceDialog({ rule, onClose, onSaved }: { rule: AlarmRule; onClose: () => void; onSaved: (r: AlarmRule) => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = reason.trim();
    if (r.length < 3) return setErr('Contanos el motivo (mínimo 3 caracteres).');
    setErr(undefined);
    const saved = await run(() => getAdminApi().updateRule(rule.id, { enabled: false, outOfServiceReason: r }));
    if (saved) {
      toast.success('Regla fuera de servicio.');
      onSaved(saved);
      onClose();
    }
  }
  return (
    <Modal title="Sacar la regla de servicio" description={<>Deja de avisar <span className="font-mono">{rule.asset} {conditionText(rule)}</span> hasta que la vuelvas a poner en servicio. Queda registrado con tu nombre y el motivo.</>} onClose={onClose} closable={!busy} size="sm">
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4" data-testid="oos-form">
        <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} error={err} autoComplete="off" placeholder="Sensor en calibración" data-autofocus />
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={busy}>Sacar de servicio</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Avisos de una regla: no evaluable (DEV sin setpoint), con supresión, con racionalización, fuera de servicio y su motivo. */
function RuleNotes({ r }: { r: AlarmRule }) {
  const notes: { text: string; tone: 'warning' | 'neutral'; testid: string }[] = [];
  if (r.status === 'no_setpoint' || (r.status === undefined && r.enabled && r.evaluable === false)) notes.push({ text: 'No evaluable: falta el setpoint', tone: 'warning', testid: 'rule-not-evaluable' });
  if (r.suppressWhen) notes.push({ text: `Se suprime si ${r.suppressWhen.asset} ${r.suppressWhen.metric} ${r.suppressWhen.operator === 'lt' ? '<' : r.suppressWhen.operator === 'gt' ? '>' : r.suppressWhen.operator === 'eq' ? '=' : '≠'} ${r.suppressWhen.value}`, tone: 'neutral', testid: 'rule-suppress' });
  if (!r.enabled && r.outOfServiceReason) notes.push({ text: `Motivo: ${r.outOfServiceReason}`, tone: 'neutral', testid: 'rule-oos-reason' });
  if (notes.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1.5 font-sans font-normal">
      {notes.map((n) => (
        <span key={n.testid} data-testid={n.testid}><Badge tone={n.tone === 'warning' ? 'warning' : 'neutral'} icon={n.tone === 'warning' ? <IconWarning /> : undefined}>{n.text}</Badge></span>
      ))}
    </span>
  );
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
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit' | 'delete' | 'oos'; rule: AlarmRule } | null>(null);
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
    if (!enabled) return setDialog({ kind: 'oos', rule: r }); // sacar de servicio pide el motivo
    setToggling(r.id);
    setToggleError(null);
    try {
      const u = await getAdminApi().updateRule(r.id, { enabled: true });
      upsert(u);
      toast.success('Regla puesta en servicio.');
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
    <Switch checked={r.enabled} disabled={toggling === r.id} onChange={(v) => void toggle(r, v)} onText="En servicio" offText="Fuera de servicio" label={`Regla ${r.asset} ${condition(r)}: ${r.enabled ? 'activa' : 'fuera de servicio'}`} />
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
                  <th scope="col" className={th}>Tipo</th>
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
                    <td className={td}><KindBadge kind={kindOf(r)} /></td>
                    <td className={`${td} font-mono font-semibold`}>{condition(r)}<RuleNotes r={r} /></td>
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
                  <p className="flex flex-wrap items-center gap-2 font-mono text-base font-semibold"><KindBadge kind={kindOf(r)} />{condition(r)}</p>
                  <SeverityBadge severity={r.severity} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  <span className="font-mono">{r.plant}</span> / <span className="font-mono">{r.asset}</span> · {timing(r)}
                </p>
                <RuleNotes r={r} />
                <div className="mt-1">{sw(r)}</div>
                <div className="mt-2 grid grid-cols-2 gap-2">{rowActions(r)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog?.kind === 'create' && <RuleDialog defaultPlant={fPlant || selected || ''} moduleTypes={moduleTypes} onClose={() => setDialog(null)} onSaved={upsert} />}
      {dialog?.kind === 'edit' && <RuleDialog rule={dialog.rule} defaultPlant={dialog.rule.plant} onClose={() => setDialog(null)} onSaved={upsert} />}
      {dialog?.kind === 'oos' && <OutOfServiceDialog rule={dialog.rule} onClose={() => setDialog(null)} onSaved={upsert} />}
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
