'use client';

import { useToastStore } from '@/store/toast-store';
import { IconCheck, IconCritical, IconInfo } from '../icons';

const KIND = {
  success: { cls: 'border-ok/70 text-ok', Icon: IconCheck },
  error: { cls: 'border-crit/70 text-crit', Icon: IconCritical },
  info: { cls: 'border-accent/70 text-accent', Icon: IconInfo },
} as const;

/** Región aria-live="polite": los avisos de éxito se anuncian sin quitar el foco ni bloquear. */
export function ToastRegion() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      data-testid="toasts"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-4"
    >
      {toasts.map((t) => {
        const { cls, Icon } = KIND[t.kind];
        return (
          <div key={t.id} data-testid="toast" className={`pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-xl border bg-surface-2 py-1 pr-1 pl-3 text-sm font-semibold shadow-2xl ${cls}`}>
            <Icon className="shrink-0 text-lg" />
            <span className="min-w-0 flex-1 py-2 text-fg">{t.text}</span>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Cerrar aviso" className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-line hover:text-fg">
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
