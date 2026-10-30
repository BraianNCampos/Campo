import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDemoOrgId } from './demo-org';
import { withDemoOrg, demoPlants } from './orgs';
import { currentViewAs, switchViewAs, VIEW_AS_OPTIONS } from './view-as';
import type { Me, Plant } from '@campo/shared';

beforeEach(() => localStorage.clear());

const me: Me = { id: 'u', email: 'a@b.c', role: 'operator', plants: ['demo'], org: null };

describe('selector «Ver como»', () => {
  it('ofrece los tres modos', () => {
    expect(VIEW_AS_OPTIONS.map((o) => o.label)).toEqual(['Cliente con todos los módulos', 'Cliente solo tanques', 'Campos Ingeniería (plataforma)']);
  });
  it('por defecto: cliente con todos los módulos', () => {
    expect(currentViewAs()).toBe('campos-demo');
  });
  it.each([
    ['cliente-tanques', 'cliente-tanques'],
    ['platform', null],
    ['campos-demo', 'campos-demo'],
  ] as const)('elegir %s guarda el cliente y recarga el estado', (value, org) => {
    const reload = vi.fn();
    switchViewAs(value, reload);
    expect(getDemoOrgId()).toBe(org);
    expect(currentViewAs()).toBe(value);
    expect(reload).toHaveBeenCalledOnce();
  });
  it('la identidad demo sale del cliente elegido; plataforma es platform_admin sin cliente', () => {
    expect(withDemoOrg(me, 'cliente-tanques').org?.modules).toEqual(['tanks']);
    expect(withDemoOrg(me, 'cliente-tanques').role).toBe('operator'); // el rol demo sigue funcionando
    expect(withDemoOrg(me, 'campos-demo').org?.modules).toHaveLength(7);
    expect(withDemoOrg(me, null)).toMatchObject({ org: null, role: 'platform_admin' });
  });
  it('las plantas demo seleccionables salen del cliente (plataforma ve ambas)', () => {
    const plants: Plant[] = [
      { id: 'demo', name: 'Demo', assets: 20, orgId: 'campos-demo' },
      { id: 'tanques', name: 'Tanques', assets: 2, orgId: 'cliente-tanques' },
    ];
    expect(demoPlants(plants, 'cliente-tanques').map((p) => p.id)).toEqual(['tanques']);
    expect(demoPlants(plants, 'campos-demo').map((p) => p.id)).toEqual(['demo']);
    expect(demoPlants(plants, null).map((p) => p.id)).toEqual(['demo', 'tanques']);
  });
});

describe('componente ViewAsSelect', () => {
  it('cambiar la opción llama a setDemoOrgId y recarga', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
    vi.doMock('@/lib/env', async (orig) => ({ ...(await orig<typeof import('@/lib/env')>()), config: { mock: true, wsUrl: null, apiUrl: '', plant: 'demo' } }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true, configurable: true });
    const { ViewAsSelect } = await import('@/components/ViewAsSelect');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<ViewAsSelect />));
    const select = host.querySelector('select')!;
    expect([...select.options].map((o) => o.text)).toContain('Cliente solo tanques');
    act(() => {
      select.value = 'cliente-tanques';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getDemoOrgId()).toBe('cliente-tanques');
    expect(assign).toHaveBeenCalledWith('/');
    act(() => root.unmount());
    host.remove();
    vi.doUnmock('@/lib/env');
  });
});
