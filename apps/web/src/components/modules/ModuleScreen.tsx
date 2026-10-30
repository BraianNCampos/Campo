'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { moduleForAssetType, type AlarmEvent, type ModuleDef } from '@campo/shared';
import { canAckAlarms, canManageRules, rulesHref } from '@/lib/modules/nav';
import { needsAttention } from '@/lib/modules/status';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { AlarmList } from '../AlarmList';
import { HexPattern } from '../HexPattern';
import { IconExternal, IconGrid, IconRules } from '../icons';
import { useModuleSummary } from './derived';
import { KpiStrip } from './KpiStrip';
import { MODULE_ICON } from './module-meta';
import { ModuleCard } from './ModuleCard';

type Tab = 'live' | 'alarms' | 'rules';
type Filter = 'all' | 'attention';

const chip = (on: boolean) =>
  `inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold ${
    on ? 'border-fg/70 bg-surface-2 text-fg' : 'border-line text-muted hover:bg-surface-2 hover:text-fg'
  }`;

function LiveTab({ module }: { module: ModuleDef }) {
  const sum = useModuleSummary(module.id);
  const [filter, setFilter] = useState<Filter>('all');
  const catalogReady = useLiveStore((s) => s.catalogReady);
  const catalogError = useLiveStore((s) => s.catalogError);
  const shown = useMemo(() => (filter === 'attention' ? sum.ids.filter((id) => needsAttention(sum.statuses[id]!)) : sum.ids), [filter, sum]);

  if (sum.counts.all === 0) {
    return (
      <div role="status" data-testid="module-empty" className="mx-auto flex max-w-md flex-col items-center gap-2 px-4 py-16 text-center">
        <IconGrid className="text-4xl text-muted" />
        <p className="text-lg font-bold">
          {catalogReady ? 'Todavía no hay activos de este módulo en la planta' : catalogError ? 'No pudimos cargar el catálogo' : 'Cargando activos…'}
        </p>
        <p className="text-sm text-muted">
          {catalogReady
            ? 'Cuando se cargue un activo de este tipo en Administración, va a aparecer acá con sus valores en vivo.'
            : 'Si el problema sigue, avisanos desde Mi cuenta o contactá a Campos Ingeniería.'}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <KpiStrip kpis={sum.kpis} />
      <div role="group" aria-label="Filtrar activos" className="flex flex-wrap gap-2">
        <button type="button" data-testid="filter-all" aria-pressed={filter === 'all'} onClick={() => setFilter('all')} className={chip(filter === 'all')}>
          Todos <span className="font-mono tabular-nums">({sum.counts.all})</span>
        </button>
        <button type="button" data-testid="filter-attention" aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')} className={chip(filter === 'attention')}>
          Requieren atención <span className={`font-mono tabular-nums ${sum.counts.attention > 0 ? 'text-warn' : ''}`}>({sum.counts.attention})</span>
        </button>
      </div>
      {shown.length === 0 ? (
        <p role="status" data-testid="attention-empty" className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          Nada requiere atención ahora. Todo está dentro de sus límites.
        </p>
      ) : (
        <section aria-label="Activos" className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2 min-[1100px]:grid-cols-3 min-[1500px]:grid-cols-4">
          {shown.map((id) => (
            <ModuleCard key={id} id={id} />
          ))}
        </section>
      )}
    </div>
  );
}

function AlarmsTab({ module }: { module: ModuleDef }) {
  const role = useSessionStore((s) => s.me?.role);
  const catalog = useLiveStore((s) => s.catalog);
  const filter = useCallback((a: AlarmEvent) => { const t = catalog[a.asset]?.type; return !!t && moduleForAssetType(t) === module.id; }, [catalog, module.id]);
  return (
    <div className="mx-auto max-w-3xl">
      <AlarmList filter={filter} canAck={canAckAlarms(role)} emptyText={`Ningún activo de ${module.label.toLowerCase()} tiene alarmas activas.`} />
    </div>
  );
}

function RulesTab({ module }: { module: ModuleDef }) {
  const role = useSessionStore((s) => s.me?.role);
  const plant = usePlantStore((s) => s.selected);
  const can = canManageRules(role);
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-line bg-surface p-5">
      <IconRules className="text-3xl text-muted" />
      <h2 className="mt-3 text-lg font-bold">Reglas de alarma de {module.label.toLowerCase()}</h2>
      <p className="mt-1 text-sm text-muted">
        Las reglas definen cuándo un valor pasa a ser una alarma: el límite, cuánto tiempo tiene que sostenerse y si es una advertencia o algo crítico.
        Esos mismos límites son las marcas que ves en la barra de cada tarjeta, y por eso te avisamos cuando un valor se acerca.
      </p>
      {can && plant ? (
        <Link
          prefetch={false}
          href={rulesHref(plant, module.id)}
          data-testid="rules-link"
          className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-bold text-bg"
        >
          Administrar reglas <IconExternal className="text-base" />
        </Link>
      ) : (
        <p data-testid="rules-readonly" className="mt-4 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted">
          Para cambiar las reglas, pedile a un administrador o ingeniero de tu planta que lo haga.
        </p>
      )}
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'En vivo' },
  { id: 'alarms', label: 'Alarmas' },
  { id: 'rules', label: 'Reglas' },
];

/** Pantalla genérica de un módulo: pestañas En vivo · Alarmas · Reglas (docs/architecture.md §11.4). */
export function ModuleScreen({ module }: { module: ModuleDef }) {
  const [tab, setTab] = useState<Tab>('live');
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name);
  const catalog = useLiveStore((s) => s.catalog);
  const alarms = useLiveStore((s) => s.alarms);
  const alarmCount = useMemo(
    () => Object.values(alarms).filter((a) => { const t = catalog[a.asset]?.type; return !!t && moduleForAssetType(t) === module.id; }).length,
    [alarms, catalog, module.id],
  );
  const Icon = MODULE_ICON[module.id];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    document.title = `${module.label} · Campo`;
  }, [module.label]);

  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    refs.current[TABS[next]!.id]?.focus();
  };

  return (
    <div data-testid="module-screen" data-module={module.id} className="min-h-full">
      <header className="relative overflow-hidden border-b border-line">
        <div className="hidden md:block"><HexPattern /></div>
        <div className="relative mx-auto max-w-[1600px] px-4 pt-5 md:px-6 md:pt-6">
          <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-muted uppercase">
            <Icon className="text-base" /> {plantName ?? 'Planta'}
          </p>
          <h1 className="mt-1 text-[26px] leading-tight font-extrabold tracking-tight md:text-3xl">{module.label}</h1>
          <p className="mt-0.5 hidden text-sm text-muted md:block">{module.description}</p>
          <div role="tablist" aria-label={`${module.label}: secciones`} onKeyDown={onKey} className="mt-4 -mb-px flex gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const on = tab === t.id;
              return (
                <button
                  key={t.id}
                  ref={(el) => { refs.current[t.id] = el; }}
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={on}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={on ? 0 : -1}
                  data-testid={`module-tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-4 text-sm font-semibold whitespace-nowrap ${
                    on ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'
                  }`}
                >
                  {t.label}
                  {t.id === 'alarms' && alarmCount > 0 && (
                    <span className="min-w-5 rounded-full bg-crit px-1.5 text-center font-mono text-[11px] leading-5 font-bold text-bg">{alarmCount}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mx-auto max-w-[1600px] px-4 py-5 md:px-6">
        {tab === 'live' && <LiveTab module={module} />}
        {tab === 'alarms' && <AlarmsTab module={module} />}
        {tab === 'rules' && <RulesTab module={module} />}
      </div>
    </div>
  );
}
