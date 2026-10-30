import { describe, expect, it, vi } from 'vitest';
import { AdminApiError, ModuleDisabledError, OrgNotEmptyError } from './errors';
import { HttpAdminApi } from './http-api';

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function setup(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fakeFetch = (async (url: string, init: Call['init']) => {
    const c = { url, init };
    calls.push(c);
    return respond(c);
  }) as unknown as typeof fetch;
  const api = new HttpAdminApi({ baseUrl: 'https://api.test', getToken: () => 'tok', onUnauthorized, fetch: fakeFetch });
  const sent = () => calls.map((c) => `${c.init.method} ${c.url.replace('https://api.test', '')}`);
  return { api, calls, sent, onUnauthorized };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const org = { id: 'acme', name: 'Acme', modules: ['energy'], active: true, createdAt: 1, plants: 0, users: 0 };

describe('HttpAdminApi: clientes (docs §11.1)', () => {
  it('rutas y cuerpos de /api/orgs', async () => {
    const { api, calls, sent } = setup((c) => (c.init.method === 'GET' && c.url.endsWith('/orgs') ? json([org]) : json(org)));
    expect(await api.listOrgs()).toEqual([org]);
    await api.getOrg('a/b');
    await api.createOrg({ id: 'acme', name: 'Acme', modules: ['energy'] });
    await api.updateOrg('acme', { modules: ['energy', 'gas'], active: false });
    await api.createOrgAdmin('acme', { email: 'a@acme.com', password: 'x'.repeat(12) });
    expect(sent()).toEqual(['GET /api/orgs', 'GET /api/orgs/a%2Fb', 'POST /api/orgs', 'PATCH /api/orgs/acme', 'POST /api/orgs/acme/admins']);
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ id: 'acme', name: 'Acme', modules: ['energy'] });
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({ modules: ['energy', 'gas'], active: false });
    expect(JSON.parse(calls[4]!.init.body as string)).toEqual({ email: 'a@acme.com', password: 'x'.repeat(12) });
  });

  it('DELETE /api/orgs/:id; el 409 se traduce a OrgNotEmptyError con los contadores', async () => {
    const ok = setup(() => new Response(null, { status: 204 }));
    await expect(ok.api.deleteOrg('acme')).resolves.toBeUndefined();
    expect(ok.sent()).toEqual(['DELETE /api/orgs/acme']);
    const { api } = setup(() => json({ statusCode: 409, message: 'Conflict', plants: 2, users: 3 }, 409));
    const e = (await api.deleteOrg('acme').catch((x: unknown) => x)) as OrgNotEmptyError;
    expect(e).toBeInstanceOf(OrgNotEmptyError);
    expect(e.plants).toBe(2);
    expect(e.users).toBe(3);
    expect(e.message).toContain('2 plantas y 3 usuarios');
  });

  it('la lista debe ser una lista', async () => {
    const { api } = setup(() => json({ nope: 1 }));
    await expect(api.listOrgs()).rejects.toBeInstanceOf(AdminApiError);
  });
});

describe('HttpAdminApi: filtros por cliente, límites y errores de módulos', () => {
  it('orgId en plantas, usuarios y auditoría sólo si se indica', async () => {
    const { api, calls } = setup(() => json([]));
    await api.listPlants();
    await api.listPlants({ orgId: 'acme' });
    await api.listUsers({ orgId: 'acme' });
    await api.listAudit({ orgId: 'acme', limit: 10 });
    await api.listAudit({ orgId: '' });
    expect(calls.map((c) => c.url.replace('https://api.test', ''))).toEqual([
      '/api/plants',
      '/api/plants?orgId=acme',
      '/api/users?orgId=acme',
      '/api/audit?limit=10&orgId=acme',
      '/api/audit',
    ]);
  });

  it('crear planta y usuario envían orgId (platform_admin) y no lo envían si no se indica', async () => {
    const { api, calls } = setup(() => json({ id: 'p', name: 'P', assets: 0, orgId: 'acme' }, 201));
    await api.createPlant({ id: 'p', name: 'P', orgId: 'acme' });
    await api.createPlant({ id: 'q', name: 'Q' });
    await api.createUser({ email: 'a@b.co', password: 'x'.repeat(12), role: 'viewer', orgId: 'acme' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ id: 'p', name: 'P', orgId: 'acme' });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ id: 'q', name: 'Q' });
    expect(JSON.parse(calls[2]!.init.body as string).orgId).toBe('acme');
  });

  it('GET /api/plants/:plant/limits', async () => {
    const limits = [{ asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical' }];
    const { api, sent } = setup(() => json(limits));
    expect(await api.listLimits('de mo')).toEqual(limits);
    expect(sent()).toEqual(['GET /api/plants/de%20mo/limits']);
  });

  it('403 module_disabled → ModuleDisabledError (no cierra sesión); el 403 genérico no lo es', async () => {
    const mod = setup(() => json({ statusCode: 403, error: 'module_disabled', module: 'climate' }, 403));
    const e = (await mod.api.createAsset('demo', { id: 'c1', name: 'c', type: 'climate' }).catch((x: unknown) => x)) as ModuleDisabledError;
    expect(e).toBeInstanceOf(ModuleDisabledError);
    expect(e.module).toBe('climate');
    expect(mod.onUnauthorized).not.toHaveBeenCalled();
    const gen = setup(() => json({ statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' }, 403));
    const g = (await gen.api.listAssets('ajena').catch((x: unknown) => x)) as AdminApiError;
    expect(g).not.toBeInstanceOf(ModuleDisabledError);
    expect(g.kind).toBe('forbidden');
  });

  it('me() devuelve el cliente con sus módulos', async () => {
    const me = { id: 'u', email: 'a@b.co', role: 'admin', plants: ['*'], org: { id: 'acme', name: 'Acme', modules: ['tanks'] } };
    const { api } = setup(() => json(me));
    expect((await api.me()).org?.modules).toEqual(['tanks']);
  });
});
