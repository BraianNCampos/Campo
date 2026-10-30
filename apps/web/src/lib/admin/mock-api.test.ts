import { describe, expect, it } from 'vitest';
import type { Role } from '@campo/shared';
import { AdminApiError } from './errors';
import { DEMO_PASSWORD, MockAdminApi } from './mock-api';

const NOW = 1_800_000_000_000;
const make = (role: Role = 'admin') => new MockAdminApi({ role, now: () => NOW });
const err = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as AdminApiError;

describe('MockAdminApi: semilla', () => {
  it('planta demo del cliente campos-demo con sus 20 activos, reglas, usuarios y auditoría', async () => {
    const api = make();
    expect(await api.listPlants()).toEqual([{ id: 'demo', name: 'Planta demo', assets: 20, orgId: 'campos-demo' }]);
    const ids = (await api.listAssets('demo')).map((a) => a.id);
    expect(ids).toHaveLength(20);
    expect(ids).toEqual(expect.arrayContaining(['tk-01', 'pump-02', 'clima-01', 'en-linea1', 'gas-01', 'maq-03', 'pres-01', 'cau-01']));
    expect(await api.listRules()).toHaveLength(15);
    expect((await api.listUsers()).length).toBeGreaterThanOrEqual(2);
    const audit = await api.listAudit();
    expect(audit.length).toBeGreaterThan(8);
    expect(audit[0]!.ts).toBeGreaterThanOrEqual(audit[audit.length - 1]!.ts);
    expect(JSON.stringify(audit)).not.toMatch(/password"?:/i);
  });

  it('me: admin → plants ["*"]; operator → asignadas', async () => {
    expect((await make().me()).plants).toEqual(['*']);
    const op = await make('operator').me();
    expect(op.role).toBe('operator');
    expect(op.plants).toEqual(['demo']);
    expect(op.org).toMatchObject({ id: 'campos-demo', name: 'Agroindustria Ejemplo' });
  });
});

describe('MockAdminApi: plantas y activos', () => {
  it('crear planta: 409 si existe, 400 con id inválido; borrar con activos → 409', async () => {
    const api = make();
    expect((await err(api.createPlant({ id: 'demo', name: 'x' }))).kind).toBe('conflict');
    const bad = await err(api.createPlant({ id: 'Mala Id', name: '' }));
    expect(bad.kind).toBe('validation');
    expect(bad.details.length).toBe(2);
    expect((await err(api.deletePlant('demo'))).kind).toBe('conflict');
    await api.createPlant({ id: 'norte', name: 'Norte' });
    await api.deletePlant('norte');
    expect((await err(api.deletePlant('norte'))).kind).toBe('forbidden');
  });

  it('activos: alta, 409 duplicado, edición sin cambiar id, borrado con affectedRules', async () => {
    const api = make();
    await api.createAsset('demo', { id: 'tk-05', name: 'T5', type: 'tank', metadata: { a: 1 } });
    expect((await err(api.createAsset('demo', { id: 'tk-05', name: 'T5', type: 'tank' }))).kind).toBe('conflict');
    const up = await api.updateAsset('demo', 'tk-05', { name: 'Nuevo' });
    expect(up).toMatchObject({ id: 'tk-05', name: 'Nuevo', metadata: { a: 1 }, model3dRef: null });
    await api.createRule({ plant: 'demo', asset: 'tk-05', metric: 'level', operator: 'gt', threshold: 1, severity: 'warning', forSeconds: 0, hysteresis: 0, enabled: true });
    expect(await api.deleteAsset('demo', 'tk-05')).toEqual({ affectedRules: 1 });
    expect((await err(api.deleteAsset('demo', 'tk-05'))).kind).toBe('not_found');
    expect((await err(api.createAsset('nada', { id: 'a', name: 'a', type: 'tank' }))).kind).toBe('forbidden'); // un admin de cliente nunca recibe 404 por una planta
  });

  it('403 por rol y por planta', async () => {
    const op = make('operator');
    expect((await err(op.createAsset('demo', { id: 'x', name: 'x', type: 'tank' }))).kind).toBe('forbidden');
    expect((await err(op.createPlant({ id: 'x', name: 'x' }))).kind).toBe('forbidden');
    const eng = make('engineer');
    await eng.createAsset('demo', { id: 'x1', name: 'x', type: 'tank' });
    expect((await err(eng.createPlant({ id: 'x', name: 'x' }))).kind).toBe('forbidden');
    const admin = make();
    await admin.createPlant({ id: 'otra', name: 'Otra' });
    expect((await eng.listPlants()).map((p) => p.id)).toEqual(['demo']);
  });
});

describe('MockAdminApi: usuarios', () => {
  it('alta con validaciones del servidor y 409 por email repetido', async () => {
    const api = make();
    const bad = await err(api.createUser({ email: 'no', password: 'corta', role: 'x' as Role }));
    expect(bad.kind).toBe('validation');
    expect(bad.details.join(' ')).toMatch(/Correo/);
    expect(bad.details.join(' ')).toMatch(/Contraseña debe tener al menos 12/);
    const u = await api.createUser({ email: 'Nuevo@Campo.demo ', password: 'x'.repeat(12), role: 'viewer', plants: ['demo', 'demo'] });
    expect(u).toMatchObject({ email: 'nuevo@campo.demo', plants: ['demo'], active: true });
    expect('password' in u).toBe(false);
    expect((await err(api.createUser({ email: 'nuevo@campo.demo', password: 'x'.repeat(12), role: 'viewer' }))).kind).toBe('conflict');
  });

  it('no se puede desactivar ni degradar al último admin activo (409)', async () => {
    const api = make();
    const admin = (await api.listUsers()).find((u) => u.role === 'admin')!;
    const e1 = await err(api.updateUser(admin.id, { active: false }));
    expect(e1.kind).toBe('conflict');
    expect(e1.message).toMatch(/último admin/);
    expect((await err(api.updateUser(admin.id, { role: 'viewer' }))).kind).toBe('conflict');
    const second = await api.createUser({ email: 'dos@campo.demo', password: 'x'.repeat(12), role: 'admin' });
    await expect(api.updateUser(second.id, { role: 'engineer' })).resolves.toMatchObject({ role: 'engineer' }); // hay otro admin
    expect((await err(api.updateUser(admin.id, { active: false }))).kind).toBe('conflict'); // ya es el último
  });

  it('PATCH vacío → 400; id desconocido → 404; asignar plantas y revocar devuelven el usuario', async () => {
    const api = make();
    const u = (await api.listUsers())[1]!;
    expect((await err(api.updateUser(u.id, {}))).kind).toBe('validation');
    expect((await err(api.updateUser('zzz', { active: true }))).kind).toBe('not_found');
    expect((await api.setUserPlants(u.id, [])).plants).toEqual([]);
    expect((await api.revokeUserSessions(u.id)).id).toBe(u.id);
    expect((await err(api.setUserPlants(u.id, ['Mal Id']))).kind).toBe('validation');
  });

  it('sólo admin gestiona usuarios y ve auditoría', async () => {
    const eng = make('engineer');
    expect((await err(eng.listUsers())).kind).toBe('forbidden');
    expect((await err(eng.listAudit())).kind).toBe('forbidden');
  });
});

describe('MockAdminApi: reglas', () => {
  const base = { plant: 'demo', asset: 'tk-*', metric: 'level', operator: 'gt', threshold: 80, severity: 'warning', forSeconds: 0, hysteresis: 0, enabled: true } as const;

  it('CRUD y validación estilo class-validator', async () => {
    const api = make();
    const r = await api.createRule({ ...base });
    expect(await api.updateRule(r.id, { enabled: false })).toMatchObject({ enabled: false, threshold: 80 });
    const bad = await err(api.createRule({ ...base, asset: 'TK 1', threshold: Number.NaN, forSeconds: 90_000 }));
    expect(bad.kind).toBe('validation');
    expect(bad.details.length).toBe(3);
    await api.deleteRule(r.id);
    expect((await err(api.deleteRule(r.id))).kind).toBe('not_found');
  });

  it('403 si la planta no es del usuario', async () => {
    const eng = make('engineer');
    expect((await err(eng.createRule({ ...base, plant: 'ajena' }))).kind).toBe('forbidden');
    expect((await err(make('viewer').listRules())).kind).toBe('forbidden');
  });
});

describe('MockAdminApi: contraseña y auditoría', () => {
  it('cambia la contraseña: 400 si la actual no coincide, token nuevo si va bien', async () => {
    const api = make();
    const bad = await err(api.changePassword({ currentPassword: 'mala', newPassword: 'n'.repeat(12) }));
    expect(bad.kind).toBe('validation');
    expect(bad.message).toBe('La contraseña actual no es correcta');
    expect((await err(api.changePassword({ currentPassword: DEMO_PASSWORD, newPassword: DEMO_PASSWORD }))).message).toMatch(/distinta/);
    const ok = await api.changePassword({ currentPassword: DEMO_PASSWORD, newPassword: 'n'.repeat(12) });
    expect(ok.accessToken).toMatch(/^mock-token/);
    expect((await err(api.changePassword({ currentPassword: DEMO_PASSWORD, newPassword: 'o'.repeat(12) }))).kind).toBe('validation');
  });

  it('las mutaciones quedan en la auditoría con actor, acción y objetivo', async () => {
    const api = make();
    await api.createPlant({ id: 'p1', name: 'P1' });
    await api.changePassword({ currentPassword: DEMO_PASSWORD, newPassword: 'n'.repeat(12) });
    const [last, prev] = await api.listAudit();
    expect(last).toMatchObject({ action: 'me.password', actorEmail: 'admin@campo.demo' });
    expect(prev).toMatchObject({ action: 'plant.create', target: 'plant:p1' });
    expect(JSON.stringify(last)).not.toContain('nnnn');
  });

  it('paginación por before, filtros por actor y acción', async () => {
    const api = make();
    for (let i = 0; i < 5; i++) await api.createPlant({ id: `p${i}`, name: 'x' });
    const p1 = await api.listAudit({ limit: 4 });
    expect(p1).toHaveLength(4);
    const p2 = await api.listAudit({ limit: 4, before: p1[3]!.id });
    expect(Number(p2[0]!.id)).toBeLessThan(Number(p1[3]!.id));
    expect(new Set([...p1, ...p2].map((e) => e.id)).size).toBe(8);
    const plants = await api.listAudit({ action: 'plant.', limit: 200 });
    expect(plants.every((e) => e.action.startsWith('plant.'))).toBe(true);
    expect((await api.listAudit({ actor: 'operador@', limit: 200 })).every((e) => e.actorEmail?.startsWith('operador@'))).toBe(true);
    expect(await api.listAudit({ actor: 'nadie' })).toEqual([]);
  });
});
