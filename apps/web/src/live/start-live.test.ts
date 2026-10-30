import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAdminApi } from '@/lib/admin/mock-api';
import { setAdminApi } from '@/lib/admin';
import { clearHistory, readSeries } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import type { WsLike } from './ws-client';

const cfg = vi.hoisted(() => ({ mock: false, wsUrl: 'ws://test/ws' as string | null, apiUrl: '', plant: 'demo' }));
vi.mock('@/lib/env', async (orig) => ({ ...(await orig<typeof import('@/lib/env')>()), config: cfg }));

import { startLive } from './start-live';

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  close() {
    this.closed = true;
  }
  send(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}
const factory = (url: string) => new FakeWs(url);
const snap = (plant: string, asset: string, level: number) => ({ type: 'snapshot', plant, assets: { [asset]: { ts: 1000, quality: 'good', values: { level } } } });

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.all = [];
  cfg.mock = false;
  localStorage.clear();
  localStorage.setItem('campo.token', 'tok');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  useLiveStore.getState().reset();
  useUiStore.getState().select(null);
  clearHistory();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startLive: cambio de planta', () => {
  it('conecta el WebSocket a la planta indicada', () => {
    const stop = startLive('norte', { createSocket: factory });
    expect(FakeWs.all).toHaveLength(1);
    const u = new URL(FakeWs.all[0]!.url);
    expect(u.searchParams.get('plant')).toBe('norte');
    expect(u.searchParams.get('token')).toBe('tok');
    expect(useLiveStore.getState().plant).toBe('norte');
    stop();
  });

  it('al cambiar de planta cierra el socket anterior, reconecta y reinicia el estado vivo', () => {
    const stopA = startLive('demo', { createSocket: factory });
    const a = FakeWs.all[0]!;
    a.send(snap('demo', 'tk-01', 40));
    vi.advanceTimersByTime(300);
    expect(useLiveStore.getState().assetIds).toEqual(['tk-01']);
    expect(readSeries('tk-01', 'level').v).toEqual([40]);
    useUiStore.getState().select('tk-01');

    stopA();
    expect(a.closed).toBe(true);
    const stopB = startLive('norte', { createSocket: factory });
    const b = FakeWs.all[1]!;
    expect(new URL(b.url).searchParams.get('plant')).toBe('norte');
    const s = useLiveStore.getState();
    expect(s.plant).toBe('norte');
    expect(s.assetIds).toEqual([]);
    expect(s.alarms).toEqual({});
    expect(readSeries('tk-01', 'level').v).toEqual([]);
    expect(useUiStore.getState().selectedId).toBeNull();

    b.send(snap('norte', 'tk-91', 10));
    vi.advanceTimersByTime(300);
    expect(useLiveStore.getState().assetIds).toEqual(['tk-91']);
    stopB();
  });

  it('ignora mensajes que llegan de otra planta (socket anterior o servidor confuso)', () => {
    const stop = startLive('norte', { createSocket: factory });
    const ws = FakeWs.all[0]!;
    ws.send(snap('demo', 'tk-01', 1));
    ws.send({ type: 'telemetry', plant: 'demo', asset: 'tk-01', ts: 2000, quality: 'good', values: { level: 2 } });
    vi.advanceTimersByTime(300);
    expect(useLiveStore.getState().assetIds).toEqual([]);
    stop();
  });

  it('tras parar, los mensajes tardíos no tocan el estado de la planta nueva', () => {
    const stopA = startLive('demo', { createSocket: factory });
    const a = FakeWs.all[0]!;
    stopA();
    const stopB = startLive('norte', { createSocket: factory });
    a.send(snap('demo', 'tk-01', 1)); // el handler ya está desenganchado; aun así no debe aplicarse
    vi.advanceTimersByTime(300);
    expect(useLiveStore.getState().assetIds).toEqual([]);
    stopB();
  });

  it('las alarmas activas se piden filtradas por planta', async () => {
    vi.useRealTimers();
    const stop = startLive('norte', { createSocket: factory });
    FakeWs.all[0]!.send(snap('norte', 'tk-91', 1));
    await new Promise((r) => setTimeout(r, 20));
    const url = vi.mocked(fetch).mock.calls.map((c) => String(c[0])).find((u) => u.includes('/api/alarms'))!;
    expect(url).toContain('state=active');
    expect(url).toContain('plant=norte');
    stop();
  });

  it('sin token no abre socket (unauthorized)', () => {
    localStorage.removeItem('campo.token');
    const stop = startLive('demo', { createSocket: factory });
    expect(FakeWs.all).toHaveLength(0);
    expect(useLiveStore.getState().connection).toBe('unauthorized');
    stop();
  });
});

describe('startLive: catálogo vivo', () => {
  const asset = (id: string) => ({ plant: 'demo', id, name: id, type: 'tank', model3dRef: null, metadata: {} });
  let catalog: ReturnType<typeof asset>[];
  const catalogCalls = () => vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes('/api/plants/demo/assets'));

  beforeEach(() => {
    catalog = [asset('tk-01'), asset('nuevo')];
    setAdminApi(null);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/assets') ? catalog : []), { status: 200 })));
  });
  afterEach(() => setAdminApi(null));

  it('al arrancar pide el catálogo de la planta y la lista incluye los activos sin telemetría', async () => {
    const stop = startLive('demo', { createSocket: factory });
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogCalls()).toHaveLength(1);
    FakeWs.all[0]!.send(snap('demo', 'tk-01', 40));
    await vi.advanceTimersByTimeAsync(300);
    const s = useLiveStore.getState();
    expect(s.catalogReady).toBe(true);
    expect(s.assetIds).toEqual(['nuevo', 'tk-01']);
    expect(s.assets.nuevo).toBeUndefined();
    stop();
  });

  it('{type:"catalog"} vuelve a pedir el catálogo con debounce (ráfaga → una petición)', async () => {
    const stop = startLive('demo', { createSocket: factory });
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.all[0]!;
    ws.send(snap('demo', 'tk-01', 1));
    await vi.advanceTimersByTimeAsync(300);
    expect(catalogCalls()).toHaveLength(1);
    catalog = [asset('tk-01'), asset('nuevo'), asset('otro')];
    for (let i = 0; i < 5; i++) {
      ws.send({ type: 'catalog', plant: 'demo' });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(catalogCalls()).toHaveLength(1); // aún dentro de la ventana
    await vi.advanceTimersByTimeAsync(300);
    expect(catalogCalls()).toHaveLength(2);
    expect(useLiveStore.getState().assetIds).toContain('otro');
    stop();
  });

  it('el aviso de otra planta se ignora; tras parar no se pide nada más', async () => {
    const stop = startLive('demo', { createSocket: factory });
    await vi.advanceTimersByTimeAsync(0);
    FakeWs.all[0]!.send({ type: 'catalog', plant: 'norte' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(catalogCalls()).toHaveLength(1);
    FakeWs.all[0]!.send({ type: 'catalog', plant: 'demo' });
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(catalogCalls()).toHaveLength(1);
  });

  it('al reconectar (segundo snapshot) refresca el catálogo; el primero no duplica la carga inicial', async () => {
    const stop = startLive('demo', { createSocket: factory });
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.all[0]!;
    ws.send(snap('demo', 'tk-01', 1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(catalogCalls()).toHaveLength(1);
    ws.send(snap('demo', 'tk-01', 2));
    await vi.advanceTimersByTimeAsync(400);
    expect(catalogCalls()).toHaveLength(2);
    stop();
  });

  it('si el catálogo falla se marca el error y la lista sigue saliendo de la telemetría', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/assets') ? new Response('{}', { status: 500 }) : new Response('[]', { status: 200 }))));
    const stop = startLive('demo', { createSocket: factory });
    await vi.advanceTimersByTimeAsync(0);
    FakeWs.all[0]!.send(snap('demo', 'tk-01', 1));
    await vi.advanceTimersByTimeAsync(300);
    const s = useLiveStore.getState();
    expect(s.catalogError).toBe(true);
    expect(s.catalogReady).toBe(false);
    expect(s.assetIds).toEqual(['tk-01']);
    stop();
  });
});

describe('startLive en modo demo', () => {
  it('demo usa el simulador; otras plantas, los activos del catálogo mock', async () => {
    cfg.mock = true;
    const api = new MockAdminApi({ now: () => 1_700_000_000_000 });
    await api.createPlant({ id: 'norte', name: 'Norte' });
    await api.createAsset('norte', { id: 'tk-91', name: 'T', type: 'tank' });
    await api.createAsset('norte', { id: 'bomba-x', name: 'B', type: 'pump' });
    setAdminApi(api);
    vi.useRealTimers();

    const stopDemo = startLive('demo');
    await new Promise((r) => setTimeout(r, 400));
    expect(useLiveStore.getState().assetIds).toHaveLength(8);
    stopDemo();

    const stopNorte = startLive('norte');
    expect(useLiveStore.getState().assetIds).toEqual([]); // estado reiniciado
    await new Promise((r) => setTimeout(r, 400));
    const s = useLiveStore.getState();
    expect(s.plant).toBe('norte');
    expect(s.mode).toBe('mock');
    expect(s.assetIds).toEqual(['tk-91', 'bomba-x']);
    expect(s.assets['tk-91']?.values.level).toBeTypeOf('number');
    stopNorte();
    setAdminApi(null);
  });
});
