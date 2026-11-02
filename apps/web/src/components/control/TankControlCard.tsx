'use client';

import { memo, useId, useMemo, useState } from 'react';
import { useCardData } from '../modules/useCardData';
import { StatusChip } from '../modules/StatusChip';
import { fmtNum } from '@/lib/modules/kpis';
import { COMMAND_LABEL, orderText } from '@/lib/control/flow';
import { canOrder } from '@/lib/control/interlocks';
import type { OrderCommand } from '@campo/shared';
import { IconArrowDown, IconArrowUp, IconCheck, IconCritical, IconLock, IconStop, KIND_ICON } from '../icons';
import { ConfirmOrderDialog, type OrderRequest } from './ConfirmOrderDialog';
import { useControlRow } from './useControlData';

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** Nivel actual y objetivo sobre una misma barra (el objetivo es la marca vertical). Valores en texto además del dibujo. */
function LevelTargetBar({ level, target, range, label }: { level: number | undefined; target: number | undefined; range: { min: number; max: number }; label: string }) {
  const pos = (v: number) => `${Math.min(100, Math.max(0, v))}%`;
  return (
    <div className="relative h-4 w-full overflow-hidden rounded-[3px] bg-bg ring-1 ring-line ring-inset" role="img" aria-label={label}>
      <div className="absolute inset-y-0 left-0 bg-calm-bar transition-[width] duration-300" style={{ width: level === undefined ? 0 : pos(level) }} />
      {/* rango permitido del objetivo */}
      <span className="absolute inset-y-0 w-px bg-fg/40" style={{ left: pos(range.min) }} aria-hidden="true" />
      <span className="absolute inset-y-0 w-px bg-fg/40" style={{ left: pos(range.max) }} aria-hidden="true" />
      {target !== undefined && <span data-testid="target-mark" className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-accent" style={{ left: pos(target) }} aria-hidden="true" />}
    </div>
  );
}

function CardImpl({ id, plant }: { id: string; plant: string }) {
  const d = useCardData(id);
  const row = useControlRow(id);
  const uid = useId();
  const [target, setTarget] = useState<number | null>(null);
  const [req, setReq] = useState<OrderRequest | null>(null);
  const Icon = KIND_ICON[d.def?.type ?? 'tank'];

  const base = row.setpoint ?? (row.level !== undefined ? row.level + 10 : 60);
  const t = target ?? clampInt(base, row.range.min, row.range.max);
  const mayOrder = canOrder(row.role);
  const level = row.level;
  const order = row.order;

  const fill = useMemo(() => row.check('fill', t), [row, t]);
  const drain = useMemo(() => row.check('drain', t), [row, t]);
  const stop = useMemo(() => row.check('stop'), [row]);
  /** permisos que se muestran: los del comando que corresponde al objetivo elegido */
  const shown = level !== undefined && t < level ? drain : fill;
  const okCount = shown.items.filter((i) => i.ok).length;

  const open = (command: OrderCommand) => setReq({ plant, asset: id, name: d.name, tag: d.tag, command, ...(command === 'stop' ? {} : { target: t }) });

  const reasons = [
    !fill.blocked ? null : { c: 'fill' as const, text: fill.blocked },
    !drain.blocked ? null : { c: 'drain' as const, text: drain.blocked },
  ].filter((x): x is { c: 'fill' | 'drain'; text: string } => x !== null);

  return (
    <article
      data-testid={`control-card-${id}`}
      data-active={order ? order.command : 'none'}
      aria-label={`${d.name}: control de llenado`}
      className={`flex flex-col gap-3 rounded-xl border bg-surface p-4 ${order ? 'border-accent/70' : 'border-line'}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[15px] leading-tight font-semibold">
            <Icon className="shrink-0 text-lg text-muted" />
            <span className="truncate">{d.name}</span>
          </h3>
          <p className="truncate pl-7 font-mono text-[11px] text-muted" data-testid={`control-tag-${id}`}>{d.tag}</p>
        </div>
        <StatusChip status={d.status} severity={d.severity} data={`control-status-${id}`} />
      </header>

      <div className="grid grid-cols-2 gap-3">
        <p>
          <span className="block text-xs text-muted">Nivel actual</span>
          <span data-testid={`control-level-${id}`} className="font-mono text-[34px] leading-none font-bold tabular-nums">
            {fmtNum(level, 1)}
          </span>
          <span className="ml-1 text-base text-muted">%</span>
        </p>
        <p className="text-right">
          <span className="block text-xs text-muted">{order?.target !== undefined ? 'Objetivo de la orden' : 'Objetivo elegido'}</span>
          <span data-testid={`control-target-${id}`} className="font-mono text-[34px] leading-none font-bold tabular-nums">
            {order?.target !== undefined ? fmtNum(order.target, 0) : t}
          </span>
          <span className="ml-1 text-base text-muted">%</span>
        </p>
      </div>
      <LevelTargetBar level={level} target={order?.target ?? t} range={row.range} label={`Nivel de ${d.name}: ${fmtNum(level, 1)} %, objetivo ${order?.target ?? t} %`} />

      {order && (
        <div data-testid={`control-active-${id}`} className="rounded-lg border border-accent/60 bg-accent/10 px-3 py-2 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            {order.command === 'drain' ? <IconArrowDown className="text-base" /> : <IconArrowUp className="text-base" />}
            {orderText(order)}
          </p>
          <p className="text-muted">
            {order.status === 'pending' ? 'Esperando que el equipo la acepte…' : order.status === 'accepted' ? 'El equipo la aceptó.' : 'En curso.'}
          </p>
        </div>
      )}

      {mayOrder ? (
        <>
          <div>
            <label htmlFor={`${uid}-t`} className="text-xs font-semibold text-muted">
              Nivel objetivo (entre {row.range.min} % y {row.range.max} %)
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                id={`${uid}-r`}
                type="range"
                aria-label={`Nivel objetivo de ${d.name}`}
                min={row.range.min}
                max={row.range.max}
                step={1}
                value={t}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="h-11 min-w-0 flex-1 accent-[var(--color-accent)]"
              />
              <input
                id={`${uid}-t`}
                data-testid={`control-input-${id}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                step={1}
                value={t}
                onChange={(e) => setTarget(Number.isFinite(e.target.valueAsNumber) ? clampInt(e.target.valueAsNumber, 1, 99) : null)}
                className="min-h-11 w-20 rounded-lg border border-line bg-bg px-2 text-center font-mono text-base"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              data-testid={`control-fill-${id}`}
              disabled={!!fill.blocked}
              onClick={() => open('fill')}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent px-2 text-sm font-bold text-bg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconArrowUp className="text-base" /> {COMMAND_LABEL.fill}
            </button>
            <button
              type="button"
              data-testid={`control-drain-${id}`}
              disabled={!!drain.blocked}
              onClick={() => open('drain')}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-fg/50 bg-surface-2 px-2 text-sm font-bold hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconArrowDown className="text-base" /> {COMMAND_LABEL.drain}
            </button>
            {/* detener siempre está disponible (operator+), aunque haya otros enclavamientos */}
            <button
              type="button"
              data-testid={`control-stop-${id}`}
              disabled={!!stop.blocked}
              onClick={() => open('stop')}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-crit/70 bg-crit/15 px-2 text-sm font-bold text-crit hover:bg-crit/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconStop className="text-base" /> {COMMAND_LABEL.stop}
            </button>
          </div>

          {reasons.length > 0 && (
            <ul data-testid={`control-reasons-${id}`} className="flex flex-col gap-1 text-[13px]" aria-label="Por qué no se puede">
              {reasons.map((r) => (
                <li key={r.c} className="flex items-start gap-1.5 text-muted">
                  <IconLock className="mt-0.5 shrink-0 text-sm" />
                  <span>
                    <strong className="text-fg">No se puede {r.c === 'fill' ? 'llenar' : 'vaciar'}:</strong> {r.text}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <details data-testid={`control-interlocks-${id}`} className="rounded-lg border border-line bg-bg px-3 py-2 text-sm">
            <summary className="min-h-8 cursor-pointer font-semibold">
              Permisos de enclavamiento ({okCount} de {shown.items.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {shown.items.map((i) => (
                <li key={i.id} data-ok={i.ok} className="flex items-start gap-2">
                  {i.ok ? <IconCheck className="mt-0.5 shrink-0 text-base text-calm" /> : <IconCritical className="mt-0.5 shrink-0 text-base text-crit" />}
                  <span className={i.ok ? 'text-muted' : 'text-fg'}>{i.ok ? i.label : (i.reason ?? i.label)}</span>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p data-testid={`control-readonly-${id}`} className="flex items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted">
          <IconLock className="mt-0.5 shrink-0 text-base" />
          Tu rol es de consulta: ves el nivel y el registro, pero las órdenes las da alguien de operación, ingeniería o administración.
        </p>
      )}

      {req && <ConfirmOrderDialog req={req} onClose={() => setReq(null)} />}
    </article>
  );
}

export const TankControlCard = memo(CardImpl);
