'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MODULES, type AlarmKind, type ModuleId, type Severity } from '@campo/shared';
import { canAck, canShelve } from '@/lib/admin/alarms-api';
import { showAdminLink } from '@/lib/modules/nav';
import { lifecycleOf, type LiveAlarm } from '@/lib/alarm-lifecycle';
import { getAlarmsApi } from '@/live/alarm-api';
import { acknowledgeAlarm, acknowledgeMany, unshelveAlarm } from '@/live/alarm-actions';
import { selectAlarmList, selectShelved, useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { ToastRegion } from '../admin/ToastRegion';
import { useLoad } from '../admin/hooks';
import { ApiErrorAlert, LoadingBlock } from '../admin/ui';
import { useNow } from '../hooks';
import { useActiveModuleIds } from '../modules/derived';
import { IconCheck, IconGauge, IconPause, IconInfo } from '../icons';
import { AlarmDetail } from './AlarmDetail';
import { AlarmRow, GRID } from './AlarmRow';
import { ShelveDialog } from './ShelveDialog';
import {
  ALL_KINDS,
  EMPTY_FILTERS,
  KIND_LABEL,
  SEVERITY_LABEL,
  assetNameOf,
  filterAlarms,
  hasFilters,
  orderAlarms,
  orderHistory,
  orderShelved,
  type AlarmFilters,
  type AlarmTab,
} from './model';

const TABS: { id: AlarmTab; label: string }[] = [
  { id: 'active', label: 'Activas' },
  { id: 'shelved', label: 'Postergadas' },
  { id: 'history', label: 'Historial' },
];

const control = 'min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg';

function Empty({ tab, filtered, onClear }: { tab: AlarmTab; filtered: boolean; onClear(): void }) {
  const copy = filtered
    ? { title: 'Ninguna alarma coincide con los filtros', body: 'Probá con otra búsqueda o quitá los filtros.', icon: <IconInfo /> }
    : tab === 'active'
      ? { title: 'Sin alarmas activas', body: 'Todo está dentro de sus límites. Cuando algo se salga, lo vas a ver acá.', icon: <IconCheck className="text-calm" /> }
      : tab === 'shelved'
        ? { title: 'No hay nada postergado', body: 'Las alarmas que pospongas con un motivo aparecen acá hasta que venzan.', icon: <IconPause /> }
        : { title: 'Todavía no hay alarmas cerradas', body: 'Las alarmas que se normalizan y se reconocen quedan en este historial.', icon: <IconInfo /> };
  return (
    <div role="status" data-testid="alarms-empty" className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line bg-surface px-4 py-14 text-center">
      <div className="text-4xl text-muted">{copy.icon}</div>
      <p className="text-lg font-bold">{copy.title}</p>
      <p className="max-w-sm text-sm text-muted">{copy.body}</p>
      {filtered && (
        <button type="button" onClick={onClear} className="mt-2 min-h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold hover:bg-line">
          Quitar filtros
        </button>
      )}
    </div>
  );
}

/** `/alarmas`: lista de alarmas ISA-18.2 con ciclo de vida, postergar y detalle (docs/architecture.md §12.5). */
export function AlarmsScreen() {
  const role = useSessionStore((s) => s.me?.role);
  const plant = usePlantStore((s) => s.selected) ?? '';
  const catalog = useLiveStore((s) => s.catalog);
  const notice = useLiveStore((s) => s.notice);
  const activeList = useLiveStore(selectAlarmList);
  const shelvedList = useLiveStore(selectShelved);
  const allAlarms = useLiveStore((s) => s.alarms);
  const modules = useActiveModuleIds();
  const now = useNow(1000);
  const ack = canAck(role);
  const shelve = canShelve(role);

  const [tab, setTab] = useState<AlarmTab>('active');
  const [filters, setFilters] = useState<AlarmFilters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shelving, setShelving] = useState<LiveAlarm | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [live, setLive] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    document.title = 'Alarmas · Campo';
  }, []);

  // Historial: alarmas cerradas (API); se refresca mientras se mira
  const history = useLoad(() => getAlarmsApi().listAlarms({ state: 'cleared', plant, limit: 200 }), [plant, tab === 'history' ? Math.floor(now / 10_000) : 'x']);
  const ctx = useMemo(() => ({ catalog }), [catalog]);
  const set = <K extends keyof AlarmFilters>(k: K, v: AlarmFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const historyList = history.data;
  const source = useMemo<LiveAlarm[]>(() => (tab === 'active' ? activeList : tab === 'shelved' ? shelvedList : (historyList ?? [])), [tab, activeList, shelvedList, historyList]);
  const visible = useMemo(() => {
    const f = filterAlarms(source, filters, ctx);
    return tab === 'active' ? orderAlarms(f) : tab === 'shelved' ? orderShelved(f) : orderHistory(f);
  }, [source, filters, ctx, tab]);
  const needAck = useMemo(() => visible.filter((a) => ['unacked', 'rtn_unacked'].includes(lifecycleOf(a))), [visible]);

  const selected: LiveAlarm | undefined = selectedId ? (allAlarms[selectedId] ?? history.data?.find((a) => a.id === selectedId)) : undefined;
  const [snap, setSnap] = useState<LiveAlarm | undefined>();
  if (selected && snap !== selected) setSnap(selected);
  // si se cierra (se reconoció una normalizada) mientras se mira, queda la última versión conocida, ya cerrada
  const shown = selected ?? (selectedId && snap?.id === selectedId ? { ...snap, state: 'cleared' as const, lifecycle: 'closed' as const, acknowledged: true } : undefined);

  const mark = (id: string, on: boolean) => setBusyIds((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const onAck = useCallback(async (id: string) => {
    mark(id, true);
    const ok = await acknowledgeAlarm(id);
    mark(id, false);
    if (ok) setLive('Alarma reconocida.');
  }, []);
  const onUnshelve = useCallback(async (a: LiveAlarm) => {
    try {
      await unshelveAlarm(a.id);
      toast.success('La alarma volvió a la lista.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos reactivar la alarma.');
    }
  }, []);
  const onShelve = useCallback((a: LiveAlarm) => setShelving(a), []);
  const onOpen = useCallback((a: LiveAlarm) => setSelectedId(a.id), []);

  async function ackAll() {
    setBulkBusy(true);
    const n = await acknowledgeMany(needAck.map((a) => a.id));
    setBulkBusy(false);
    setLive(n === 1 ? 'Reconociste 1 alarma.' : `Reconociste ${n} alarmas.`);
  }

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    tabRefs.current[TABS[next]!.id]?.focus();
  };

  const count: Record<AlarmTab, number | null> = { active: activeList.length, shelved: shelvedList.length, history: null };
  const moduleOptions = MODULES.filter((m) => modules.includes(m.id) && m.assetTypes.length > 0); // los módulos sin activos (Vista 3D, Control) no tienen alarmas propias

  return (
    <div className="mx-auto w-full max-w-[88rem] px-4 py-5 md:px-6" data-testid="alarms-screen">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Alarmas</h1>
        <Link prefetch={false} href="/alarmas/salud" data-testid="health-link" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface-2">
          <IconGauge className="text-lg" /> Salud de alarmas
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted" data-testid="alarms-summary">
        {activeList.length === 0
          ? 'No hay alarmas activas en la planta.'
          : `${activeList.length} ${activeList.length === 1 ? 'alarma para atender' : 'alarmas para atender'}, ${activeList.filter((a) => lifecycleOf(a) !== 'acked').length} sin reconocer.`}
      </p>

      <div role="tablist" aria-label="Estado de las alarmas" onKeyDown={onTabKey} className="mb-3 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[t.id] = el; }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="alarms-panel"
            tabIndex={tab === t.id ? 0 : -1}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px min-h-11 border-b-2 px-4 text-sm font-semibold ${tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {t.label}
            {count[t.id] !== null && <span className="ml-1.5 font-mono tabular-nums text-muted" data-testid={`count-${t.id}`}>({count[t.id]})</span>}
          </button>
        ))}
      </div>

      <form role="search" aria-label="Filtros de alarmas" onSubmit={(e) => e.preventDefault()} className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2 lg:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_auto]">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Buscar activo
          <input type="search" data-testid="alarm-search" value={filters.query} onChange={(e) => set('query', e.target.value)} placeholder="Tanque 01, bomba, temperatura…" autoComplete="off" className={control} />
        </label>
        <button type="button" aria-expanded={showFilters} aria-controls="alarm-filters" data-testid="toggle-filters" onClick={() => setShowFilters((v) => !v)} className="min-h-11 self-end rounded-lg border border-line bg-surface px-4 text-sm font-semibold lg:hidden">
          Filtros{hasFilters({ ...filters, query: '' }) ? ' •' : ''}
        </button>
        <div id="alarm-filters" className={`${showFilters ? 'grid' : 'hidden'} col-span-2 grid-cols-2 gap-2 lg:contents`}>
          {moduleOptions.length > 1 && (
            <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
              Módulo
              <select data-testid="filter-module" value={filters.module} onChange={(e) => set('module', e.target.value as ModuleId | '')} className={control}>
                <option value="">Todos</option>
                {moduleOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Prioridad
            <select data-testid="filter-severity" value={filters.severity} onChange={(e) => set('severity', e.target.value as Severity | '')} className={control}>
              <option value="">Todas</option>
              {(['critical', 'warning'] as const).map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Tipo
            <select data-testid="filter-kind" value={filters.kind} onChange={(e) => set('kind', e.target.value as AlarmKind | '')} className={control}>
              <option value="">Todos</option>
              {ALL_KINDS.map((k) => <option key={k} value={k}>{k} · {KIND_LABEL[k]}</option>)}
            </select>
          </label>
          {hasFilters(filters) && (
            <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="min-h-11 self-end rounded-lg px-3 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-fg">
              Quitar filtros
            </button>
          )}
        </div>
      </form>

      {notice && (
        <p role="alert" data-testid="alarm-notice" className="mb-3 rounded-lg border border-crit/60 bg-crit/15 px-3 py-2 text-sm font-medium text-crit">{notice}</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">{live}</p>

      <div id="alarms-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'active' && ack && needAck.length > 0 && (
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-muted" data-testid="visible-count">{visible.length} {visible.length === 1 ? 'alarma visible' : 'alarmas visibles'}</p>
            <button type="button" data-testid="ack-all" aria-label={`Reconocer todas las visibles (${needAck.length})`} disabled={bulkBusy} onClick={() => void ackAll()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-fg/50 bg-surface-2 px-4 text-sm font-semibold hover:bg-line disabled:opacity-60">
              <IconCheck className="text-lg" /> <span className="sm:hidden">Reconocer todas</span><span className="hidden sm:inline">Reconocer todas las visibles</span> ({needAck.length})
            </button>
          </div>
        )}
        {tab === 'history' && history.error != null && <ApiErrorAlert error={history.error} />}
        {tab === 'history' && history.loading && !history.data && history.error == null ? (
          <LoadingBlock label="Cargando el historial…" />
        ) : visible.length === 0 ? (
          <Empty tab={tab} filtered={hasFilters(filters) && source.length > 0} onClear={() => setFilters(EMPTY_FILTERS)} />
        ) : (
          <>
            <div aria-hidden className={`mb-1 hidden pr-[13px] pl-4 text-xs font-semibold tracking-wide text-muted uppercase ${GRID}`}>
              <span>Prioridad y tipo</span><span>Activo y descripción</span><span>Valor y límite</span><span>Estado</span><span className="text-right">Acciones</span>
            </div>
            <ul className="flex flex-col gap-2" data-testid="alarm-rows" aria-label={TABS.find((t) => t.id === tab)!.label}>
              {visible.map((a) => (
                <AlarmRow
                  key={a.id}
                  alarm={a}
                  name={assetNameOf(a.asset, catalog)}
                  now={now}
                  canAck={ack}
                  canShelve={shelve}
                  history={tab === 'history'}
                  selected={a.id === selectedId}
                  busy={busyIds.has(a.id)}
                  onAck={(id) => void onAck(id)}
                  onShelve={onShelve}
                  onUnshelve={(x) => void onUnshelve(x)}
                  onOpen={onOpen}
                />
              ))}
            </ul>
            {tab === 'active' && <p className="mt-3 text-xs text-muted">Ordenadas por prioridad y, dentro de cada una, la más antigua primero.</p>}
          </>
        )}
      </div>

      {shown && (
        <AlarmDetail
          alarm={shown}
          name={assetNameOf(shown.asset, catalog)}
          now={now}
          canAck={ack}
          canShelve={shelve}
          canRules={showAdminLink(role)}
          catalog={catalog}
          modules={modules}
          plant={plant}
          onAck={(id) => void onAck(id)}
          onShelve={onShelve}
          onUnshelve={(x) => void onUnshelve(x)}
          onClose={() => setSelectedId(null)}
        />
      )}
      {shelving && <ShelveDialog alarmId={shelving.id} assetName={assetNameOf(shelving.asset, catalog)} onClose={() => setShelving(null)} />}
      <ToastRegion />
    </div>
  );
}
