import { describe, expect, it } from 'vitest';
import type { Limit, Role } from '@campo/shared';
import { DEMO_LIMITS } from '@/lib/demo-seed';
import { AdminApiError, ModuleDisabledError, OrgNotEmptyError } from './errors';
import { MockAdminApi } from './mock-api';

const NOW = 1_800_000_000_000;
const make = (role: Role, org: string | null = 'campos-demo') => new MockAdminApi({ role, org, now: () => NOW });
const platform = () => make('platform_admin', null);
const tanques = (role: Role = 'admin') => make(role, 'cliente-tanques');
const err = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as AdminApiError;
const key = (l: Limit) => `${l.asset}|${l.metric}|${l.operator}|${l.threshold}|${l.severity}`;
const pw = 'x'.repeat(12);

describe('MockAdminApi: semilla de clientes', () => {
  it('dos clientes demo con sus módulos, plantas y usuarios', async () => {
    const orgs = await platform().listOrgs();
    expect(orgs.map((o) => o.id).sort()).toEqual(['campos-demo', 'cliente-tanques']);
    const demo = orgs.find((o) => o.id === 'campos-demo')!;
    expect(demo.modules).toHaveLength(7);
    expect(demo).toMatchObject({ active: true, plants: 1, users: 4 });
    expect(orgs.find((o) => o.id === 'cliente-tanques')).toMatchObject({ modules: ['tanks'], plants: 1, users: 4 });
  });

  it('me(): el cliente de la sesión sale de la opción; platform_admin no tiene cliente', async () => {
    expect((await tanques().me()).org).toEqual({ id: 'cliente-tanques', name: 'Cliente Solo Tanques', modules: ['tanks'] });
    const p = await platform().me();
    expect(p).toMatchObject({ role: 'platform_admin', org: null, plants: ['*'] });
  });

  it('las reglas de ejemplo se expanden a los mismos límites que DEMO_LIMITS', async () => {
    for (const [plant, api] of [['demo', make('admin')], ['tanques', tanques()]] as const) {
      const got = (await api.listLimits(plant)).map(key).sort();
      expect(got).toEqual(DEMO_LIMITS[plant]!.map(key).sort());
    }
  });
});

describe('MockAdminApi: gestión de clientes (sólo platform_admin)', () => {
  it('alta con validación, 409 por id repetido, edición de módulos y desactivación', async () => {
    const api = platform();
    const bad = await err(api.createOrg({ id: 'Mal Id', name: ' ', modules: ['nada' as never] }));
    expect(bad.kind).toBe('validation');
    expect(bad.details).toHaveLength(3);
    const o = await api.createOrg({ id: 'solo-energia', name: 'Solo Energía', modules: ['energy'] });
    expect(o).toMatchObject({ id: 'solo-energia', modules: ['energy'], active: true, plants: 0, users: 0 });
    expect((await err(api.createOrg({ id: 'solo-energia', name: 'x', modules: ['energy'] }))).kind).toBe('conflict');
    expect((await api.updateOrg('solo-energia', { modules: ['energy', 'gas'], name: 'Energía y gas' }))).toMatchObject({ modules: ['energy', 'gas'], name: 'Energía y gas' });
    expect((await err(api.updateOrg('solo-energia', { modules: ['raro' as never] }))).kind).toBe('validation');
    expect((await err(api.updateOrg('solo-energia', {}))).kind).toBe('validation');
    expect((await api.updateOrg('solo-energia', { active: false })).active).toBe(false);
    expect((await err(api.getOrg('nada'))).kind).toBe('not_found');
    const audit = await api.listAudit({ orgId: 'solo-energia' });
    expect(audit.map((e) => e.action)).toEqual(['org.update', 'org.update', 'org.create']);
  });

  it('borrar: 409 con lo que bloquea (plantas y usuarios); vacío se borra', async () => {
    const api = platform();
    const e = await err(api.deleteOrg('campos-demo'));
    expect(e).toBeInstanceOf(OrgNotEmptyError);
    expect(e.status).toBe(409);
    expect(e.message).toContain('1 planta y 4 usuarios');
    await api.createOrg({ id: 'temporal', name: 'Temporal', modules: ['tanks'] });
    await api.createOrgAdmin('temporal', { email: 'jefe@temporal.com', password: pw });
    expect((await err(api.deleteOrg('temporal'))).message).toContain('1 usuario');
    const users = await api.listUsers({ orgId: 'temporal' });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: 'admin', email: 'jefe@temporal.com', org: { id: 'temporal' } });
  });

  it('crear administrador del cliente: valida correo y contraseña, 409 por correo repetido, 404 si no hay cliente', async () => {
    const api = platform();
    await api.createOrg({ id: 'nuevo', name: 'Nuevo', modules: ['gas'] });
    const bad = await err(api.createOrgAdmin('nuevo', { email: 'no', password: 'corta' }));
    expect(bad.kind).toBe('validation');
    expect(bad.details.join(' ')).toMatch(/Correo/);
    expect((await err(api.createOrgAdmin('nuevo', { email: 'admin@campo.demo', password: pw }))).kind).toBe('conflict');
    expect((await err(api.createOrgAdmin('nada', { email: 'a@b.co', password: pw }))).kind).toBe('not_found');
  });

  it('un administrador de cliente no ve ni toca clientes (403)', async () => {
    const admin = make('admin');
    expect((await err(admin.listOrgs())).kind).toBe('forbidden');
    expect((await err(admin.getOrg('campos-demo'))).kind).toBe('forbidden');
    expect((await err(admin.createOrg({ id: 'x', name: 'x', modules: ['tanks'] }))).kind).toBe('forbidden');
    expect((await err(admin.updateOrg('campos-demo', { active: false }))).kind).toBe('forbidden');
    expect((await err(admin.deleteOrg('campos-demo'))).kind).toBe('forbidden');
    expect((await err(admin.createOrgAdmin('campos-demo', { email: 'z@z.co', password: pw }))).kind).toBe('forbidden');
  });
});

describe('MockAdminApi: aislamiento entre clientes', () => {
  it('un admin de cliente-tanques sólo ve lo suyo', async () => {
    const api = tanques();
    expect((await api.listPlants()).map((p) => p.id)).toEqual(['tanques']);
    expect((await api.listAssets('tanques')).map((a) => a.id)).toEqual(['tk-a', 'tk-b']);
    expect((await api.listUsers()).every((u) => u.org?.id === 'cliente-tanques')).toBe(true);
    expect((await api.listRules()).every((r) => r.plant === 'tanques')).toBe(true);
    const audit = await api.listAudit({ limit: 200 });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((e) => e.orgId === 'cliente-tanques')).toBe(true);
  });

  it('403 genérico ante recursos de otro cliente', async () => {
    const api = tanques();
    for (const p of [api.listAssets('demo'), api.listModels('demo'), api.listLimits('demo'), api.createAsset('demo', { id: 'x', name: 'x', type: 'tank' }), api.deletePlant('demo'), api.renamePlant('demo', 'x')]) {
      expect((await err(p)).kind).toBe('forbidden');
    }
    expect((await err(api.createRule({ plant: 'demo', asset: '*', metric: 'level', operator: 'gt', threshold: 1, severity: 'warning', forSeconds: 0, hysteresis: 0, enabled: true }))).kind).toBe('forbidden');
    const demoAdmin = (await platform().listUsers({ orgId: 'campos-demo' })).find((u) => u.role === 'admin')!;
    expect((await err(api.updateUser(demoAdmin.id, { active: false }))).kind).toBe('forbidden');
    expect((await err(api.revokeUserSessions(demoAdmin.id))).kind).toBe('forbidden');
    expect((await err(api.setUserPlants(demoAdmin.id, []))).kind).toBe('forbidden');
  });

  it('un admin de cliente ignora el filtro ?orgId= de otro cliente (sólo ve lo suyo)', async () => {
    const api = tanques();
    expect((await api.listUsers({ orgId: 'campos-demo' })).every((u) => u.org?.id === 'cliente-tanques')).toBe(true);
    expect((await api.listPlants({ orgId: 'campos-demo' })).map((p) => p.id)).toEqual(['tanques']);
    const audit = await api.listAudit({ orgId: 'campos-demo', limit: 200 });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((e) => e.orgId === 'cliente-tanques')).toBe(true);
  });

  it('planta ajena o inexistente: el mismo 403 para un admin de cliente (nunca 404); 404 sólo para platform_admin', async () => {
    const api = tanques();
    expect((await err(api.listAssets('demo'))).status).toBe(403);
    expect((await err(api.listAssets('no-existe'))).status).toBe(403);
    expect((await err(api.listLimits('no-existe'))).status).toBe(403);
    expect((await err(platform().listAssets('no-existe'))).status).toBe(404);
  });

  it('recursos con UUID: 404 si no existen, 403 si son de otro cliente', async () => {
    const api = tanques();
    const demoRule = (await platform().listRules()).find((r) => r.plant === 'demo')!;
    expect((await err(api.updateRule(demoRule.id, { enabled: false }))).status).toBe(403); // existe, pero es de otro cliente
    expect((await err(api.deleteRule(demoRule.id))).status).toBe(403);
    expect((await err(api.updateRule('00000000-0000-4000-8000-0000000000ff', { enabled: false }))).status).toBe(404);
    const foreign = (await tanques().listUsers())[0]!;
    expect((await err(make('admin').updateUser(foreign.id, { active: false }))).status).toBe(403);
    expect((await err(api.updateUser('00000000-0000-4000-8000-0000000000ff', { active: false }))).status).toBe(404);
  });

  it('borrar una planta borra también sus reglas; PATCH de usuario con orgId → 400 para un admin', async () => {
    const plat = platform();
    await plat.createPlant({ id: 'nueva', name: 'Nueva', orgId: 'campos-demo' });
    await plat.createRule({ plant: 'nueva', asset: '*', metric: 'level', operator: 'gt', threshold: 1, severity: 'warning', forSeconds: 0, hysteresis: 0, enabled: true });
    await plat.deletePlant('nueva');
    expect((await plat.listRules()).some((r) => r.plant === 'nueva')).toBe(false);
    const api = tanques();
    const op = (await api.listUsers()).find((u) => u.role === 'operator')!;
    expect((await err(api.updateUser(op.id, { orgId: 'campos-demo' } as never))).status).toBe(400);
  });

  it('no puede asignar plantas de otro cliente ni otorgar platform_admin ni crear en otro cliente', async () => {
    const api = tanques();
    const op = (await api.listUsers()).find((u) => u.role === 'operator')!;
    expect((await err(api.setUserPlants(op.id, ['demo']))).kind).toBe('forbidden');
    expect((await err(api.createUser({ email: 'a@b.co', password: pw, role: 'platform_admin' }))).kind).toBe('forbidden');
    expect((await err(api.createUser({ email: 'a@b.co', password: pw, role: 'viewer', orgId: 'campos-demo' }))).kind).toBe('forbidden');
    expect((await err(api.createUser({ email: 'a@b.co', password: pw, role: 'viewer', plants: ['demo'] }))).kind).toBe('forbidden');
    expect((await err(api.updateUser(op.id, { role: 'platform_admin' }))).kind).toBe('forbidden');
    expect((await err(api.createPlant({ id: 'otra', name: 'x', orgId: 'campos-demo' }))).kind).toBe('forbidden');
  });

  it('crea en su propio cliente sin indicarlo, y el platform_admin debe indicarlo (400)', async () => {
    const admin = tanques();
    const p = await admin.createPlant({ id: 'norte', name: 'Norte' });
    expect(p.orgId).toBe('cliente-tanques');
    const u = await admin.createUser({ email: 'nuevo@tanques.demo', password: pw, role: 'viewer', plants: ['norte'] });
    expect(u.org?.id).toBe('cliente-tanques');

    const plat = platform();
    const noOrg = await err(plat.createPlant({ id: 'sur', name: 'Sur' }));
    expect(noOrg.kind).toBe('validation');
    expect(noOrg.fields.orgId).toBeDefined();
    expect((await err(plat.createUser({ email: 'a@b.co', password: pw, role: 'viewer' }))).kind).toBe('validation');
    expect((await err(plat.createPlant({ id: 'sur', name: 'Sur', orgId: 'nada' }))).kind).toBe('not_found');
    expect((await plat.createPlant({ id: 'sur', name: 'Sur', orgId: 'campos-demo' })).orgId).toBe('campos-demo');
    expect((await plat.listPlants({ orgId: 'campos-demo' })).map((x) => x.id)).toEqual(['demo', 'sur']);
    expect((await plat.listPlants()).map((x) => x.id)).toEqual(['demo', 'sur', 'tanques']);
  });

  it('platform_admin ve todo, crea otros platform_admin (sin cliente) y filtra la auditoría por cliente', async () => {
    const plat = platform();
    const staff = await plat.createUser({ email: 'soporte@campos.com', password: pw, role: 'platform_admin' });
    expect(staff).toMatchObject({ role: 'platform_admin', org: null, plants: [] });
    expect((await err(plat.createUser({ email: 'x@campos.com', password: pw, role: 'platform_admin', orgId: 'campos-demo' }))).kind).toBe('validation');
    expect((await plat.listUsers()).length).toBe(10);
    const t = await plat.listAudit({ orgId: 'cliente-tanques', limit: 200 });
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((e) => e.orgId === 'cliente-tanques')).toBe(true);
    expect((await plat.listAudit({ limit: 200 })).some((e) => e.orgId === 'campos-demo')).toBe(true);
  });

  it('el último admin de CADA cliente está protegido (409), no el global', async () => {
    const api = tanques();
    const admin = (await api.listUsers()).find((u) => u.role === 'admin')!;
    expect((await err(api.updateUser(admin.id, { active: false }))).kind).toBe('conflict');
    const plat = platform();
    const demoAdmins = (await plat.listUsers({ orgId: 'campos-demo' })).filter((u) => u.role === 'admin');
    expect(demoAdmins).toHaveLength(1);
    expect((await err(plat.updateUser(demoAdmins[0]!.id, { role: 'viewer' }))).kind).toBe('conflict');
  });
});

describe('MockAdminApi: módulos contratados', () => {
  it('un tipo cuyo módulo no está contratado da 403 module_disabled con el módulo', async () => {
    const api = tanques();
    for (const type of ['climate', 'energy', 'gas', 'machine', 'pressure', 'flow'] as const) {
      const e = await err(api.createAsset('tanques', { id: `x-${type}`, name: 'x', type }));
      expect(e).toBeInstanceOf(ModuleDisabledError);
      expect(e.status).toBe(403);
      expect((e as ModuleDisabledError).module).toBe(type === 'machine' ? 'machines' : type === 'pressure' || type === 'flow' ? 'flow' : type);
    }
    expect(await api.listAssets('tanques')).toHaveLength(2); // no se creó ninguno
  });

  it('los tipos del módulo contratado y los genéricos sí se crean', async () => {
    const api = tanques();
    for (const [id, type] of [['b-1', 'pump'], ['v-1', 'valve'], ['s-1', 'sensor'], ['t-3', 'tank']] as const) {
      await expect(api.createAsset('tanques', { id, name: id, type })).resolves.toMatchObject({ id, type });
    }
  });

  it('cambiar el tipo de un activo a uno no contratado también se rechaza', async () => {
    const api = tanques();
    const e = await err(api.updateAsset('tanques', 'tk-a', { type: 'climate' }));
    expect(e).toBeInstanceOf(ModuleDisabledError);
    expect((await api.updateAsset('tanques', 'tk-a', { name: 'Otro nombre' })).name).toBe('Otro nombre');
  });

  it('el módulo se evalúa con el cliente dueño de la planta; activarlo lo habilita sin borrar nada', async () => {
    const plat = platform();
    expect(await err(plat.createAsset('tanques', { id: 'c-1', name: 'Clima', type: 'climate' }))).toBeInstanceOf(ModuleDisabledError);
    await plat.updateOrg('cliente-tanques', { modules: ['tanks', 'climate'] });
    await expect(plat.createAsset('tanques', { id: 'c-1', name: 'Clima', type: 'climate' })).resolves.toMatchObject({ type: 'climate' });
    await plat.updateOrg('cliente-tanques', { modules: ['tanks'] });
    expect((await plat.listAssets('tanques')).some((a) => a.id === 'c-1')).toBe(true); // desactivar no borra datos
  });

  it('metadatos de dominio: capacityM3, contractedKw y scale se validan', async () => {
    const api = make('admin');
    const bad = await err(api.createAsset('demo', { id: 'en-x', name: 'x', type: 'energy', metadata: { contractedKw: -1, scale: { kw: { min: 5, max: 1 } } } }));
    expect(bad.kind).toBe('validation');
    expect(bad.details.join(' ')).toMatch(/contractedKw/);
    expect(bad.details.join(' ')).toMatch(/scale\.kw/);
    await expect(api.createAsset('demo', { id: 'en-y', name: 'y', type: 'energy', metadata: { contractedKw: 50, scale: { kw: { min: 0, max: 60 } } } })).resolves.toMatchObject({ metadata: { contractedKw: 50 } });
  });
});
