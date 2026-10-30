'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_WALL_INTERVAL, goTo, initialRotation, stepRotation, togglePause, type RotationState, type WallInterval } from '@/lib/wall';

const KEY = 'campo.wallInterval';
const TICK_MS = 250;

function readInterval(): WallInterval {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (v === 10 || v === 20 || v === 30) return v;
  } catch {
    /* sin almacenamiento */
  }
  return DEFAULT_WALL_INTERVAL;
}

/** Rotación automática entre `count` módulos con intervalo configurable y pausa. */
export function useWallRotation(count: number) {
  const [interval, setIntervalState] = useState<WallInterval>(readInterval); // el wall sólo se monta en cliente, tras la sesión
  const [state, setState] = useState<RotationState>(initialRotation);
  const last = useRef(0);

  useEffect(() => {
    last.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = now - last.current;
      last.current = now;
      setState((s) => stepRotation(s, dt, interval, count));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [interval, count]);

  const setIntervalSec = useCallback((v: WallInterval) => {
    setIntervalState(v);
    setState((s) => ({ ...s, elapsedMs: 0 }));
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      /* noop */
    }
  }, []);

  return {
    state,
    interval,
    setIntervalSec,
    togglePause: useCallback(() => setState(togglePause), []),
    goTo: useCallback((i: number) => setState((s) => goTo(s, i, count)), [count]),
  };
}

/** Mantiene la pantalla encendida (Screen Wake Lock) cuando el navegador lo soporta; si no, no hace nada. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let sentinel: { release(): Promise<void> } | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
        if (!nav.wakeLock || document.visibilityState !== 'visible') return;
        const s = await nav.wakeLock.request('screen');
        if (cancelled) void s.release().catch(() => {});
        else sentinel = s;
      } catch {
        /* degradación silenciosa: sin wake lock la pantalla puede apagarse */
      }
    };
    void request();
    const onVisible = () => void request(); // el sistema lo libera al ocultar la pestaña
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}

/** Relación de aspecto de la ventana (ancho/alto), actualizada al rotar la pantalla. */
export function useAspect(): number {
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    const on = () => setAspect(window.innerWidth / Math.max(1, window.innerHeight));
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return aspect;
}
