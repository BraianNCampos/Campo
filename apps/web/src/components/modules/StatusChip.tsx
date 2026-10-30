import type { Severity } from '@campo/shared';
import { CARD_STATUS_LABEL, type CardStatus } from '@/lib/modules/status';
import { IconCheck, IconCritical, IconNear, IconNoData, IconQuestion, IconWarning } from '../icons';

interface Look {
  cls: string;
  Icon: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
}

/** Estado con icono + texto + color (nunca sólo color). Lo normal es discreto; el color avisa. */
function look(status: CardStatus, severity?: Severity): Look {
  switch (status) {
    case 'ok':
      return { cls: 'text-calm border-calm-bar/40', Icon: IconCheck };
    case 'near':
      return { cls: 'text-warn border-warn/60 bg-warn/10', Icon: IconNear };
    case 'alarm':
      return severity === 'warning'
        ? { cls: 'text-warn border-warn/70 bg-warn/15', Icon: IconWarning }
        : { cls: 'text-crit border-crit/70 bg-crit/15', Icon: IconCritical };
    case 'uncataloged':
      return { cls: 'text-warn border-warn/40', Icon: IconQuestion };
    default:
      return { cls: 'text-bad border-bad/40', Icon: IconNoData };
  }
}

export function StatusChip({ status, severity, size = 'sm', data }: { status: CardStatus; severity?: Severity; size?: 'sm' | 'lg'; data?: string }) {
  const { cls, Icon } = look(status, severity);
  return (
    <span
      data-testid={data}
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap ${cls} ${
        size === 'lg' ? 'px-4 py-1.5 text-[length:inherit]' : 'px-2.5 py-0.5 text-xs'
      }`}
    >
      <Icon className={size === 'lg' ? 'text-[1em]' : 'text-sm'} />
      {CARD_STATUS_LABEL[status]}
    </span>
  );
}

/** Colores del estado para barras y curvas. */
export function statusColor(status: CardStatus, severity?: Severity): string {
  if (status === 'alarm') return severity === 'warning' ? 'var(--color-warn)' : 'var(--color-crit)';
  if (status === 'near') return 'var(--color-warn)';
  if (status === 'ok') return 'var(--color-calm-bar)';
  return 'var(--color-bad)';
}
