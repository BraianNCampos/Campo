'use client';

import { memo } from 'react';
import { IconCheck, IconChevron, IconPause } from '../icons';
import { lifecycleOf, type LiveAlarm } from '@/lib/alarm-lifecycle';
import { LifecycleBadge, KindBadge, PriorityBadge } from './badges';
import { alarmTitle, effectiveKind, limitText, remainingText, timeText, valueText } from './model';

export interface RowProps {
  alarm: LiveAlarm;
  name: string;
  now: number;
  canAck: boolean;
  canShelve: boolean;
  /** pestaña Historial: sin acciones, solo detalle */
  history?: boolean;
  selected?: boolean;
  busy?: boolean;
  onAck(id: string): void;
  onShelve(a: LiveAlarm): void;
  onUnshelve(a: LiveAlarm): void;
  onOpen(a: LiveAlarm): void;
}

const act = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-sm font-semibold transition-colors';
const actPlain = `${act} border-line bg-surface-2 text-fg hover:bg-line`;

export const GRID = 'xl:grid xl:grid-cols-[7.5rem_minmax(0,1fr)_8rem_11rem_23rem] xl:items-center xl:gap-x-4';

function RowImpl({ alarm: a, name, now, canAck, canShelve, history, selected, busy, onAck, onShelve, onUnshelve, onOpen }: RowProps) {
  const life = lifecycleOf(a);
  const needsAck = life === 'unacked' || life === 'rtn_unacked';
  const stripe =
    life === 'unacked' ? (a.severity === 'critical' ? 'border-l-crit' : 'border-l-warn') : life === 'rtn_unacked' ? 'border-l-calm-bar' : 'border-l-line';
  return (
    <li
      data-testid="alarm-row"
      data-alarm-id={a.id}
      data-severity={a.severity}
      data-lifecycle={life}
      data-asset={a.asset}
      className={`rounded-xl border border-l-4 border-line bg-surface p-3 ${stripe} ${selected ? 'ring-2 ring-accent' : ''} xl:py-2.5 ${GRID}`}
    >
      <div className="flex flex-wrap items-center gap-2 xl:flex-col xl:items-start xl:gap-1.5">
        <PriorityBadge severity={a.severity} />
        <KindBadge kind={effectiveKind(a)} />
        <span className="ml-auto text-xs text-muted xl:hidden" data-testid="alarm-time-m">{timeText(a, now)}</span>
      </div>

      <div className="mt-2 min-w-0 xl:mt-0">
        <p className="truncate text-base font-bold" data-testid="alarm-asset">{name} <span className="font-mono text-xs font-normal text-muted">{a.asset}</span></p>
        <p className="text-sm text-fg/90 xl:line-clamp-2" data-testid="alarm-title">{alarmTitle(a)}</p>
      </div>

      <dl className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm xl:mt-0 xl:flex-col xl:gap-y-0.5">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-muted">Valor</dt>
          <dd className="font-mono text-base font-semibold tabular-nums" data-testid="alarm-value">{valueText(a)}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-muted">Límite</dt>
          <dd className="font-mono tabular-nums text-muted" data-testid="alarm-limit">{limitText(a)}</dd>
        </div>
      </dl>

      <div className="mt-2 flex flex-col items-start gap-1 xl:mt-0">
        <LifecycleBadge lifecycle={life} />
        {life === 'shelved' ? (
          <span className="text-xs text-muted" data-testid="alarm-time">{remainingText(a.shelvedUntil, now)}</span>
        ) : (
          <span className="hidden text-xs text-muted xl:inline" data-testid="alarm-time">{timeText(a, now)}</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 xl:mt-0 xl:justify-end">
        {!history && canAck && needsAck && (
          <button type="button" data-testid="ack" disabled={busy} onClick={() => onAck(a.id)} className={`${act} flex-1 border-fg/50 bg-surface-2 hover:bg-line xl:flex-none`} aria-label={`Reconocer alarma de ${name}`}>
            <IconCheck className="text-lg" /> Reconocer
          </button>
        )}
        {!history && canShelve && (life === 'unacked' || life === 'acked') && (
          <button type="button" data-testid="shelve" onClick={() => onShelve(a)} className={`${actPlain} flex-1 xl:flex-none`} aria-label={`Postergar alarma de ${name}`}>
            <IconPause className="text-lg" /> Postergar
          </button>
        )}
        {!history && canShelve && life === 'shelved' && (
          <button type="button" data-testid="unshelve" onClick={() => onUnshelve(a)} className={`${actPlain} flex-1 xl:flex-none`} aria-label={`Reactivar alarma de ${name}`}>
            Reactivar
          </button>
        )}
        <button type="button" data-testid="open-detail" onClick={() => onOpen(a)} className={`${actPlain} flex-1 xl:flex-none`} aria-label={`Ver detalle de la alarma de ${name}`}>
          Detalle <IconChevron className="text-base" />
        </button>
      </div>
    </li>
  );
}

export const AlarmRow = memo(RowImpl);
