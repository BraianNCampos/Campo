import type { AlarmKind, AlarmLifecycle, Severity } from '@campo/shared';
import { LIFECYCLE_LABEL } from '@/lib/alarm-lifecycle';
import { IconBell, IconCheck, IconCritical, IconPause, IconRefresh, IconWarning } from '../icons';
import { KIND_LABEL, SEVERITY_LABEL } from './model';

const chip = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold';

/** Prioridad: icono + texto + color (nunca sólo color). */
export function PriorityBadge({ severity }: { severity: Severity }) {
  const crit = severity === 'critical';
  const Icon = crit ? IconCritical : IconWarning;
  return (
    <span data-testid="priority" data-severity={severity} className={`${chip} ${crit ? 'border-crit/70 bg-crit/15 text-crit' : 'border-warn/60 bg-warn/10 text-warn'}`}>
      <Icon className="text-sm" />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

/** Tipo ISA-18.2 (HH/HI/LO/LL/DEV/ROC) en mono; el nombre largo va en el título y para lectores de pantalla. */
export function KindBadge({ kind }: { kind: AlarmKind }) {
  return (
    <abbr title={KIND_LABEL[kind]} data-testid="kind" aria-label={`Tipo ${kind}: ${KIND_LABEL[kind].toLowerCase()}`} className={`${chip} border-line font-mono text-fg no-underline`}>
      {kind}
    </abbr>
  );
}

const LIFE: Record<AlarmLifecycle, { cls: string; Icon: typeof IconBell }> = {
  unacked: { cls: 'border-fg/60 bg-surface-2 text-fg', Icon: IconBell },
  acked: { cls: 'border-line text-muted', Icon: IconCheck },
  rtn_unacked: { cls: 'border-calm-bar/70 bg-calm-bar/10 text-calm', Icon: IconRefresh },
  shelved: { cls: 'border-line text-muted', Icon: IconPause },
  closed: { cls: 'border-line text-muted', Icon: IconCheck },
};

/** Estado del ciclo de vida: lo que falta atender (sin reconocer) destaca; lo demás queda en neutros. */
export function LifecycleBadge({ lifecycle }: { lifecycle: AlarmLifecycle }) {
  const { cls, Icon } = LIFE[lifecycle];
  return (
    <span data-testid="lifecycle" data-lifecycle={lifecycle} className={`${chip} ${cls}`}>
      <Icon className="text-sm" />
      {LIFECYCLE_LABEL[lifecycle]}
    </span>
  );
}
