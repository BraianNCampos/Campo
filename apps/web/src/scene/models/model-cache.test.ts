// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { LoadedModel } from './glb';
import { ModelCache } from './model-cache';

const fakeModel = (tag: string): LoadedModel => ({ scene: Object.assign(new THREE.Group(), { name: tag }), size: new THREE.Vector3(1, 1, 1), center: new THREE.Vector3(), minY: 0, vertices: 3 });
const bytes = (n = 8) => new ArrayBuffer(n);

function setup(over: Partial<ConstructorParameters<typeof ModelCache>[0]> = {}) {
  const fetchBytes = vi.fn<(id: string) => Promise<ArrayBuffer>>(async () => bytes());
  const parse = vi.fn<(b: ArrayBuffer) => Promise<LoadedModel>>(async () => fakeModel('m'));
  const dispose = vi.fn();
  const cache = new ModelCache({ fetchBytes, parse, dispose, graceMs: 1000, ...over });
  return { cache, fetchBytes, parse, dispose };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ModelCache', () => {
  it('descarga y analiza una vez por id; varios usos comparten el mismo modelo', async () => {
    const { cache, fetchBytes, parse } = setup();
    const a = cache.acquire('m1');
    const b = cache.acquire('m1');
    const [ma, mb] = await Promise.all([a.promise, b.promise]);
    expect(ma).toBe(mb);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    // ya cargado: otro uso no vuelve a pedir
    await cache.acquire('m1').promise;
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it('deduplica peticiones en vuelo aunque lleguen antes de terminar la descarga', async () => {
    let resolve!: (b: ArrayBuffer) => void;
    const { cache, fetchBytes } = setup({ fetchBytes: vi.fn(() => new Promise<ArrayBuffer>((r) => (resolve = r))) });
    const p = [cache.acquire('x'), cache.acquire('x'), cache.acquire('x')].map((l) => l.promise);
    resolve(bytes());
    const models = await Promise.all(p);
    expect(new Set(models).size).toBe(1);
    void fetchBytes;
  });

  it('ids distintos → cargas distintas', async () => {
    const { cache, fetchBytes } = setup();
    await Promise.all([cache.acquire('a').promise, cache.acquire('b').promise]);
    expect(fetchBytes.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
  });

  it('los errores se propagan a todos los usos y no se cachean (el siguiente intento reintenta)', async () => {
    const fetchBytes = vi.fn<(id: string) => Promise<ArrayBuffer>>().mockRejectedValueOnce(new Error('403')).mockResolvedValue(bytes());
    const { cache, parse } = setup({ fetchBytes });
    const a = cache.acquire('m');
    const b = cache.acquire('m');
    await expect(a.promise).rejects.toThrow('403');
    await expect(b.promise).rejects.toThrow('403');
    expect(cache.size).toBe(0);
    await expect(cache.acquire('m').promise).resolves.toBeDefined();
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('un GLB que no se puede analizar también es un error recuperable', async () => {
    const { cache } = setup({ parse: vi.fn(async () => { throw new Error('GLB roto'); }) });
    await expect(cache.acquire('m').promise).rejects.toThrow('GLB roto');
    expect(cache.size).toBe(0);
  });

  it('libera (dispose) cuando el último uso se suelta, tras el periodo de gracia', async () => {
    const { cache, dispose } = setup();
    const a = cache.acquire('m');
    const b = cache.acquire('m');
    const model = await a.promise;
    a.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(dispose).not.toHaveBeenCalled(); // b sigue usándolo
    b.release();
    b.release(); // idempotente
    await vi.advanceTimersByTimeAsync(999);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(model);
    expect(cache.size).toBe(0);
  });

  it('volver a pedirlo durante la gracia cancela la liberación (remontaje / StrictMode)', async () => {
    const { cache, dispose, fetchBytes } = setup();
    const a = cache.acquire('m');
    await a.promise;
    a.release();
    await vi.advanceTimersByTimeAsync(500);
    const b = cache.acquire('m');
    await vi.advanceTimersByTimeAsync(5000);
    expect(dispose).not.toHaveBeenCalled();
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(await b.promise).toBeDefined();
  });

  it('soltar mientras carga cancela: el modelo que llega tarde se libera y no queda en la caché', async () => {
    let resolve!: (b: ArrayBuffer) => void;
    const { cache, dispose } = setup({ fetchBytes: vi.fn(() => new Promise<ArrayBuffer>((r) => (resolve = r))) });
    const a = cache.acquire('m');
    a.promise.catch(() => {});
    a.release();
    await vi.advanceTimersByTimeAsync(1000);
    resolve(bytes());
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });

  it('clear() libera todo (cambio de planta)', async () => {
    const { cache, dispose } = setup();
    await Promise.all([cache.acquire('a').promise, cache.acquire('b').promise]);
    cache.clear();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('limita las cargas simultáneas', async () => {
    const resolvers: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const fetchBytes = vi.fn(
      () =>
        new Promise<ArrayBuffer>((r) => {
          active++;
          peak = Math.max(peak, active);
          resolvers.push(() => {
            active--;
            r(bytes());
          });
        }),
    );
    const { cache } = setup({ fetchBytes, maxConcurrent: 2 });
    const all = ['a', 'b', 'c', 'd'].map((id) => cache.acquire(id).promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    while (resolvers.length) {
      resolvers.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(fetchBytes).toHaveBeenCalledTimes(4);
  });
});
