import { describe, expect, it, vi } from 'vitest';
import { AdminApiError } from './errors';
import { HttpAdminApi } from './http-api';

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function setup(respond: (c: Call) => Response | Promise<Response> | Error, token: string | null = 'tok') {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fakeFetch = (async (url: string, init: Call['init']) => {
    const c = { url, init };
    calls.push(c);
    const r = await respond(c);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const api = new HttpAdminApi({ baseUrl: 'https://api.test', getToken: () => token, onUnauthorized, fetch: fakeFetch });
  return { api, calls, onUnauthorized };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpAdminApi', () => {
  it('envía Bearer, JSON y la ruta con prefijo /api', async () => {
    const { api, calls } = setup(() => json({ id: 'p1', name: 'P', assets: 0 }, 201));
    await api.createPlant({ id: 'p1', name: 'P' });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.test/api/plants');
    expect(c.init.method).toBe('POST');
    expect(c.init.headers.authorization).toBe('Bearer tok');
    expect(c.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(c.init.body as string)).toEqual({ id: 'p1', name: 'P' });
  });

  it('sin token no manda Authorization; GET sin content-type', async () => {
    const { api, calls } = setup(() => json([]), null);
    await api.listPlants();
    expect(calls[0]!.init.headers.authorization).toBeUndefined();
    expect(calls[0]!.init.headers['content-type']).toBeUndefined();
  });

  it('codifica ids en la ruta', async () => {
    const { api, calls } = setup(() => json({ affectedRules: 2 }));
    const r = await api.deleteAsset('pl/x', 'a b');
    expect(calls[0]!.url).toBe('https://api.test/api/plants/pl%2Fx/assets/a%20b');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(r).toEqual({ affectedRules: 2 });
  });

  it('DELETE con 204 o sin affectedRules → 0', async () => {
    const { api } = setup(() => new Response(null, { status: 204 }));
    expect(await api.deleteAsset('p', 'a')).toEqual({ affectedRules: 0 });
    await expect(api.deleteRule('x')).resolves.toBeUndefined();
    await expect(api.deletePlant('p')).resolves.toBeUndefined();
  });

  it('endpoints de usuarios y contraseña', async () => {
    const { api, calls } = setup((c) => (c.url.endsWith('/me/password') ? json({ accessToken: 'new' }) : json({ id: 'u', email: 'a@b.c', role: 'viewer', active: true, plants: [] })));
    await api.setUserPlants('u', ['demo']);
    await api.revokeUserSessions('u');
    await api.updateUser('u', { active: false });
    expect(await api.changePassword({ currentPassword: 'a', newPassword: 'b'.repeat(12) })).toEqual({ accessToken: 'new' });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.test', '')}`)).toEqual([
      'PUT /api/users/u/plants',
      'POST /api/users/u/revoke',
      'PATCH /api/users/u',
      'POST /api/me/password',
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ plants: ['demo'] });
  });

  it('auditoría: parámetros de paginación y filtros; omite los vacíos', async () => {
    const { api, calls } = setup(() => json([]));
    await api.listAudit({ limit: 50, before: '120', actor: 'a@b.c', action: '' });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/audit');
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: '50', before: '120', actor: 'a@b.c' });
    await api.listAudit();
    expect(calls[1]!.url).toBe('https://api.test/api/audit');
  });

  it('400 de class-validator → lista legible', async () => {
    const { api } = setup(() => json({ statusCode: 400, message: ['email must be an email', 'role must be one of the following values: admin'], error: 'Bad Request' }, 400));
    const e = await api.createUser({ email: 'x', password: 'y', role: 'admin' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AdminApiError);
    expect((e as AdminApiError).kind).toBe('validation');
    expect((e as AdminApiError).details).toHaveLength(2);
    expect((e as AdminApiError).details[0]).toContain('Correo');
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [500, 'server'],
  ] as const)('%i → kind %s sin llamar a onUnauthorized', async (status, kind) => {
    const { api, onUnauthorized } = setup(() => json({ message: 'x' }, status));
    const e = (await api.listUsers().catch((x: unknown) => x)) as AdminApiError;
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('401 → onUnauthorized (cerrar sesión) y error unauthorized', async () => {
    const { api, onUnauthorized } = setup(() => json({ message: 'Unauthorized' }, 401));
    const e = (await api.me().catch((x: unknown) => x)) as AdminApiError;
    expect(e.kind).toBe('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('red caída → error de red legible', async () => {
    const { api } = setup(() => new TypeError('Failed to fetch'));
    const e = (await api.listPlants().catch((x: unknown) => x)) as AdminApiError;
    expect(e.kind).toBe('network');
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/No se pudo contactar/);
  });

  it('respuestas inesperadas (HTML, no lista) no se muestran: error genérico', async () => {
    const html = setup(() => new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    await expect(html.api.listPlants()).rejects.toMatchObject({ message: 'Respuesta inesperada del servidor.' });
    const notList = setup(() => json({ nope: true }));
    await expect(notList.api.listRules()).rejects.toBeInstanceOf(AdminApiError);
    const proxy = setup(() => new Response('<html>Bad gateway: stack...</html>', { status: 502 }));
    const e = (await proxy.api.listUsers().catch((x: unknown) => x)) as AdminApiError;
    expect(e.message).not.toContain('html');
  });

  it('changePassword exige accessToken en la respuesta', async () => {
    const { api } = setup(() => json({}));
    await expect(api.changePassword({ currentPassword: 'a', newPassword: 'b' })).rejects.toBeInstanceOf(AdminApiError);
  });
});
