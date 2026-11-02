import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { setAdminApi } from '@/lib/admin';
import { MockAdminApi } from '@/lib/admin/mock-api';
import { AssetDialog } from './AssetDialog';

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
  setAdminApi(null);
});
const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const set = (el: HTMLElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });

const field = (start: string) => {
  const label = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(start))!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
};
const a = (id: string, type: AssetDef['type'], tag?: string, metadata: Record<string, unknown> = {}): AssetDef => ({ plant: 'demo', id, name: id, type, model3dRef: null, metadata, ...(tag ? { tag } : {}) });
const existing = [a('tk-01', 'tank', 'TNK-101'), a('tk-02', 'tank', 'TNK-102'), a('silo-01', 'silo', 'TNK-301'), a('pump-01', 'pump', 'PMP-101')];

function open(asset?: AssetDef, onSaved = vi.fn()) {
  const api = new MockAdminApi({ role: 'engineer', now: () => 1_800_000_000_000 });
  setAdminApi(api);
  act(() => root.render(<AssetDialog plant="demo" asset={asset} assets={existing} models={[]} modules={['tanks', 'control']} onClose={() => {}} onSaved={onSaved} onModelUploaded={() => {}} />));
  return onSaved;
}

describe('AssetDialog: tag y control de llenado', () => {
  it('un activo nuevo sugiere el siguiente tag libre del prefijo del tipo y lo sigue al cambiar de tipo', () => {
    open();
    const tag = () => (q('[data-testid="asset-tag"]') as HTMLInputElement).value;
    expect(tag()).toBe('TNK-302'); // tanque → TNK; el más alto usado es TNK-301 (silo)
    const type = [...document.body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'silo'))!;
    set(type, 'pump');
    expect(tag()).toBe('PMP-102');
    set(type, 'conveyor');
    expect(tag()).toBe('CONV-101');
    set(q('[data-testid="asset-tag"]')!, 'pmp-500'); // lo escrito a mano ya no se pisa
    set(type, 'valve');
    expect(tag()).toBe('PMP-500');
  });

  it('valida el formato y la unicidad del tag antes de guardar', async () => {
    const onSaved = open();
    set(field('Id'), 'tk-09');
    set(field('Nombre'), 'Tanque 9');
    set(q('[data-testid="asset-tag"]')!, 'TNK-101');
    await act(async () => { document.body.querySelector<HTMLFormElement>('form')!.requestSubmit(); });
    expect(document.body.textContent).toMatch(/El tag TNK-101 ya lo usa tk-01/);
    set(q('[data-testid="asset-tag"]')!, 'XX-1');
    await act(async () => { document.body.querySelector<HTMLFormElement>('form')!.requestSubmit(); });
    expect(document.body.textContent).toMatch(/no tiene el formato correcto/);
    expect(onSaved).not.toHaveBeenCalled();
    set(q('[data-testid="asset-tag"]')!, 'TNK-150');
    await act(async () => { document.body.querySelector<HTMLFormElement>('form')!.requestSubmit(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ id: 'tk-09', tag: 'TNK-150' });
  });

  it('en tanques y silos aparece el control de llenado y escribe metadata.control en el JSON', () => {
    open(a('tk-01', 'tank', 'TNK-101', { capacityM3: 60 }));
    expect(q('[data-testid="control-fields"]')).not.toBeNull();
    const enabled = q('[data-testid="control-enabled"]') as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    act(() => enabled.click());
    const json = () => document.body.querySelector<HTMLTextAreaElement>('textarea')!.value;
    expect(JSON.parse(json())).toMatchObject({ capacityM3: 60, control: { enabled: true } });
    set(field('Objetivo mínimo'), '10');
    expect(JSON.parse(json()).control).toEqual({ enabled: true, minTarget: 10 });
  });

  it('una bomba no muestra el control de llenado', () => {
    open(a('pump-01', 'pump', 'PMP-101'));
    expect(q('[data-testid="control-fields"]')).toBeNull();
  });
});
