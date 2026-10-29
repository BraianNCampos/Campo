import { beforeEach, describe, expect, it } from 'vitest';
import { MockAdminApi } from '@/lib/admin/mock-api';
import { AdminApiError } from '@/lib/admin/errors';
import type { AdminApi } from '@/lib/admin/types';
import { usePlantStore } from './plant-store';
import { useSessionStore } from './session-store';

beforeEach(() => {
  localStorage.clear();
  useSessionStore.getState().clear();
});

describe('useSessionStore.load', () => {
  it('carga usuario y plantas, y selecciona planta', async () => {
    await useSessionStore.getState().load(new MockAdminApi({ role: 'engineer' }));
    const s = useSessionStore.getState();
    expect(s.status).toBe('ready');
    expect(s.me?.role).toBe('engineer');
    expect(usePlantStore.getState().selected).toBe('demo');
  });

  it('usuario sin plantas: ready con plantas vacías y sin selección', async () => {
    await useSessionStore.getState().load(new MockAdminApi({ role: 'viewer' }));
    expect(useSessionStore.getState().status).toBe('ready');
    expect(usePlantStore.getState().plants).toEqual([]);
    expect(usePlantStore.getState().selected).toBeNull();
  });

  it('error de API → estado error con mensaje legible', async () => {
    const api = { me: () => Promise.reject(new AdminApiError('Error del servidor (500).', 500, 'server')), listPlants: () => Promise.resolve([]) } as unknown as AdminApi;
    await useSessionStore.getState().load(api);
    expect(useSessionStore.getState()).toMatchObject({ status: 'error', error: 'Error del servidor (500).' });
  });

  it('sin red usa la última sesión cacheada (stale)', async () => {
    await useSessionStore.getState().load(new MockAdminApi());
    useSessionStore.setState({ me: null, status: 'idle' });
    usePlantStore.getState().reset();
    const down = { me: () => Promise.reject(new AdminApiError('red', 0, 'network')), listPlants: () => Promise.reject(new AdminApiError('red', 0, 'network')) } as unknown as AdminApi;
    await useSessionStore.getState().load(down);
    expect(useSessionStore.getState()).toMatchObject({ status: 'ready', stale: true });
    expect(useSessionStore.getState().me?.email).toBe('admin@campo.demo');
    expect(usePlantStore.getState().selected).toBe('demo');
  });

  it('clear borra caché, plantas y usuario', async () => {
    await useSessionStore.getState().load(new MockAdminApi());
    useSessionStore.getState().clear();
    expect(localStorage.getItem('campo.session.v1')).toBeNull();
    expect(usePlantStore.getState().plants).toEqual([]);
    expect(useSessionStore.getState().me).toBeNull();
  });

  it('refreshPlants actualiza la lista tras crear una planta', async () => {
    const api = new MockAdminApi();
    await useSessionStore.getState().load(api);
    await api.createPlant({ id: 'norte', name: 'Norte' });
    await useSessionStore.getState().refreshPlants(api);
    expect(usePlantStore.getState().plants.map((p) => p.id)).toEqual(['demo', 'norte']);
    expect(usePlantStore.getState().selected).toBe('demo');
  });
});
