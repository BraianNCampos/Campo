'use client';

import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { LONG_PRESS_MS, WALL_INTERVALS, rotationProgress, wallGrid, wallModules } from '@/lib/wall';
import { Wordmark } from '../Brand';
import { useNow } from '../hooks';
import { IconCritical, IconMonitor, IconPause, IconPlay } from '../icons';
import { useActiveModuleIds, useModuleSummary } from '../modules/derived';
import { KpiStrip } from '../modules/KpiStrip';
import { MODULE_ICON } from '../modules/module-meta';
import { NoModules } from '../modules/NoModules';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { WallCard } from './WallCard';
import { useAspect, useWakeLock, useWallRotation } from './useWall';
import type { ModuleDef } from '@campo/shared';

const pad = (n: number) => String(n).padStart(2, '0');

function Clock() {
  const now = new Date(useNow(1000));
  return (
    <time data-testid="wall-clock" className="font-mono text-[1.6em] font-bold tabular-nums">
      {pad(now.getHours())}:{pad(now.getMinutes())}
      <span className="text-[0.6em] text-muted">:{pad(now.getSeconds())}</span>
    </time>
  );
}

function ConnectionDot() {
  const mode = useLiveStore((s) => s.mode);
  const connection = useLiveStore((s) => s.connection);
  const ok = mode === 'mock' || connection === 'open';
  return (
    <span data-testid="wall-connection" data-ok={ok} className={`inline-flex items-center gap-[0.4em] text-[0.8em] ${ok ? 'text-muted' : 'text-warn'}`}>
      <span aria-hidden="true" className={`size-[0.6em] rounded-full ${ok ? 'bg-calm-bar' : 'bg-warn'}`} />
      {ok ? (mode === 'mock' ? 'Demo' : 'En línea') : 'Reconectando…'}
    </span>
  );
}

function Panel({ module }: { module: ModuleDef }) {
  const sum = useModuleSummary(module.id);
  const aspect = useAspect();
  const { cols, rows } = wallGrid(sum.ids.length, aspect);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[0.8em]">
      <div className="text-[0.95em]"><KpiStrip kpis={sum.kpis} big /></div>
      <div
        className="grid min-h-0 flex-1 gap-[0.7em]"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {sum.ids.map((id) => (
          <WallCard key={id} id={id} />
        ))}
      </div>
    </div>
  );
}

function CriticalBanner() {
  const alarms = useLiveStore((s) => s.alarms);
  const catalog = useLiveStore((s) => s.catalog);
  const crit = useMemo(() => Object.values(alarms).filter((a) => a.severity === 'critical'), [alarms]);
  if (crit.length === 0) return null;
  const first = crit[0]!;
  return (
    <div role="alert" data-testid="wall-critical" className="flex items-center gap-[0.6em] rounded-[0.4em] border-[0.2em] border-crit bg-crit/15 px-[0.8em] py-[0.4em] text-[1.1em] font-bold text-crit">
      <IconCritical />
      <span className="min-w-0 flex-1 truncate">
        {first.message || (catalog[first.asset]?.name ?? first.asset)}
      </span>
      {crit.length > 1 && <span className="font-mono">+{crit.length - 1}</span>}
    </div>
  );
}

/** Modo pared (`/pared`): pantalla completa para TVs de planta. Sin menús; se sale con Esc o con un toque largo. */
export function WallScreen() {
  const router = useRouter();
  const ids = useActiveModuleIds();
  const modules = useMemo(() => wallModules(ids), [ids]);
  const rot = useWallRotation(modules.length);
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === s.selected)?.name);
  const entered = useRef(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);

  useWakeLock(true);

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    router.push('/');
  }, [router]);

  const enterFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().then(() => (entered.current = true), () => {});
    }
  }, []);

  useEffect(() => {
    enterFullscreen(); // sólo funciona si el navegador lo permite (hace falta un gesto reciente); si no, queda en ventana
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && exit();
    // Esc en pantalla completa lo consume el navegador: al salir de fullscreen salimos también del modo pared
    const onFs = () => {
      if (entered.current && !document.fullscreenElement) router.push('/');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [enterFullscreen, exit, router]);

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-wall-control]')) return;
    const p = { fired: false, timer: setTimeout(() => { p.fired = true; exit(); }, LONG_PRESS_MS) };
    press.current = p;
  };
  const onUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    clearTimeout(p.timer);
    press.current = null;
    if (!p.fired && !(e.target as HTMLElement).closest('[data-wall-control]')) rot.togglePause(); // un toque: pausa / sigue
  };

  if (modules.length === 0) {
    return (
      <div className="flex h-dvh flex-col bg-bg" data-testid="wall">
        <NoModules />
        <button type="button" onClick={exit} className="mx-auto mb-8 min-h-11 rounded-lg border border-line px-5 font-semibold">Volver</button>
      </div>
    );
  }
  const current = modules[Math.min(rot.state.index, modules.length - 1)]!;
  const Icon = MODULE_ICON[current.id];

  return (
    <div
      data-testid="wall"
      data-module={current.id}
      data-paused={rot.state.paused}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={() => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } }}
      className="flex h-dvh w-screen flex-col gap-[0.8em] overflow-hidden bg-bg p-[1.2vmin] select-none"
      style={{ fontSize: 'clamp(15px, 2.1vmin, 46px)', touchAction: 'manipulation' }}
    >
      <header className="flex items-center justify-between gap-[1em]">
        <div className="flex min-w-0 items-center gap-[0.8em]">
          <Wordmark className="text-[1.5em]" />
          <span aria-hidden="true" className="h-[1.4em] w-px bg-line" />
          <h1 data-testid="wall-module" className="flex min-w-0 items-center gap-[0.4em] truncate text-[1.5em] font-extrabold tracking-tight">
            <Icon className="shrink-0 text-muted" /> <span className="truncate">{current.label}</span>
          </h1>
          {plantName && <span className="hidden truncate text-[0.9em] text-muted min-[700px]:inline">{plantName}</span>}
        </div>
        <div className="flex items-center gap-[1em]">
          <ConnectionDot />
          {rot.state.paused && (
            <span data-testid="wall-paused" className="inline-flex items-center gap-[0.3em] rounded-full border border-line px-[0.7em] py-[0.15em] text-[0.8em] font-semibold text-muted">
              <IconPause /> En pausa
            </span>
          )}
          <Clock />
        </div>
      </header>

      <div className="h-[0.25em] overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div className="h-full bg-calm-bar" style={{ width: `${modules.length > 1 && !rot.state.paused ? rotationProgress(rot.state, rot.interval) * 100 : 0}%`, transition: 'width 250ms linear' }} />
      </div>

      <CriticalBanner />
      <Panel key={current.id} module={current} />

      <footer data-wall-control className="flex items-center justify-between gap-[1em] text-[0.7em] text-muted">
        <div className="flex items-center gap-[0.5em]" role="tablist" aria-label="Módulo en pantalla">
          {modules.length > 1 &&
            modules.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={i === rot.state.index}
                aria-label={m.label}
                data-testid={`wall-dot-${m.id}`}
                onClick={() => rot.goTo(i)}
                className="flex size-11 items-center justify-center"
              >
                <span className={`block h-[0.6em] rounded-full ${i === rot.state.index ? 'w-[2em] bg-fg' : 'w-[0.6em] bg-line'}`} />
              </button>
            ))}
        </div>
        <div className="flex items-center gap-[0.5em]">
          <span className="hidden min-[1100px]:inline">Un toque pausa · mantené apretado o Esc para salir</span>
          <div role="group" aria-label="Segundos por módulo" className="flex overflow-hidden rounded-lg border border-line">
            {WALL_INTERVALS.map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`wall-interval-${s}`}
                aria-pressed={rot.interval === s}
                onClick={() => rot.setIntervalSec(s)}
                className={`min-h-11 min-w-11 px-[0.8em] font-mono font-semibold whitespace-nowrap ${rot.interval === s ? 'bg-surface-2 text-fg' : 'hover:bg-surface-2'}`}
              >
                {s} s
              </button>
            ))}
          </div>
          <button type="button" data-testid="wall-pause" aria-label={rot.state.paused ? 'Seguir' : 'Pausar'} onClick={rot.togglePause} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line text-[1.4em]">
            {rot.state.paused ? <IconPlay /> : <IconPause />}
          </button>
          <button type="button" data-testid="wall-fullscreen" aria-label="Pantalla completa" onClick={enterFullscreen} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line text-[1.4em]">
            <IconMonitor />
          </button>
          <button type="button" data-testid="wall-exit" onClick={exit} className="min-h-11 rounded-lg border border-line px-[1em] font-semibold hover:bg-surface-2">
            Salir
          </button>
        </div>
      </footer>
    </div>
  );
}
