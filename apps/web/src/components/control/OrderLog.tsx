'use client';

import { useState } from 'react';
import type { Order } from '@campo/shared';
import { controlMessage } from '@/lib/control/errors';
import { agoText, isCancellable, orderText, outcomeText, STATUS_LABEL, STATUS_TONE, type StatusTone } from '@/lib/control/flow';
import { canOrder } from '@/lib/control/interlocks';
import { getControlApi } from '@/lib/control';
import { displayTag } from '@/lib/tags';
import { useLiveStore } from '@/store/live-store';
import { selectOrders, useOrderStore } from '@/store/order-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { useNow } from '../hooks';
import { Button } from '../admin/ui';
import { IconCheck, IconClock, IconCritical, IconStop } from '../icons';

const TONE: Record<StatusTone, { cls: string; Icon: typeof IconCheck }> = {
  progress: { cls: 'border-accent/70 bg-accent/10 text-fg', Icon: IconClock },
  ok: { cls: 'border-calm-bar/50 text-calm', Icon: IconCheck },
  bad: { cls: 'border-crit/70 bg-crit/15 text-crit', Icon: IconCritical },
  neutral: { cls: 'border-line text-muted', Icon: IconStop },
};

export function OrderStatusBadge({ status }: { status: Order['status'] }) {
  const { cls, Icon } = TONE[STATUS_TONE[status]];
  return (
    <span data-testid="order-status" data-status={status} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${cls}`}>
      <Icon className="text-sm" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Row({ o, now, canCancel }: { o: Order; now: number; canCancel: boolean }) {
  const tag = useLiveStore((s) => displayTag(o.asset, s.catalog[o.asset]));
  const name = useLiveStore((s) => s.catalog[o.asset]?.name ?? o.asset);
  const [busy, setBusy] = useState(false);
  async function cancel() {
    setBusy(true);
    try {
      const out = await getControlApi().cancelOrder(o.id);
      useOrderStore.getState().upsert(out.plant ? out : { ...out, plant: o.plant });
      toast.success('Mandamos la orden de detención.');
    } catch (e) {
      toast.error(controlMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li data-testid="order-row" data-order-id={o.id} data-status={o.status} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 lg:grid lg:grid-cols-[6rem_minmax(0,1.1fr)_11rem_minmax(0,1fr)_minmax(0,1.4fr)_7.5rem] lg:items-center lg:gap-x-4 lg:py-2.5">
      <p className="text-sm text-muted tabular-nums" title={new Date(o.requestedAt).toLocaleString('es-AR')}>
        <span className="block font-mono text-fg">{clock(o.requestedAt)}</span>
        {agoText(now - o.requestedAt)}
      </p>
      <p className="min-w-0 text-sm font-semibold">
        <span className="font-mono text-xs text-muted">{tag}</span> <span className="truncate">{name}</span>
        <span className="block text-base">{orderText(o)}</span>
      </p>
      <div>
        <OrderStatusBadge status={o.status} />
      </div>
      <p className="min-w-0 truncate text-sm text-muted" title={o.requestedBy.email}>
        <span className="text-xs">Pidió </span>
        {o.requestedBy.email || '—'}
      </p>
      <p className="text-sm" data-testid="order-outcome">
        {outcomeText(o)}
      </p>
      <div className="lg:text-right">
        {canCancel && isCancellable(o) && (
          <Button variant="danger" busy={busy} onClick={() => void cancel()} data-testid="order-cancel" aria-label={`Cancelar la orden: ${orderText(o)} en ${tag}`}>
            Cancelar
          </Button>
        )}
      </div>
    </li>
  );
}

/** Registro de órdenes en vivo: estado, quién, cuándo y resultado; las en curso se pueden cancelar (envía un `stop`). */
export function OrderLog({ limit = 40 }: { limit?: number }) {
  const orders = useOrderStore(selectOrders);
  const ready = useOrderStore((s) => s.ready);
  const failed = useOrderStore((s) => s.error);
  const role = useSessionStore((s) => s.me?.role);
  const now = useNow(1000);
  const shown = orders.slice(0, limit);
  return (
    <section aria-label="Registro de órdenes" data-testid="order-log" className="flex flex-col gap-2">
      <h2 className="text-lg font-bold">Registro de órdenes</h2>
      <p className="text-sm text-muted">Todo lo que se ordenó, quién lo pidió y cómo terminó. Se actualiza solo.</p>
      {failed && (
        <p role="alert" data-testid="order-log-error" className="rounded-lg border border-warn/60 bg-warn/10 px-3 py-2 text-sm text-warn">
          No pudimos cargar el registro completo. Lo que se ve acá puede estar incompleto; las órdenes nuevas van a aparecer igual.
        </p>
      )}
      {shown.length === 0 ? (
        <p data-testid="order-log-empty" className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
          {ready ? 'Todavía no se dio ninguna orden en esta planta.' : 'Cargando el registro…'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {shown.map((o) => (
            <Row key={o.id} o={o} now={now} canCancel={canOrder(role)} />
          ))}
        </ul>
      )}
    </section>
  );
}
