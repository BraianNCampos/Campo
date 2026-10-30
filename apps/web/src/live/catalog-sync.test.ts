import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { CATALOG_DEBOUNCE_MS, createCatalogSync } from './catalog-sync';

const list = (n: number): AssetDef[] => Array.from({ length: n }, (_, i) => ({ plant: 'p', id: `a${i}`, name: 'A', type: 'tank', model3dRef: null, metadata: {} }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(load = vi.fn(async () => list(1)), extra: Partial<Parameters<typeof createCatalogSync>[0]> = {}) {
  const onLoaded = vi.fn();
  const onError = vi.fn();
  const sync = createCatalogSync({ load, onLoaded, onError, ...extra });
  return { sync, load, onLoaded, onError };
}

describe('createCatalogSync', () => {
  it('refresh carga ya', async () => {
    const { sync, load, onLoaded } = setup();
    sync.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(list(1));
  });

  it('schedule agrupa ráfagas: una sola petición ~300 ms después del último aviso', async () => {
    const { sync, load } = setup();
    sync.schedule();
    await vi.advanceTimersByTimeAsync(200);
    sync.schedule();
    await vi.advanceTimersByTimeAsync(200);
    sync.schedule();
    await vi.advanceTimersByTimeAsync(CATALOG_DEBOUNCE_MS - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('un aviso durante una petición en vuelo provoca otra al terminar (sin solapar)', async () => {
    let release!: (l: AssetDef[]) => void;
    const load = vi.fn<() => Promise<AssetDef[]>>(() => new Promise((r) => (release = r)));
    const { sync, onLoaded } = setup(load);
    sync.refresh();
    sync.refresh();
    sync.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    release(list(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    release(list(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoaded.mock.calls.map((c) => (c[0] as AssetDef[]).length)).toEqual([1, 2]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('si falla conserva lo anterior (no llama a onLoaded), avisa y reintenta con espera creciente', async () => {
    const load = vi.fn<() => Promise<AssetDef[]>>().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValue(list(3));
    const { sync, onLoaded, onError } = setup(load, { retryDelayMs: (n) => 1000 * n });
    sync.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onLoaded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it('shouldRetry=false (403/404) no reintenta', async () => {
    const { sync, load, onError } = setup(vi.fn().mockRejectedValue(new Error('403')), { shouldRetry: () => false });
    sync.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('dispose cancela temporizadores y descarta resultados tardíos', async () => {
    let release!: (l: AssetDef[]) => void;
    const { sync, load, onLoaded } = setup(vi.fn(() => new Promise<AssetDef[]>((r) => (release = r))));
    sync.refresh();
    sync.dispose();
    release(list(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoaded).not.toHaveBeenCalled();
    sync.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
