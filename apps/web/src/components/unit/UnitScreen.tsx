'use client';

import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { ASSET_KINDS, MODULES, type AssetDef, type ModuleId } from '@campo/shared';
import { DEMO_LINKS } from '@/lib/demo-seed';
import { canSeeEquipment } from '@/lib/control/interlocks';
import { metricMeta } from '@/lib/metrics';
import { cardExtras } from '@/lib/modules/extras';
import { moduleHref } from '@/lib/modules/nav';
import { relatedAssets, faceplateOf } from '@/lib/modules/unit';
import { trendRefLines } from '../trend/trend-model';
import { assetHref, equipmentHref, displayTag } from '@/lib/tags';
import { readSeries } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { useSessionStore } from '@/store/session-store';
import { HexPattern } from '../HexPattern';
import { LineChart } from '../LineChart';
import { useHistoryVersion, useNow } from '../hooks';
import { IconBack, IconChevron, IconTrendUp, KIND_ICON } from '../icons';
import { StatusChip } from '../modules/StatusChip';
import { useCardData } from '../modules/useCardData';
import { useTrendStore } from '../trend/trend-store';
import { btn } from '../admin/ui';
import { Faceplate } from './Faceplate';
import { RelatedList } from './RelatedList';
import { UnitAlarms } from './UnitAlarms';
import { UnitGate } from './UnitFrame';
import { useUnit } from './useUnit';

/** Cabecera común de los niveles 3 y 4: volver, nombre, tag en monoespaciado, tipo y estado. */
export function UnitHeader({ def, module, level }: { def: AssetDef; module: ModuleId; level: 3 | 4 }) {
  const d = useCardData(def.id);
  const Icon = KIND_ICON[def.type];
  const mod = MODULES.find((m) => m.id === module)!;
  const role = useSessionStore((s) => s.me?.role);
  return (
    <header className="relative overflow-hidden border-b border-line">
      <div className="hidden md:block"><HexPattern /></div>
      <div className="relative mx-auto max-w-[1200px] px-4 py-4 md:px-6 md:py-5">
        <nav aria-label="Ruta" className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <Link prefetch={false} href={moduleHref(module)} data-testid="unit-back" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg pr-2 font-semibold hover:text-fg">
            <IconBack className="text-base" /> {mod.label}
          </Link>
          {level === 4 && (
            <>
              <IconChevron className="text-sm" />
              <Link prefetch={false} href={assetHref(module, def)} className="inline-flex min-h-11 items-center rounded-lg px-1 font-semibold hover:text-fg" data-testid="unit-up">
                {displayTag(def.id, def)}
              </Link>
            </>
          )}
        </nav>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-muted uppercase">
              <Icon className="text-base" /> {ASSET_KINDS[def.type].label} · Nivel {level} · {level === 3 ? 'Detalle de la unidad' : 'Detalle del equipo'}
            </p>
            <h1 className="mt-1 flex flex-wrap items-baseline gap-x-3 text-[26px] leading-tight font-extrabold tracking-tight md:text-3xl">
              <span data-testid="unit-name">{def.name}</span>
              <span className="font-mono text-lg font-semibold text-muted" data-testid="unit-tag">{displayTag(def.id, def)}</span>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={d.status} severity={d.severity} data="unit-status" />
            {level === 3 && canSeeEquipment(role) && (
              <Link prefetch={false} href={equipmentHref(module, def)} data-testid="unit-equipment-link" className={btn('secondary')}>
                Detalle del equipo <IconChevron className="text-base" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function Totals({ def }: { def: AssetDef }) {
  const values = useLiveStore((s) => s.assets[def.id]?.values);
  const version = useHistoryVersion();
  const now = useNow(5000);
  const extras = useMemo(() => {
    void version;
    return values ? cardExtras({ def, values, series: (m) => readSeries(def.id, m), now }) : [];
  }, [def, values, version, now]);
  if (extras.length === 0) return null;
  return (
    <dl data-testid="unit-extras" className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-sm sm:grid-cols-3">
      {extras.map((e) => (
        <div key={e.label}>
          <dt className="text-xs text-muted">{e.label}</dt>
          {e.value && <dd className="font-mono font-semibold tabular-nums">{e.value}</dd>}
        </div>
      ))}
    </dl>
  );
}

function UnitBody({ def, module }: { def: AssetDef; module: ModuleId }) {
  const d = useCardData(def.id);
  const catalog = useLiveStore((s) => s.catalog);
  const plant = useLiveStore((s) => s.plant);
  const openTrend = useTrendStore((s) => s.show);
  const meta = metricMeta(d.metric);
  const valve = useMemo(() => {
    const v = relatedAssets(def.id, catalog, DEMO_LINKS[plant] ?? []).find((r) => catalog[r]?.type === 'valve');
    return v;
  }, [def.id, catalog, plant]);
  const valveValues = useLiveStore((s) => (valve ? s.assets[valve]?.values : undefined));
  const fp = useMemo(() => faceplateOf(def, d.state?.values, d.setpoint, valveValues), [def, d.state, d.setpoint, valveValues]);
  const lines = useMemo(() => trendRefLines(d.limits, d.setpoint), [d.limits, d.setpoint]);
  const noValue = def.type === 'structure';

  useEffect(() => {
    document.title = `${displayTag(def.id, def)} ${def.name} · Campo`;
  }, [def]);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-5 md:px-6" data-module={module}>
      <Faceplate data={fp} status={d.status} severity={d.severity} metricLabelOf={meta.label} scale={d.scale} limits={d.limits} name={def.name} />
      {!noValue && (
        <section aria-label="Tendencia" data-testid="unit-trend" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold">Tendencia · {meta.label}</h2>
            <button type="button" data-testid="unit-trend-open" onClick={() => openTrend(def.id, d.metric)} className={btn('secondary')}>
              <IconTrendUp className="text-base" /> Ver historial
            </button>
          </div>
          <div className="mt-2 rounded-lg border border-line bg-bg">
            <LineChart asset={def.id} metric={d.metric} windowSec={300} height={200} refLines={lines} />
          </div>
          <p className="mt-1 text-xs text-muted">Últimos 5 minutos en vivo. Para 15 min, 1 h, 6 h o 24 h abrí el historial.</p>
          <Totals def={def} />
        </section>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <RelatedList id={def.id} />
        <UnitAlarms id={def.id} />
      </div>
    </div>
  );
}

/** Nivel 3 — `/m/<módulo>/<tag>`: panel frontal PV/SP/OP/MODE/STS, desviación, tendencia, válvulas y flujos asociados y alarmas del equipo. */
export function UnitScreen({ module, tag }: { module: string; tag: string }) {
  const state = useUnit(module, tag);
  return (
    <div data-testid="unit-screen" className="min-h-full">
      <UnitGate state={state} module={module}>
        {(s) => (
          <>
            <UnitHeader def={s.def} module={s.module} level={3} />
            <UnitBody def={s.def} module={s.module} />
          </>
        )}
      </UnitGate>
    </div>
  );
}
