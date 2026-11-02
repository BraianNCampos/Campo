'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ModuleId } from '@campo/shared';
import { landingHref } from '@/lib/modules/nav';
import { latencyText, overviewMode, planOverview, type ModuleOverview } from '@/lib/modules/overview';
import { selectAlarmCounts, useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { ConnectionChip } from '../ConnectionChip';
import { GlassPanel } from '../GlassPanel';
import { HexPattern } from '../HexPattern';
import { useIsMobile } from '../hooks';
import { IconChevron, IconCritical, IconCube, IconPause, IconWarning } from '../icons';
import { useActiveModuleIds, useThrottledLive } from '../modules/derived';
import { MODULE_ICON } from '../modules/module-meta';
import { NoModules } from '../modules/NoModules';
import { StatusChip } from '../modules/StatusChip';
import { PlantView } from '../PlantView';

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function useOverview(ids: ModuleId[]): ModuleOverview[] {
  const key = ids.join(',');
  return useThrottledLive(`overview:${key}`, (s) => planOverview(ids, s), json, 500);
}

/** Tira de salud de alarmas: sin reconocer · normalizadas sin reconocer · postergadas · críticas. Sin valores de instrumentos. */
function AlarmHealth({ layout }: { layout: 'row' | 'stack' }) {
  const c = useLiveStore(selectAlarmCounts);
  const tiles = [
    { id: 'unacked', label: 'Sin reconocer', n: c.unacked.total, tone: c.unacked.critical > 0 ? 'crit' : 'warn', Icon: IconCritical },
    { id: 'rtn', label: 'Normalizadas sin reconocer', n: c.rtn_unacked.total, tone: 'warn', Icon: IconWarning },
    { id: 'shelved', label: 'Postergadas', n: c.shelved.total, tone: 'none', Icon: IconPause },
    { id: 'critical', label: 'Críticas', n: c.list.critical, tone: 'crit', Icon: IconCritical },
  ] as const;
  return (
    <ul
      aria-label="Salud de alarmas"
      data-testid="alarm-health"
      className={layout === 'row' ? 'grid grid-cols-2 gap-2 lg:grid-cols-4' : 'flex flex-col gap-1.5'}
    >
      {tiles.map(({ id, label, n, tone, Icon }) => {
        const hot = n > 0 && tone !== 'none';
        const color = !hot ? 'text-fg' : tone === 'crit' ? 'text-crit' : 'text-warn';
        return (
          <li key={id}>
            <Link
              prefetch={false}
              href="/alarmas"
              data-testid={`health-${id}`}
              data-count={n}
              aria-label={`${label}: ${n}`}
              className={`flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2 hover:bg-surface-2 ${hot ? (tone === 'crit' ? 'border-crit/60' : 'border-warn/60') : 'border-line'}`}
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-muted">
                <Icon className={`shrink-0 text-base ${hot ? color : ''}`} />
                <span className="leading-tight">{label}</span>
              </span>
              <span className={`font-mono text-2xl leading-none font-bold tabular-nums ${color}`}>{n}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectionLine() {
  const latency = useLiveStore((s) => s.latencyMs);
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" data-testid="overview-connection">
      <ConnectionChip />
      <span>
        Latencia <span data-testid="overview-latency" className="font-mono font-semibold text-fg tabular-nums">{latencyText(latency)}</span>
      </span>
    </p>
  );
}

/** Tarjeta de un módulo: estado agregado y activos que requieren atención; el clic lleva al nivel 2. */
function ModuleHealthCard({ o, compact = false }: { o: ModuleOverview; compact?: boolean }) {
  const Icon = MODULE_ICON[o.id];
  const text =
    o.total === 0
      ? 'Sin activos todavía'
      : o.attention === 0
        ? o.total === 1
          ? 'El activo está en rango'
          : `Los ${o.total} activos están en rango`
        : `${o.attention} de ${o.total} ${o.attention === 1 ? 'requiere atención' : 'requieren atención'}`;
  const tone = o.status === 'alarm' ? 'border-crit/70' : o.status === 'near' ? 'border-warn/60' : 'border-line';
  return (
    <Link
      prefetch={false}
      href={`/m/${o.id}`}
      data-testid={`overview-module-${o.id}`}
      data-status={o.status}
      data-attention={o.attention}
      className={`group flex min-h-11 flex-col gap-2 rounded-xl border bg-surface/60 p-3 hover:bg-surface-2 ${tone} ${compact ? '' : 'md:p-4'}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
          <Icon className="shrink-0 text-xl text-muted" />
          <span className="truncate">{o.label}</span>
        </span>
        <IconChevron className="shrink-0 text-lg text-muted group-hover:text-fg" />
      </span>
      <span className="flex flex-wrap items-center justify-between gap-2">
        <StatusChip status={o.status} data={`overview-status-${o.id}`} />
        <span data-testid={`overview-attention-${o.id}`} className={`text-[13px] ${o.attention > 0 ? 'font-semibold text-fg' : 'text-muted'}`}>{text}</span>
      </span>
    </Link>
  );
}

function Title({ glass = false }: { glass?: boolean }) {
  const plant = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name ?? s.selected);
  const org = useSessionStore((s) => (s.me?.org ? s.me.org.name : null));
  return (
    <div>
      <p className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">{[org, plant].filter(Boolean).join(' · ') || 'Planta'}</p>
      <h1 className={`mt-1 leading-tight font-extrabold tracking-tight ${glass ? 'text-2xl' : 'text-[26px] md:text-3xl'}`}>Vista general de la planta</h1>
    </div>
  );
}

/** Con 3D (escritorio): la escena ocupa todo y los datos agregados flotan en paneles de vidrio. */
function SceneOverview({ modules }: { modules: ModuleOverview[] }) {
  return (
    <div data-testid="plant-overview" data-mode="scene" className="scene-overview relative h-full min-h-[600px] overflow-hidden bg-[#0d141d]">
      <PlantView />
      <div className="pointer-events-none absolute inset-0 flex items-start justify-between gap-4 p-4 lg:p-5">
        <GlassPanel as="section" aria-label="Estado de la planta" className="pointer-events-auto flex w-[280px] flex-col gap-4 p-4">
          <Title glass />
          <AlarmHealth layout="stack" />
          <ConnectionLine />
        </GlassPanel>
        <GlassPanel as="section" aria-label="Módulos" className="pointer-events-auto flex max-h-full w-[320px] flex-col gap-2 overflow-y-auto p-3">
          <h2 className="px-1 pt-1 text-xs font-semibold tracking-[0.14em] text-muted uppercase">Módulos</h2>
          {modules.map((o) => (
            <ModuleHealthCard key={o.id} o={o} compact />
          ))}
        </GlassPanel>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-bg/70 px-2 py-1 text-xs text-muted">
        Arrastrá para orbitar · rueda para acercar · los valores de cada equipo están en su módulo
      </p>
    </div>
  );
}

/** Sin 3D (o en móvil): tarjetas por módulo sobre el plano de la planta; el 3D, si el cliente lo tiene, es opt-in. */
function MapOverview({ modules, has3d, mobile }: { modules: ModuleOverview[]; has3d: boolean; mobile: boolean }) {
  const [show3d, setShow3d] = useState(false);
  return (
    <div data-testid="plant-overview" data-mode="map" className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-5 md:px-6">
      <Title />
      <AlarmHealth layout="row" />
      <section aria-label="Módulos" className="relative overflow-hidden rounded-2xl border border-line bg-surface/30 p-3 md:p-5">
        <HexPattern />
        <div className="relative grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 min-[1000px]:grid-cols-3">
          {modules.map((o) => (
            <ModuleHealthCard key={o.id} o={o} />
          ))}
        </div>
      </section>
      {has3d && mobile && (
        <section aria-label="Planta en 3D">
          {show3d ? (
            <div data-testid="overview-3d" className="scene-overview relative h-[380px] overflow-hidden rounded-xl border border-line bg-[#0d141d]">
              <PlantView />
            </div>
          ) : (
            <button
              type="button"
              data-testid="overview-3d-open"
              onClick={() => setShow3d(true)}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold hover:bg-surface-2"
            >
              <IconCube className="text-lg" /> Ver la planta en 3D
            </button>
          )}
        </section>
      )}
      <ConnectionLine />
    </div>
  );
}

/** `/`: vista general de la planta (nivel 1). Un cliente con un solo módulo va directo a su pantalla. */
export function PlantOverview() {
  const router = useRouter();
  const ids = useActiveModuleIds();
  const isMobile = useIsMobile();
  const modules = useOverview(ids);
  const mode = overviewMode(ids);
  const href = mode === 'redirect' ? landingHref(ids) : null;
  useEffect(() => {
    if (href) router.replace(href);
  }, [href, router]);
  useEffect(() => {
    document.title = 'Vista general · Campo';
  }, []);
  if (mode === 'none') return <NoModules />;
  if (mode === 'redirect' || isMobile === undefined) return null;
  if (mode === 'scene' && !isMobile) return <SceneOverview modules={modules} />;
  return <MapOverview modules={modules} has3d={mode === 'scene'} mobile={isMobile} />;
}
