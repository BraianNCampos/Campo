'use client';

import { useEffect, useMemo, useState } from 'react';
import { ASSET_KINDS, type AssetDef, type InterlockItem } from '@campo/shared';
import { getControlApi } from '@/lib/control';
import { controlMessage } from '@/lib/control/errors';
import { canEditSetpoint, canSeeEquipment, summarizeInterlocks } from '@/lib/control/interlocks';
import { validateSetpoint, withSetpoint } from '@/lib/control/setpoint';
import { metricMeta } from '@/lib/metrics';
import { fmtNum } from '@/lib/modules/kpis';
import { hasMotor, stsOf, supportsSetpoint } from '@/lib/modules/unit';
import { displayTag } from '@/lib/tags';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { ToastRegion } from '../admin/ToastRegion';
import { ConfirmDialog } from '../admin/Modal';
import { TextField } from '../admin/fields';
import { useLoad } from '../admin/hooks';
import { Alert, Button, LoadingBlock } from '../admin/ui';
import { IconCheck, IconCritical, IconLock, IconPause, IconPower } from '../icons';
import { useCardData } from '../modules/useCardData';
import { UnitHeader } from './UnitScreen';
import { UnitGate } from './UnitFrame';
import { useUnit } from './useUnit';

const tile = 'rounded-xl border border-line bg-bg px-3 py-2.5';

function Tile({ label, value, unit, testid, note }: { label: string; value: string; unit?: string; testid: string; note?: string }) {
  return (
    <div className={tile} data-testid={testid}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-2xl leading-tight font-bold tabular-nums">
        <span className="font-mono">{value}</span>
        {unit && <span className="ml-1 text-sm font-medium text-muted">{unit}</span>}
      </dd>
      {note && <p className="text-[11px] text-muted">{note}</p>}
    </div>
  );
}

/** Panel de motor: estado (STS), velocidad, corriente y horas de marcha. Para equipos sin motor, las lecturas disponibles. */
function MotorPanel({ def }: { def: AssetDef }) {
  const values = useLiveStore((s) => s.assets[def.id]?.values);
  const sts = stsOf(def, values);
  const Icon = sts.tone === 'fault' ? IconCritical : sts.tone === 'idle' ? IconPause : IconPower;
  const motor = hasMotor(def.type);
  const entries = Object.entries(values ?? {}).filter(([k]) => !['sts', 'mode', 'op', 'sp'].includes(k));
  return (
    <section aria-label={motor ? 'Panel de motor' : 'Lecturas del equipo'} data-testid="motor-panel" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <h2 className="text-base font-bold">{motor ? 'Panel de motor' : 'Lecturas del equipo'}</h2>
      {!values ? (
        <p className="mt-2 text-sm text-muted">Todavía no llegaron datos de este equipo.</p>
      ) : motor ? (
        <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className={tile} data-testid="motor-sts">
            <dt className="font-mono text-[11px] font-semibold tracking-wider text-muted">STS · Estado</dt>
            <dd className={`mt-0.5 flex items-center gap-1.5 text-2xl leading-tight font-bold ${sts.tone === 'fault' ? 'text-crit' : sts.tone === 'idle' ? 'text-muted' : ''}`}>
              <Icon className="text-xl" /> {sts.label}
            </dd>
          </div>
          <Tile testid="motor-rpm" label="Velocidad" value={values.rpm === undefined ? '—' : fmtNum(values.rpm, 0)} unit={values.rpm === undefined ? undefined : 'rpm'} />
          <Tile testid="motor-current" label="Corriente" value={values.current === undefined ? '—' : fmtNum(values.current, 1)} unit={values.current === undefined ? undefined : 'A'} />
          <Tile
            testid="motor-hours"
            label="Horas de marcha"
            value={values.hours === undefined ? '—' : fmtNum(values.hours, 1)}
            unit={values.hours === undefined ? undefined : 'h'}
            note={values.hours === undefined ? 'Este equipo no informa horas de marcha.' : undefined}
          />
        </dl>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {entries.map(([k, v]) => {
            const m = metricMeta(k);
            return <Tile key={k} testid={`reading-${k}`} label={m.label} value={fmtNum(v, m.decimals)} unit={m.unit || undefined} />;
          })}
        </dl>
      )}
    </section>
  );
}

/** Permisos de enclavamiento (`GET .../interlocks`): qué se cumple y qué no, con el motivo. Se refresca cada 5 s. */
function InterlockPanel({ def }: { def: AssetDef }) {
  const plant = usePlantStore((s) => s.selected) ?? '';
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const load = useLoad<InterlockItem[]>(() => getControlApi().interlocks(plant, def.id), [plant, def.id, tick]);
  const items = load.data;
  const sum = items ? summarizeInterlocks(items) : null;
  return (
    <section aria-label="Permisos de enclavamiento" data-testid="interlock-panel" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <h2 className="text-base font-bold">Permisos de enclavamiento</h2>
      <p className="mt-1 text-sm text-muted">Lo que el servidor exige antes de aceptar una orden en este equipo. Acá solo se muestran: no se pueden saltear.</p>
      {load.error != null && !items ? (
        <Alert tone="error" className="mt-3" role="alert">{controlMessage(load.error)}</Alert>
      ) : !items ? (
        <div className="mt-3"><LoadingBlock label="Consultando los permisos…" /></div>
      ) : items.length === 0 ? (
        <p data-testid="interlock-empty" className="mt-3 text-sm text-muted">Este equipo no recibe órdenes de control, así que no tiene permisos de enclavamiento.</p>
      ) : (
        <>
          <p data-testid="interlock-summary" className={`mt-3 flex items-center gap-2 text-sm font-semibold ${sum?.allOk ? 'text-calm' : 'text-warn'}`}>
            {sum?.allOk ? <IconCheck className="text-lg" /> : <IconLock className="text-lg" />}
            {sum?.allOk ? 'Se cumplen todos los permisos.' : `Se cumplen ${sum?.ok} de ${sum?.total}: hay órdenes que hoy no se podrían dar.`}
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {items.map((i) => (
              <li key={i.id} data-testid={`interlock-${i.id}`} data-ok={i.ok} className="flex items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm">
                {i.ok ? <IconCheck className="mt-0.5 shrink-0 text-base text-calm" /> : <IconCritical className="mt-0.5 shrink-0 text-base text-crit" />}
                <span>
                  <span className="font-semibold">{i.label}</span>
                  {!i.ok && i.reason && <span className="block text-muted">{i.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Ajuste del setpoint de la métrica principal (`engineer`+): valida contra la escala y confirma antes de guardar (queda auditado). */
function SetpointPanel({ def }: { def: AssetDef }) {
  const d = useCardData(def.id);
  const plant = usePlantStore((s) => s.selected) ?? '';
  const role = useSessionStore((s) => s.me?.role);
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const meta = metricMeta(d.metric);
  const editable = canEditSetpoint(role);
  const check = useMemo(() => validateSetpoint(text, d.scale, d.setpoint, meta.decimals), [text, d.scale, d.setpoint, meta.decimals]);
  const unit = meta.unit ? ` ${meta.unit}` : '';

  async function save(value: number) {
    await getControlApi().setSetpoint(plant, def.id, d.metric, value);
    const { catalog, setCatalog } = useLiveStore.getState();
    setCatalog(Object.values(catalog).map((x) => (x.id === def.id ? withSetpoint(x, d.metric, value) : x)));
    setText('');
    setTouched(false);
    toast.success(`Setpoint de ${meta.label.toLowerCase()} en ${fmtNum(value, meta.decimals)}${unit}. Quedó registrado.`);
  }

  return (
    <section aria-label="Setpoint" data-testid="setpoint-panel" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <h2 className="text-base font-bold">Setpoint de {meta.label.toLowerCase()}</h2>
      <p className="mt-1 text-sm text-muted">
        Valor actual:{' '}
        <strong data-testid="setpoint-current" className="font-mono text-fg">{d.setpoint === undefined ? 'sin setpoint' : `${fmtNum(d.setpoint, meta.decimals)}${unit}`}</strong>
        {d.scale && <> · escala de {d.scale.min} a {d.scale.max}{unit}</>}
      </p>
      {editable ? (
        <form
          noValidate
          className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (check.value !== undefined) setConfirming(check.value);
          }}
        >
          <div className="sm:w-56">
            <TextField label={`Nuevo setpoint${unit ? ` (${meta.unit})` : ''}`} inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} error={touched ? check.error : undefined} data-testid="setpoint-input" />
          </div>
          <div className="sm:pt-[1.625rem]">
            <Button type="submit" variant="primary" data-testid="setpoint-save">Guardar setpoint</Button>
          </div>
        </form>
      ) : (
        <p data-testid="setpoint-readonly" className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted">
          <IconLock className="mt-0.5 shrink-0 text-base" /> Cambiar el setpoint es para ingeniería y administración. Si hace falta, pedíselo a alguien con ese rol.
        </p>
      )}
      {confirming !== null && (
        <ConfirmDialog
          title="¿Cambiar el setpoint?"
          description={`El setpoint de ${meta.label.toLowerCase()} de ${displayTag(def.id, def)} pasa de ${d.setpoint === undefined ? 'sin setpoint' : `${fmtNum(d.setpoint, meta.decimals)}${unit}`} a ${fmtNum(confirming, meta.decimals)}${unit}. El cambio queda registrado con tu usuario.`}
          confirmLabel="Cambiar setpoint"
          danger={false}
          onConfirm={() => save(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

/** Nivel 4 — `/m/<módulo>/<tag>/equipo` (operator+): panel de motor, permisos de enclavamiento y ajuste de setpoint (engineer+). */
export function EquipmentScreen({ module, tag }: { module: string; tag: string }) {
  const state = useUnit(module, tag);
  const role = useSessionStore((s) => s.me?.role);
  const sessionReady = useSessionStore((s) => s.status === 'ready');
  const allowed = canSeeEquipment(role);
  return (
    <div data-testid="equipment-screen" className="min-h-full">
      <UnitGate state={state} module={module}>
        {(s) =>
          sessionReady && !allowed ? (
            <>
              <UnitHeader def={s.def} module={s.module} level={4} />
              <div data-testid="equipment-forbidden" className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
                <IconLock className="text-5xl text-muted" />
                <h2 className="text-xl font-bold">El detalle del equipo es para operación</h2>
                <p className="text-muted">Tu rol es de consulta: podés ver el detalle de la unidad, pero el diagnóstico y los permisos de enclavamiento son para operación, ingeniería y administración.</p>
              </div>
            </>
          ) : (
            <>
              <UnitHeader def={s.def} module={s.module} level={4} />
              <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-5 md:px-6">
                <MotorPanel def={s.def} />
                <div className="grid gap-4 lg:grid-cols-2">
                  <InterlockPanel def={s.def} />
                  {supportsSetpoint(s.def.type) && <SetpointPanel def={s.def} />}
                </div>
                <p className="text-xs text-muted">{ASSET_KINDS[s.def.type].label} · {displayTag(s.def.id, s.def)}</p>
              </div>
              <ToastRegion />
            </>
          )
        }
      </UnitGate>
    </div>
  );
}
