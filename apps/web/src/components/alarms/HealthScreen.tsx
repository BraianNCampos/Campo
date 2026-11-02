'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { AlarmKpis } from '@campo/shared';
import { KPI_WINDOWS, canEditPolicy, type KpiWindow } from '@/lib/admin/alarms-api';
import { getAlarmsApi } from '@/live/alarm-api';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { ToastRegion } from '../admin/ToastRegion';
import { useLoad } from '../admin/hooks';
import { ErrorState, LoadingBlock } from '../admin/ui';
import { AssetTag } from '../AssetTag';
import { IconBack, IconCheck, IconCritical, IconEdit, IconWarning } from '../icons';
import { KindBadge } from './badges';
import { STATE_EXPLAIN, STATE_LABEL, WINDOW_LABEL, WINDOW_SHORT, formatPerDay, meterPositions, meterState, priorityShare, ratioText, sinceText, type HealthState } from './health-model';
import { assetNameOf } from './model';
import { PolicyDialog } from './PolicyDialog';
import { METRICS } from '@campo/shared';

const TONE: Record<HealthState, { text: string; bar: string; border: string; Icon: typeof IconCheck }> = {
  ok: { text: 'text-calm', bar: 'bg-calm-bar', border: 'border-calm-bar/50', Icon: IconCheck },
  warning: { text: 'text-warn', bar: 'bg-warn', border: 'border-warn/60', Icon: IconWarning },
  critical: { text: 'text-crit', bar: 'bg-crit', border: 'border-crit/70', Icon: IconCritical },
};

function Meter({ testid, title, value, display, limit, unit, explain, extra }: { testid: string; title: string; value: number; display: string; limit: number; unit: string; explain: string; extra?: string }) {
  const state = meterState(value, limit);
  const { text, bar, Icon } = TONE[state];
  const { fill, mark } = meterPositions(value, limit);
  return (
    <section data-testid={testid} data-state={state} className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-sm font-bold text-muted">{title}</h2>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className={`font-mono text-4xl font-bold tabular-nums ${state === 'ok' ? 'text-fg' : text}`} data-testid={`${testid}-value`}>{display}</span>
        <span className="text-sm text-muted">{unit}</span>
      </p>
      <div
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={Math.round(limit * 1.5)}
        aria-valuenow={Math.min(Math.round(value * 10) / 10, Math.round(limit * 1.5))}
        aria-valuetext={`${display} ${unit}; máximo recomendado ${limit}`}
        className="relative mt-3 h-3 rounded-full bg-surface-2"
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${fill * 100}%` }} />
        <div aria-hidden className="absolute -top-1 -bottom-1 w-0.5 bg-fg" style={{ left: `${mark * 100}%` }} />
      </div>
      <div className="relative mt-1 h-4 text-xs text-muted" aria-hidden>
        <span className="absolute left-0 font-mono">0</span>
        <span style={{ left: `${mark * 100}%` }} className="absolute -translate-x-1/2 font-mono text-fg">máx. {limit}</span>
        <span className="absolute right-0 font-mono">{Math.round(limit * 1.5)}</span>
      </div>
      <p className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${text}`}>
        <Icon className="shrink-0 text-base" /> {STATE_LABEL[state]}
      </p>
      <p className="text-xs text-muted">{ratioText(value, limit)}</p>
      {extra && <p className="mt-1 text-xs text-muted">{extra}</p>}
      <p className="mt-2 text-sm text-muted">{explain}</p>
    </section>
  );
}

function Count({ testid, label, value, explain }: { testid: string; label: string; value: number; explain: string }) {
  return (
    <div data-testid={testid} className="rounded-2xl border border-line bg-surface p-4">
      <p className="font-mono text-3xl font-bold tabular-nums" data-testid={`${testid}-value`}>{value}</p>
      <h3 className="text-sm font-bold">{label}</h3>
      <p className="mt-1 text-xs text-muted">{explain}</p>
    </div>
  );
}

function Card({ title, explain, children, testid }: { title: string; explain: string; children: React.ReactNode; testid: string }) {
  return (
    <section data-testid={testid} className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-base font-bold">{title}</h2>
      <p className="mt-0.5 mb-3 text-sm text-muted">{explain}</p>
      {children}
    </section>
  );
}

const hm = (ts: number | null) => (ts === null ? '' : new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }));

function Report({ k, plant, now }: { k: AlarmKpis; plant: string; now: number }) {
  const catalog = useLiveStore((s) => s.catalog);
  const name = (id: string) => assetNameOf(id, catalog);
  const metric = (m: string) => METRICS[m]?.label ?? m;
  const share = priorityShare(k.byPriority);
  const topMax = Math.max(1, ...k.top.map((t) => t.count));
  const days = k.window === '24h' ? 1 : k.window === '7d' ? 7 : 30;
  void plant;
  return (
    <div className="flex flex-col gap-4">
      <div data-testid="health-status" data-state={k.status} className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${TONE[k.status].border} bg-surface`}>
        {(() => { const Icon = TONE[k.status].Icon; return <Icon className={`text-3xl ${TONE[k.status].text}`} />; })()}
        <div className="min-w-0 flex-1">
          <p className={`text-lg font-bold ${TONE[k.status].text}`}>{STATE_LABEL[k.status]}</p>
          <p className="text-sm text-muted">{STATE_EXPLAIN[k.status]} <span className="whitespace-nowrap">({WINDOW_LABEL[k.window].toLowerCase()}: {k.total} {k.total === 1 ? 'alarma' : 'alarmas'}.)</span></p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Meter
          testid="meter-rate"
          title="Alarmas por día"
          value={k.perDay}
          display={formatPerDay(k.perDay)}
          limit={k.policy.ratePerDay}
          unit="por día en promedio"
          explain="Cuántas alarmas se activan por día. Si son demasiadas, quien opera no llega a atenderlas todas."
          extra={days > 1 ? `Promedio de ${days} días (${k.total} en total).` : undefined}
        />
        <Meter
          testid="meter-peak"
          title="Pico en 10 minutos"
          value={k.peak10min.count}
          display={String(k.peak10min.count)}
          limit={k.policy.peak10min}
          unit="alarmas juntas"
          explain="La mayor cantidad de alarmas que llegaron en 10 minutos seguidos, como pasa tras una falla o un corte."
          extra={k.peak10min.at !== null ? `Fue el ${hm(k.peak10min.at)}.` : 'No hubo alarmas en este período.'}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-[1.2fr_2fr]">
        <Card testid="by-priority" title="Por prioridad" explain="Cuántas fueron críticas y cuántas advertencias.">
          <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="bg-crit" style={{ width: `${share.critical * 100}%` }} />
            <div className="bg-warn" style={{ width: `${share.warning * 100}%` }} />
          </div>
          <dl className="mt-3 flex gap-6">
            <div><dt className="flex items-center gap-1.5 text-sm text-crit"><IconCritical className="text-base" /> Críticas</dt><dd className="font-mono text-2xl font-bold tabular-nums" data-testid="prio-critical">{k.byPriority.critical}</dd></div>
            <div><dt className="flex items-center gap-1.5 text-sm text-warn"><IconWarning className="text-base" /> Advertencias</dt><dd className="font-mono text-2xl font-bold tabular-nums" data-testid="prio-warning">{k.byPriority.warning}</dd></div>
          </dl>
        </Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Count testid="count-shelved" label="Postergadas" value={k.shelved} explain="Alarmas que alguien dejó en pausa con un motivo." />
          <Count testid="count-suppressed" label="Suprimidas" value={k.suppressed} explain="No saltan porque una condición del proceso lo justifica (p. ej. bomba detenida)." />
          <Count testid="count-oos" label="Fuera de servicio" value={k.outOfService} explain="Reglas apagadas a propósito, con un motivo registrado." />
        </div>
      </div>

      <Card testid="top-list" title="Las 10 que más se repiten" explain="Revisar primero estas: corregir unas pocas reglas suele sacar la mayor parte del ruido.">
        {k.top.length === 0 ? (
          <p className="text-sm text-muted">No hubo alarmas en este período.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {k.top.map((t, i) => (
              <li key={t.ruleId} data-testid="top-row" className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-muted">{i + 1}</span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold"><span className="truncate">{name(t.asset)}</span><AssetTag id={t.asset} className="text-xs font-normal" /><span className="font-normal text-muted">{metric(t.metric)}</span><KindBadge kind={t.kind} /></p>
                  <div className="mt-1 h-1.5 rounded-full bg-surface-2" aria-hidden><div className="h-full rounded-full bg-fg/50" style={{ width: `${(t.count / topMax) * 100}%` }} /></div>
                </div>
                <span className="font-mono text-sm font-bold tabular-nums">{t.count}<span className="sr-only"> veces</span></span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card testid="chattering" title="Intermitentes" explain="Se activan y se normalizan una y otra vez (3 veces o más en 10 minutos). Suele ser un límite muy justo o un sensor inestable.">
          {k.chattering.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted"><IconCheck className="text-base text-calm" /> Ninguna alarma intermitente.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {k.chattering.map((c) => (
                <li key={c.ruleId} data-testid="chatter-row" className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-semibold">{name(c.asset)} <AssetTag id={c.asset} className="text-xs font-normal" /> <span className="font-normal text-muted">{metric(c.metric)}</span></span>
                  <span className="shrink-0 font-mono text-warn">{c.activations10min} en 10 min</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card testid="stale" title="Estancadas" explain={`Siguen activas hace más de ${k.policy.staleHours} h: nadie las resolvió. Pueden esconder un problema real o una regla que ya no sirve.`}>
          {k.stale.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted"><IconCheck className="text-base text-calm" /> Ninguna alarma estancada.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {k.stale.map((s) => (
                <li key={s.id} data-testid="stale-row" className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-semibold">{name(s.asset)} <AssetTag id={s.asset} className="text-xs font-normal" /> <span className="font-normal text-muted">{metric(s.metric)}</span></span>
                  <span className="shrink-0 font-mono text-warn">hace {sinceText(now - s.since)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** `/alarmas/salud`: salud de las alarmas contra la política de la planta (docs/architecture.md §12.3, §12.5). */
export function HealthScreen() {
  const role = useSessionStore((s) => s.me?.role);
  const plant = usePlantStore((s) => s.selected) ?? '';
  const [win, setWin] = useState<KpiWindow>('24h');
  const [editing, setEditing] = useState(false);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    document.title = 'Salud de alarmas · Campo';
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setNow(Date.now());
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const kpis = useLoad(() => getAlarmsApi().kpis(plant, win), [plant, win, tick]);
  const policy = kpis.data?.policy;
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name);
  const canEdit = canEditPolicy(role);
  const data = useMemo(() => kpis.data, [kpis.data]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6" data-testid="health-screen">
      <Link prefetch={false} href="/alarmas" className="mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted hover:text-fg">
        <IconBack className="text-base" /> Volver a la lista de alarmas
      </Link>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Salud de alarmas</h1>
          <p className="mt-0.5 text-sm text-muted">
            {plantName ? `${plantName}: ` : ''}cuántas alarmas llegan y cuáles molestan más.
            {policy && <> Objetivo: hasta <b className="font-mono text-fg">{policy.ratePerDay}</b> por día y <b className="font-mono text-fg">{policy.peak10min}</b> en 10 minutos.</>}
          </p>
        </div>
        {canEdit && policy && (
          <button type="button" data-testid="edit-policy" onClick={() => setEditing(true)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface-2">
            <IconEdit className="text-lg" /> Editar política
          </button>
        )}
      </div>

      <div role="radiogroup" aria-label="Período" className="mb-4 inline-flex rounded-xl border border-line bg-surface p-1">
        {KPI_WINDOWS.map((w) => (
          <button key={w} type="button" role="radio" aria-checked={win === w} data-testid={`window-${w}`} onClick={() => setWin(w)} className={`min-h-11 min-w-20 rounded-lg px-4 text-sm font-semibold ${win === w ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'}`}>
            {WINDOW_SHORT[w]}
          </button>
        ))}
      </div>

      {kpis.error != null && <ErrorState error={kpis.error} onRetry={kpis.reload} />}
      {!data && kpis.error == null && <LoadingBlock label="Calculando la salud de las alarmas…" />}
      {data && <Report k={data} plant={plant} now={now} />}
      {editing && policy && <PolicyDialog plant={plant} policy={policy} onClose={() => setEditing(false)} onSaved={() => kpis.reload()} />}
      <ToastRegion />
    </div>
  );
}
