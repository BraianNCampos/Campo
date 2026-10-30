import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@campo/shared';
import { AdminApiError, ModelInUseError } from './errors';
import { HttpAdminApi, type XhrLike } from './http-api';

const UUID = '3f2b8c1e-0a4d-4e6f-9b1a-2c3d4e5f6a7b';
const info: ModelInfo = { id: UUID, plant: 'demo', name: 'Tanque', size: 2940, sha256: 'a'.repeat(64), createdAt: 1_700_000_000_000 };

class FakeXhr implements XhrLike {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sent: Blob | null = null;
  aborted = false;
  upload: XhrLike['upload'] = { onprogress: null };
  onload: XhrLike['onload'] = null;
  onerror: XhrLike['onerror'] = null;
  onabort: XhrLike['onabort'] = null;
  ontimeout: XhrLike['ontimeout'] = null;
  status = 0;
  responseText = '';
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(b: Blob) {
    this.sent = b;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

function make(opts: { token?: string | null; fetch?: typeof fetch } = {}) {
  const onUnauthorized = vi.fn();
  const api = new HttpAdminApi({ baseUrl: 'https://api.test', getToken: () => (opts.token === undefined ? 'tok' : opts.token), onUnauthorized, xhr: () => new FakeXhr(), fetch: opts.fetch });
  return { api, onUnauthorized };
}
const file = (n = 100) => new Blob([new Uint8Array(n)]);

describe('HttpAdminApi: subida de modelos (XHR)', () => {
  it('POST crudo model/gltf-binary con Bearer y ?name codificado; 201 → created', async () => {
    const { api } = make();
    const progress = vi.fn();
    const p = api.uploadModel('pl/x', file(1000), 'Mi tanque & bomba', { onProgress: progress });
    const x = FakeXhr.last;
    expect(x.method).toBe('POST');
    expect(x.url).toBe('https://api.test/api/plants/pl%2Fx/models?name=Mi%20tanque%20%26%20bomba');
    expect(x.headers['content-type']).toBe('model/gltf-binary');
    expect(x.headers.authorization).toBe('Bearer tok');
    expect(x.sent?.size).toBe(1000);
    x.upload.onprogress?.({ lengthComputable: true, loaded: 250, total: 1000 });
    x.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 }); // se ignora
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(250, 1000);
    x.respond(201, info);
    await expect(p).resolves.toEqual({ model: info, created: true });
    expect(progress).toHaveBeenLastCalledWith(1000, 1000);
  });

  it('200 = ya existía (misma sha256) → created=false', async () => {
    const { api } = make();
    const p = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(200, info);
    expect((await p).created).toBe(false);
  });

  it('sin token no manda Authorization', async () => {
    const { api } = make({ token: null });
    const p = api.uploadModel('demo', file(), 'x');
    expect(FakeXhr.last.headers.authorization).toBeUndefined();
    FakeXhr.last.respond(201, info);
    await p;
  });

  it('400 con el mensaje de la API en español', async () => {
    const { api } = make();
    const p = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(400, { statusCode: 400, message: 'El archivo no es un GLB válido: falta el bloque JSON', error: 'Bad Request' });
    const e = (await p.catch((x: unknown) => x)) as AdminApiError;
    expect(e).toBeInstanceOf(AdminApiError);
    expect(e.kind).toBe('validation');
    expect(e.message).toContain('GLB válido');
  });

  it('400 sin texto propio → mensaje contextual (nunca "Bad Request")', async () => {
    const { api } = make();
    const p = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(400, { statusCode: 400, message: 'Bad Request' });
    expect(((await p.catch((x: unknown) => x)) as AdminApiError).message).toMatch(/no es un GLB válido/);
  });

  it('413 → "supera el tamaño máximo"', async () => {
    const { api } = make();
    const p = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(413, '<html>Payload Too Large</html>');
    const e = (await p.catch((x: unknown) => x)) as AdminApiError;
    expect(e.kind).toBe('too_large');
    expect(e.message).toMatch(/tamaño máximo/);
    expect(e.message).toMatch(/10 MB/);
  });

  it('401 llama a onUnauthorized; 403 es "sin permisos"', async () => {
    const { api, onUnauthorized } = make();
    const p = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(401, { message: 'Unauthorized' });
    expect(((await p.catch((x: unknown) => x)) as AdminApiError).kind).toBe('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const q = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(403, { message: 'Forbidden resource' });
    expect(((await q.catch((x: unknown) => x)) as AdminApiError).message).toMatch(/permisos/);
  });

  it('error de red, respuesta ilegible y cancelación', async () => {
    const { api } = make();
    const a = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.onerror?.();
    expect(((await a.catch((x: unknown) => x)) as AdminApiError).kind).toBe('network');

    const b = api.uploadModel('demo', file(), 'x');
    FakeXhr.last.respond(201, 'no es json');
    expect(((await b.catch((x: unknown) => x)) as AdminApiError).kind).toBe('server');

    const ctl = new AbortController();
    const c = api.uploadModel('demo', file(), 'x', { signal: ctl.signal });
    ctl.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    await expect(c).rejects.toThrow(/cancelada/);
  });
});

describe('HttpAdminApi: listar, borrar y descargar modelos', () => {
  it('listModels y deleteModel usan las rutas del contrato', async () => {
    const calls: { url: string; method?: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method });
      return init.method === 'DELETE' ? new Response('', { status: 200 }) : new Response(JSON.stringify([info]), { status: 200 });
    }) as unknown as typeof fetch;
    const { api } = make({ fetch: f });
    expect(await api.listModels('demo')).toEqual([info]);
    await api.deleteModel('demo', UUID);
    expect(calls).toEqual([
      { url: 'https://api.test/api/plants/demo/models', method: 'GET' },
      { url: `https://api.test/api/plants/demo/models/${UUID}`, method: 'DELETE' },
    ]);
  });

  it('409 al borrar: lista de activos (varias formas de cuerpo) en ModelInUseError', async () => {
    for (const body of [{ assets: ['tk-01', 'tk-02'] }, { usedBy: [{ id: 'tk-01' }, { id: 'tk-02' }] }, { assetIds: ['tk-01', 'tk-02'] }]) {
      const f = (async () => new Response(JSON.stringify({ statusCode: 409, message: 'In use', ...body }), { status: 409 })) as unknown as typeof fetch;
      const e = (await make({ fetch: f }).api.deleteModel('demo', UUID).catch((x: unknown) => x)) as ModelInUseError;
      expect(e).toBeInstanceOf(ModelInUseError);
      expect(e.assets).toEqual(['tk-01', 'tk-02']);
      expect(e.message).toContain('tk-01, tk-02');
      expect(e.kind).toBe('conflict');
    }
  });

  it('409 sin lista reconocible → mensaje genérico en español', async () => {
    const f = (async () => new Response('{"message":"Conflict"}', { status: 409 })) as unknown as typeof fetch;
    const e = (await make({ fetch: f }).api.deleteModel('demo', UUID).catch((x: unknown) => x)) as ModelInUseError;
    expect(e.assets).toEqual([]);
    expect(e.message).toMatch(/en uso/);
  });

  it('downloadModel: GET con Bearer y devuelve el binario', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
    }) as unknown as typeof fetch;
    const buf = await make({ fetch: f }).api.downloadModel(UUID);
    expect(new Uint8Array(buf)).toEqual(bytes);
    expect(seen!.url).toBe(`https://api.test/api/models/${UUID}`);
    expect(seen!.headers.authorization).toBe('Bearer tok');
  });

  it('downloadModel: 401 → onUnauthorized; 403 y red → AdminApiError en español', async () => {
    const mk = (res: () => Response | Error) =>
      make({ fetch: (async () => { const r = res(); if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch });
    const a = mk(() => new Response('{"message":"Unauthorized"}', { status: 401 }));
    expect(((await a.api.downloadModel(UUID).catch((x: unknown) => x)) as AdminApiError).kind).toBe('unauthorized');
    expect(a.onUnauthorized).toHaveBeenCalledTimes(1);
    const b = mk(() => new Response('{"message":"Forbidden resource"}', { status: 403 }));
    expect(((await b.api.downloadModel(UUID).catch((x: unknown) => x)) as AdminApiError).message).toMatch(/permisos/);
    const c = mk(() => new TypeError('Failed to fetch'));
    expect(((await c.api.downloadModel(UUID).catch((x: unknown) => x)) as AdminApiError).kind).toBe('network');
  });
});
