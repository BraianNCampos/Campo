'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Order, OrderCommand, OrderPreview } from '@campo/shared';
import { controlMessage } from '@/lib/control/errors';
import { countdown, type Countdown } from '@/lib/control/flow';
import { getControlApi } from '@/lib/control';
import { useOrderStore } from '@/store/order-store';

export type FlowStatus =
  | 'previewing' // paso 1 en curso
  | 'ready' // hay vista previa: falta confirmar
  | 'executing' // paso 2 en curso
  | 'done'
  | 'error';

export interface OrderFlow {
  status: FlowStatus;
  preview: OrderPreview | null;
  order: Order | null;
  error: string | null;
  countdown: Countdown | null;
  /** paso 2: ejecuta con el `confirmId` (no hace nada si venció o está bloqueada) */
  confirm(): void;
  /** vuelve a pedir la vista previa (cuando venció o falló) */
  reload(): void;
}

/**
 * Flujo de DOS PASOS (docs §14.3): al abrirse pide la vista previa (nada se ejecuta); sólo `confirm()` ejecuta, con el
 * `confirmId` de un solo uso, y mientras no venza (60 s). El reloj es inyectable en tests.
 */
export function useOrderFlow(
  o: { plant: string; asset: string; command: OrderCommand; target?: number },
  now: () => number = Date.now,
): OrderFlow {
  const [status, setStatus] = useState<FlowStatus>('previewing');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(() => now());
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getControlApi()
      .preview(o.plant, o.asset, { command: o.command, ...(o.target !== undefined && { target: o.target }) })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setTick(now());
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(controlMessage(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // la orden no cambia mientras el diálogo está abierto; `attempt` reinicia el paso 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.plant, o.asset, o.command, o.target, attempt]);

  useEffect(() => {
    if (status !== 'ready') return;
    const id = setInterval(() => setTick(now()), 250);
    return () => clearInterval(id);
  }, [status, now]);

  const cd = status === 'ready' && preview ? countdown(preview.expiresAt, tick) : null;

  const confirm = useCallback(() => {
    if (status !== 'ready' || !preview || preview.blocked || inFlight.current) return;
    if (countdown(preview.expiresAt, now()).expired) return;
    inFlight.current = true;
    setStatus('executing');
    getControlApi()
      .execute(o.plant, o.asset, preview.confirmId)
      .then((ord) => {
        if (!alive.current) return;
        useOrderStore.getState().upsert(ord.plant ? ord : { ...ord, plant: o.plant });
        setOrder(ord);
        setStatus('done');
      })
      .catch((e) => {
        if (!alive.current) return;
        setError(controlMessage(e));
        setStatus('error');
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [status, preview, o.plant, o.asset, now]);

  const reload = useCallback(() => {
    setStatus('previewing');
    setError(null);
    setPreview(null);
    setAttempt((n) => n + 1);
  }, []);

  return { status, preview, order, error, countdown: cd, confirm, reload };
}
