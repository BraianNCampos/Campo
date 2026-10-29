'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { AdminApiError } from '@/lib/admin/errors';
import { IconCheck, IconCritical, IconInfo, IconWarning } from '../icons';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BASE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-bg hover:brightness-110',
  secondary: 'border border-line bg-surface-2 text-fg hover:bg-line',
  danger: 'border border-crit/70 bg-crit/15 text-crit hover:bg-crit/25',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
};

/** Clases de botón (también para <Link>). */
export const btn = (variant: Variant = 'secondary', extra = '') => `${BASE} ${VARIANT[variant]} ${extra}`.trim();

export function Button({
  variant = 'secondary',
  busy,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button type={type} disabled={disabled || busy} aria-busy={busy || undefined} className={btn(variant, className)} {...rest}>
      {busy && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-6' }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block animate-spin rounded-full border-2 border-line border-t-accent ${className}`} />;
}

export function LoadingBlock({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 rounded-2xl border border-line bg-surface p-10 text-muted">
      <Spinner />
      {label}
    </div>
  );
}

const TONES = {
  error: { cls: 'border-crit/60 bg-crit/15 text-crit', Icon: IconCritical },
  warning: { cls: 'border-warn/60 bg-warn/15 text-warn', Icon: IconWarning },
  success: { cls: 'border-ok/60 bg-ok/15 text-ok', Icon: IconCheck },
  info: { cls: 'border-accent/60 bg-accent/15 text-accent', Icon: IconInfo },
} as const;
export type Tone = keyof typeof TONES;

export function Alert({ tone = 'info', children, onDismiss, role, className = '' }: { tone?: Tone; children: ReactNode; onDismiss?: () => void; role?: 'alert' | 'status'; className?: string }) {
  const { cls, Icon } = TONES[tone];
  return (
    <div role={role ?? (tone === 'error' ? 'alert' : 'status')} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${cls} ${className}`}>
      <Icon className="mt-0.5 shrink-0 text-lg" />
      <div className="min-w-0 flex-1 font-medium break-words">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Cerrar aviso" className="-m-2 flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-bg/30">
          ×
        </button>
      )}
    </div>
  );
}

/** Error de la API junto al formulario: mensaje y, si hay, lista de problemas de validación. */
export function ApiErrorAlert({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = error instanceof AdminApiError ? error : null;
  return (
    <Alert tone="error" className={className}>
      <p>{e ? e.message : 'Ha ocurrido un error inesperado.'}</p>
      {e && e.details.length > 1 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 font-normal">
          {e.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-crit/50 bg-surface p-5">
      <ApiErrorAlert error={error} className="w-full" />
      {onRetry && (
        <Button onClick={onRetry} variant="secondary">
          Reintentar
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line bg-surface px-4 py-10 text-center">
      {icon && <div className="text-4xl text-muted">{icon}</div>}
      <p className="text-base font-semibold">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const BADGE_TONES: Record<'neutral' | Tone, string> = {
  neutral: 'border-line text-muted',
  error: 'border-crit/60 bg-crit/15 text-crit',
  warning: 'border-warn/60 bg-warn/15 text-warn',
  success: 'border-ok/60 bg-ok/15 text-ok',
  info: 'border-accent/60 bg-accent/15 text-accent',
};

export function Badge({ tone = 'neutral', icon, children }: { tone?: 'neutral' | Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-xs font-semibold whitespace-nowrap ${BADGE_TONES[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

export const th = 'px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted uppercase';
export const td = 'px-3 py-2.5 align-middle text-sm';
export const tableWrap = 'hidden overflow-x-auto rounded-2xl border border-line bg-surface md:block';
export const cardList = 'flex flex-col gap-3 md:hidden';
export const card = 'rounded-2xl border border-line bg-surface p-4';
