'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { IconCritical } from '../icons';

export const inputCls = (error?: string) =>
  `min-h-11 w-full rounded-lg border bg-bg px-3 text-base text-fg placeholder:text-muted/70 disabled:opacity-60 ${
    error ? 'border-crit' : 'border-line'
  }`;

interface Common {
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
}

function Shell({ id, label, hint, error, children, className = '' }: Common & { id: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="flex items-start gap-1.5 text-sm font-medium text-crit">
          <IconCritical className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, hint: unknown, error: unknown) => [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;

export function TextField({ label, hint, error, className, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} className={inputCls(error)} {...rest} />
    </Shell>
  );
}

export function SelectField({ label, hint, error, className, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <select id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} className={inputCls(error)} {...rest}>
        {children}
      </select>
    </Shell>
  );
}

export function TextAreaField({ label, hint, error, className, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={`${inputCls(error)} py-2 font-mono text-sm`}
        {...rest}
      />
    </Shell>
  );
}

export function CheckField({ label, hint, className = '', ...rest }: { label: string; hint?: string; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
        <input id={id} type="checkbox" className="size-5 shrink-0 accent-[var(--color-accent)]" {...rest} />
        {label}
      </label>
      {hint && <p className="ml-8 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Interruptor accesible (role=switch) con etiqueta visible. */
export function Switch({ checked, onChange, label, disabled, onText = 'Activa', offText = 'Inactiva' }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; onText?: string; offText?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-11 min-w-11 items-center gap-2 disabled:opacity-50"
    >
      <span className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${checked ? 'border-ok bg-ok/30' : 'border-line bg-surface-2'}`}>
        <span className={`absolute top-0.5 size-4 rounded-full transition-all ${checked ? 'left-6 bg-ok' : 'left-1 bg-muted'}`} />
      </span>
      <span className={`text-sm font-semibold ${checked ? 'text-ok' : 'text-muted'}`}>{checked ? onText : offText}</span>
    </button>
  );
}
