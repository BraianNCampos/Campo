'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from '../icons';
import { ApiErrorAlert, Button } from './ui';
import { TextField } from './fields';
import { focusableIn, nextFocusTarget } from './focus';

// Pila de diálogos abiertos: sólo el superior reacciona a Esc/Tab (p. ej. una confirmación sobre un formulario).
const stack: symbol[] = [];
let scrollLocks = 0;

export interface ModalProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** `false` mientras se envía: Esc y × no cierran */
  closable?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** role="alertdialog" para confirmaciones */
  alert?: boolean;
}

const WIDTH = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl' };

/** Diálogo accesible: role dialog, aria-modal, foco atrapado, Esc, foco devuelto al abrir. Hoja inferior en móvil. */
export function Modal({ title, description, onClose, children, closable = true, size = 'md', alert }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  const closableRef = useRef(closable);
  useEffect(() => {
    closeRef.current = onClose;
    closableRef.current = closable;
  });

  useEffect(() => {
    const token = Symbol('modal');
    stack.push(token);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLocks++ === 0) document.body.style.overflow = 'hidden';

    const el = panel.current;
    if (el) {
      // primer campo/botón del contenido (no la × de cabecera, que va primero en el DOM)
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(el).find((x) => !x.hasAttribute('data-modal-close')) ?? el;
      target.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token || !panel.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (closableRef.current) closeRef.current();
      } else if (e.key === 'Tab') {
        const next = nextFocusTarget(focusableIn(panel.current), document.activeElement, e.shiftKey, panel.current);
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      stack.splice(stack.indexOf(token), 1);
      if (--scrollLocks === 0) document.body.style.overflow = '';
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 sm:items-center sm:p-4">
      <div
        ref={panel}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:rounded-2xl ${WIDTH[size]}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold">
              {title}
            </h2>
            {description && (
              <div id={descId} className="mt-1 text-sm text-muted">
                {description}
              </div>
            )}
          </div>
          <button
            type="button"
            data-modal-close
            aria-label="Cerrar"
            disabled={!closable}
            onClick={onClose}
            className="-mt-1 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            <IconClose />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Pie de formulario/diálogo: acciones alineadas a la derecha (apiladas en móvil). */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}

export interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Si se indica, el usuario debe escribirlo para habilitar el botón (p. ej. el id de la planta). */
  requireText?: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}

/** Confirmación de acciones destructivas. Si `onConfirm` falla, el error se muestra dentro y el diálogo sigue abierto. */
export function ConfirmDialog({ title, description, confirmLabel, requireText, danger = true, onConfirm, onClose }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ok = !requireText || typed.trim() === requireText;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} description={description} onClose={onClose} closable={!busy} size="sm" alert>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {requireText && (
          <TextField
            label={`Escribí "${requireText}" para confirmar`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-autofocus
          />
        )}
        {error != null && <ApiErrorAlert error={error} />}
        <ModalActions>
          <Button onClick={onClose} disabled={busy} data-autofocus={requireText ? undefined : ''}>
            Cancelar
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy} disabled={!ok}>
            {confirmLabel}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

