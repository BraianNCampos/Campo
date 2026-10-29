import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, Modal } from './Modal';
import { nextFocusTarget } from './focus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.style.overflow = '';
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const key = (k: string, opts: KeyboardEventInit = {}) =>
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  });
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button id="opener" onClick={() => setOpen(true)}>
        Abrir
      </button>
      {open && (
        <Modal
          title="Mi diálogo"
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <input id="a" aria-label="a" />
          <button id="b">b</button>
        </Modal>
      )}
    </div>
  );
}

describe('Modal', () => {
  it('role dialog, aria-modal, título asociado y foco inicial en el contenido', () => {
    render(<Harness />);
    act(() => $('#opener').click());
    const d = $('[role="dialog"]');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Mi diálogo');
    expect(document.activeElement?.id).toBe('a');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Tab/Shift+Tab giran dentro del diálogo', () => {
    render(<Harness />);
    act(() => $('#opener').click());
    $('#b').focus();
    key('Tab'); // último → primero (la × de cabecera es el primero del DOM)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Cerrar');
    key('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('b');
  });

  it('Esc cierra y devuelve el foco al elemento que lo abrió', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    $('#opener').focus();
    act(() => $('#opener').click());
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.id).toBe('opener');
    expect(document.body.style.overflow).toBe('');
  });

  it('con closable=false Esc no cierra', () => {
    const onClose = vi.fn();
    render(
      <Modal title="t" onClose={onClose} closable={false}>
        <button>x</button>
      </Modal>,
    );
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('con diálogos apilados sólo el superior reacciona a Esc', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    render(
      <div>
        <Modal title="abajo" onClose={lower}>
          <button>x</button>
        </Modal>
        <Modal title="arriba" onClose={upper}>
          <button>y</button>
        </Modal>
      </div>,
    );
    key('Escape');
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });
});

describe('nextFocusTarget', () => {
  it('lógica pura del cierre de foco', () => {
    const c = document.createElement('div');
    const [x, y] = [document.createElement('button'), document.createElement('button')];
    c.append(x, y);
    document.body.append(c);
    expect(nextFocusTarget([x, y], y, false, c)).toBe(x);
    expect(nextFocusTarget([x, y], x, true, c)).toBe(y);
    expect(nextFocusTarget([x, y], x, false, c)).toBeNull();
    expect(nextFocusTarget([x, y], document.body, false, c)).toBe(x);
    expect(nextFocusTarget([], null, false, c)).toBe(c);
    c.remove();
  });
});

describe('ConfirmDialog', () => {
  it('role alertdialog, foco en Cancelar y confirma sólo con el botón', async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ConfirmDialog title="Borrar" description="seguro" confirmLabel="Borrar ya" onConfirm={onConfirm} onClose={onClose} />);
    expect($('[role="alertdialog"]')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Cancelar');
    await act(async () => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Borrar ya')!.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requireText: el botón sigue deshabilitado hasta escribir el id exacto', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ConfirmDialog title="Borrar planta" description="x" confirmLabel="Eliminar" requireText="norte" onConfirm={onConfirm} onClose={() => {}} />);
    const btn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Eliminar')!;
    const input = $<HTMLInputElement>('input');
    expect(btn.disabled).toBe(true);
    expect(document.activeElement).toBe(input);
    const type = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('nort');
    expect(btn.disabled).toBe(true);
    type('norte');
    expect(btn.disabled).toBe(false);
  });

  it('si onConfirm falla muestra el error dentro y no cierra', async () => {
    const onClose = vi.fn();
    const { AdminApiError } = await import('@/lib/admin/errors');
    const onConfirm = vi.fn(async () => {
      throw new AdminApiError('La planta tiene 2 activos', 409, 'conflict');
    });
    render(<ConfirmDialog title="x" description="x" confirmLabel="Sí" onConfirm={onConfirm} onClose={onClose} />);
    await act(async () => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sí')!.click();
    });
    expect($('[role="alertdialog"] [role="alert"]').textContent).toContain('La planta tiene 2 activos');
    expect(onClose).not.toHaveBeenCalled();
  });
});
