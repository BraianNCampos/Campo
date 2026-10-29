import { STATUS_META, type AssetStatus } from '@/lib/status';
import { STATUS_ICON } from './icons';

/** Estado con icono + texto + color (nunca sólo color). */
export function StatusBadge({ status, size = 'md', label }: { status: AssetStatus; size?: 'sm' | 'md'; label?: string }) {
  const m = STATUS_META[status];
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${m.text} ${m.soft} ${m.border} ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
      }`}
    >
      <Icon className={size === 'sm' ? 'text-sm' : 'text-base'} />
      {label ?? m.label}
    </span>
  );
}
