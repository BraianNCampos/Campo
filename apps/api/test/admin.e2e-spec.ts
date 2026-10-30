import type { AddressInfo } from 'node:net';
import { JwtService } from '@nestjs/jwt';
import type {
  AlarmEvent,
  AssetDef,
  AuditEntry,
  LoginResponse,
  ManagedUser,
  Plant,
} from '@campo/shared';
import { MODULE_IDS, redisKeys } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { triangleGlb } from './support/glb';
import { createTestApp, TestApp } from './support/test-app';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condición');
    await sleep(10);
  }
};

interface Socket {
  messages: { type: string }[];
  closed: Promise<number>;
}

function open(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Socket['messages'] = [];
    ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString())));
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('open', () => resolve({ messages, closed }));
    ws.on('error', reject);
  });
}

const ruleBody = (plant: string, asset: string) => ({
  plant,
  asset,
  metric: 'level',
  operator: 'gt',
  threshold: 90,
  severity: 'critical',
});

describe('Administración: plantas, activos, auditoría y revocación (e2e)', () => {
  let t: TestApp;
  let http: App;
  let wsBase: string;
  let admin: string;
  let seq = 0;
  const email = (prefix: string) => `${prefix}-${++seq}@campo.test`;

  beforeAll(async () => {
    t = await createTestApp({ wsRevalidateMs: 100 });
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer() as App;
    wsBase = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/ws`;
    admin = await t.tokenFor('admin');
  });

  afterAll(async () => {
    await t.app.close();
  });

  const api = {
    get: (path: string, token: string) => request(http).get(path).set(bearer(token)),
    put: (path: string, token: string) => request(http).put(path).set(bearer(token)),
    patch: (path: string, token: string) => request(http).patch(path).set(bearer(token)),
    post: (path: string, token: string) => request(http).post(path).set(bearer(token)),
    delete: (path: string, token: string) => request(http).delete(path).set(bearer(token)),
  };

  const auditAll = async (query = 'limit=200'): Promise<AuditEntry[]> =>
    (await api.get(`/api/audit?${query}`, admin).expect(200)).body as AuditEntry[];

  describe('flujo completo', () => {
    let operator: { id: string; email: string; token: string };
    let engineer: { id: string; email: string; token: string };
    const catalogEvents: string[] = [];

    beforeAll(async () => {
      const sub = t.redis.duplicate();
      await sub.subscribe('campo:catalog:changed');
      sub.on('message', (_c: string, m: string) => catalogEvents.push(m));
      operator = await t.makeUser(email('op'), 'operator', []);
      engineer = await t.makeUser(email('ing'), 'engineer', ['demo']);
    });

    it('el admin crea una planta (409 si existe, 400 si es inválida)', async () => {
      const res = await api
        .post('/api/plants', admin)
        .send({ id: 'norte', name: '  Planta Norte ' })
        .expect(201);
      expect(res.body).toEqual({ id: 'norte', name: 'Planta Norte', assets: 0, orgId: 'campos-demo' });
      await api.post('/api/plants', admin).send({ id: 'norte', name: 'Otra' }).expect(409);
      await api.post('/api/plants', admin).send({ id: 'demo', name: 'Demo' }).expect(409); // por tener activos
      await api.post('/api/plants', admin).send({ id: 'BAD_ID', name: 'x' }).expect(400);
      await api.post('/api/plants', admin).send({ id: 'sin-nombre' }).expect(400);
      await api.post('/api/plants', admin).send({ id: 'vacia', name: '   ' }).expect(400);
      await api.post('/api/plants', admin).send({ id: 'extra', name: 'x', foo: 1 }).expect(400);
    });

    // model3dRef ya no admite texto libre (§10.2): un activo referencia un modelo subido a su planta.
    let modelRef = '';

    it('el admin crea activos en la planta nueva; valida y detecta duplicados', async () => {
      const model = await request(http)
        .post('/api/plants/norte/models?name=Tanque')
        .set(bearer(admin))
        .set('Content-Type', 'model/gltf-binary')
        .send(triangleGlb())
        .expect(201);
      modelRef = `model:${(model.body as { id: string }).id}`;
      const created = await api
        .post('/api/plants/norte/assets', admin)
        .send({
          id: 'tk-01',
          name: 'Tanque 1',
          type: 'tank',
          model3dRef: modelRef,
          metadata: { capacityL: 5000 },
        })
        .expect(201);
      const asset = created.body as AssetDef;
      expect(asset).toEqual({
        plant: 'norte',
        id: 'tk-01',
        name: 'Tanque 1',
        type: 'tank',
        model3dRef: modelRef,
        metadata: { capacityL: 5000 },
      });
      // sin modelo ni metadata -> null / {}
      const bare = await api
        .post('/api/plants/norte/assets', admin)
        .send({ id: 'pump-01', name: 'Bomba 1', type: 'pump' })
        .expect(201);
      expect(bare.body).toMatchObject({ model3dRef: null, metadata: {} });

      await api
        .post('/api/plants/norte/assets', admin)
        .send({ id: 'tk-01', name: 'Repetido', type: 'tank' })
        .expect(409);
      const bad = (body: object) => api.post('/api/plants/norte/assets', admin).send(body);
      await bad({ id: 'BAD ID', name: 'x', type: 'tank' }).expect(400);
      await bad({ id: 'a1', name: 'x', type: 'boiler' }).expect(400);
      await bad({ id: 'a1', type: 'tank' }).expect(400);
      await bad({ id: 'a1', name: 'x', type: 'tank', model3dRef: 'm'.repeat(201) }).expect(400);
      await bad({ id: 'a1', name: 'x', type: 'tank', metadata: 'texto' }).expect(400);
      await bad({ id: 'a1', name: 'x', type: 'tank', metadata: [1] }).expect(400);
      await bad({ id: 'a1', name: 'x', type: 'tank', metadata: { blob: 'z'.repeat(9000) } }).expect(
        400,
      );
      await bad({ id: 'a1', name: 'x', type: 'tank', plant: 'demo' }).expect(400);
      // texto libre o modelo inexistente: 400 (ver models.e2e-spec.ts para el detalle)
      await bad({ id: 'a2', name: 'x', type: 'sensor', model3dRef: 'tank' }).expect(400);
      await bad({ id: 'a2', name: 'x', type: 'sensor', model3dRef: null }).expect(201);
      // planta inexistente -> 403 (admin de cliente: no se distingue de la de otro cliente); id inválido -> 400
      await api
        .post('/api/plants/fantasma/assets', admin)
        .send({ id: 'a1', name: 'x', type: 'tank' })
        .expect(403);
      await api
        .post('/api/plants/BAD_PLANT/assets', admin)
        .send({ id: 'a1', name: 'x', type: 'tank' })
        .expect(400);

      // GET mantiene su forma (camelCase model3dRef, igual que AssetDef)
      const list = (await api.get('/api/plants/norte/assets', admin).expect(200))
        .body as AssetDef[];
      expect(list.map((a) => a.id)).toEqual(['tk-01', 'pump-01', 'a2']);
      expect(Object.keys(list[0]).sort()).toEqual(
        ['id', 'metadata', 'model3dRef', 'name', 'plant', 'type'].sort(),
      );
      await api.delete('/api/plants/norte/assets/a2', admin).expect(200);
    });

    it('asigna la planta al operator: la ve en GET /api/plants y no ve las otras', async () => {
      await api
        .put(`/api/users/${operator.id}/plants`, admin)
        .send({ plants: ['norte'] })
        .expect(200);
      const mine = (await api.get('/api/plants', operator.token).expect(200)).body as Plant[];
      expect(mine).toEqual([{ id: 'norte', name: 'Planta Norte', assets: 2, orgId: 'campos-demo' }]);

      const eng = (await api.get('/api/plants', engineer.token).expect(200)).body as Plant[];
      expect(eng).toEqual([{ id: 'demo', name: 'demo', assets: 2, orgId: 'campos-demo' }]);

      // el admin ve todas las de su cliente (las registradas; una planta sólo con telemetría no es de nadie)
      await t.redis.hset(
        redisKeys.state('solo-redis'),
        'x',
        JSON.stringify({ ts: 1, values: {}, quality: 'good' }),
      );
      const all = (await api.get('/api/plants', admin).expect(200)).body as Plant[];
      expect(all).toEqual([
        { id: 'demo', name: 'demo', assets: 2, orgId: 'campos-demo' },
        { id: 'norte', name: 'Planta Norte', assets: 2, orgId: 'campos-demo' },
      ]);
      await request(http).get('/api/plants').expect(401);
    });

    it('operator y viewer reciben 403 al escribir; el operator sigue leyendo', async () => {
      const body = { id: 'tk-09', name: 'x', type: 'tank' };
      await api.post('/api/plants/norte/assets', operator.token).send(body).expect(403);
      await api
        .patch('/api/plants/norte/assets/tk-01', operator.token)
        .send({ name: 'x' })
        .expect(403);
      await api.delete('/api/plants/norte/assets/tk-01', operator.token).expect(403);
      const viewer = await t.makeUser(email('vw'), 'viewer', ['norte']);
      await api.post('/api/plants/norte/assets', viewer.token).send(body).expect(403);
      await api.post('/api/plants', operator.token).send({ id: 'x1', name: 'x' }).expect(403);
      await api.patch('/api/plants/norte', operator.token).send({ name: 'x' }).expect(403);
      await api.delete('/api/plants/norte', operator.token).expect(403);
      await api.get('/api/audit', operator.token).expect(403);
      const read = await api.get('/api/plants/norte/assets', operator.token).expect(200);
      expect(read.body).toHaveLength(2);
    });

    it('el engineer edita activos de su planta pero no de otra', async () => {
      const patched = await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ name: 'Tanque principal', metadata: { unit: '%' }, model3dRef: null })
        .expect(200);
      expect(patched.body).toMatchObject({
        id: 'tk-01',
        name: 'Tanque principal',
        type: 'tank',
        model3dRef: null,
        metadata: { unit: '%' },
      });
      await api.patch('/api/plants/demo/assets/tk-01', engineer.token).send({}).expect(400);
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ id: 'otro' })
        .expect(400);
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ name: null })
        .expect(400);
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ type: 'x' })
        .expect(400);
      await api
        .patch('/api/plants/demo/assets/nope', engineer.token)
        .send({ name: 'x' })
        .expect(404);

      // otra planta: 403 (existan o no)
      await api
        .patch('/api/plants/norte/assets/tk-01', engineer.token)
        .send({ name: 'x' })
        .expect(403);
      await api
        .post('/api/plants/norte/assets', engineer.token)
        .send({ id: 'tk-05', name: 'x', type: 'tank' })
        .expect(403);
      await api.delete('/api/plants/norte/assets/tk-01', engineer.token).expect(403);
      const norte = (await api.get('/api/plants/norte/assets', admin).expect(200))
        .body as AssetDef[];
      expect(norte.find((a) => a.id === 'tk-01')?.name).toBe('Tanque 1');

      // crear en la propia
      await api
        .post('/api/plants/demo/assets', engineer.token)
        .send({ id: 'valve-09', name: 'Válvula', type: 'valve' })
        .expect(201);
    });

    it('borrar un activo informa de las reglas afectadas (exacto o patrón) y no las toca', async () => {
      await api.post('/api/alarm-rules', engineer.token).send(ruleBody('demo', 'tk-*')).expect(201);
      await api
        .post('/api/alarm-rules', engineer.token)
        .send(ruleBody('demo', 'tk-01'))
        .expect(201);
      await api
        .post('/api/alarm-rules', engineer.token)
        .send(ruleBody('demo', 'pump-*'))
        .expect(201);
      await api.post('/api/alarm-rules', admin).send(ruleBody('norte', 'tk-01')).expect(201); // otra planta

      const res = await api.delete('/api/plants/demo/assets/tk-01', engineer.token).expect(200);
      expect(res.body).toEqual({ deleted: true, affectedRules: 2 });
      expect(t.rules.rules.size).toBe(4); // ninguna borrada
      await api.delete('/api/plants/demo/assets/tk-01', engineer.token).expect(404);
    });

    it('cada alta/edición/baja de activos publica campo:catalog:changed {plant}', async () => {
      await until(() => catalogEvents.length >= 6);
      expect(new Set(catalogEvents)).toEqual(
        new Set([JSON.stringify({ plant: 'norte' }), JSON.stringify({ plant: 'demo' })]),
      );
      const before = catalogEvents.length;
      await api
        .patch('/api/plants/demo/assets/pump-01', engineer.token)
        .send({ name: 'B1' })
        .expect(200);
      await until(() => catalogEvents.length === before + 1);
      // los intentos rechazados no publican
      await api.patch('/api/plants/demo/assets/pump-01', engineer.token).send({}).expect(400);
      await sleep(30);
      expect(catalogEvents.length).toBe(before + 1);
    });

    it('PATCH de planta (nombre) y borrado: 409 con activos; limpia asignaciones y cierra su WS', async () => {
      await api.patch('/api/plants/norte', admin).send({ name: 'Norte 2' }).expect(200);
      await api.patch('/api/plants/fantasma', admin).send({ name: 'x' }).expect(403);
      await api.patch('/api/plants/norte', admin).send({ name: '' }).expect(400);
      expect(
        ((await api.get('/api/plants', operator.token).expect(200)).body as Plant[])[0].name,
      ).toBe('Norte 2');

      // con activos -> 409 y no se toca nada
      await api.delete('/api/plants/norte', admin).expect(409);
      expect(
        ((await api.get('/api/users', admin).expect(200)).body as ManagedUser[]).find(
          (u) => u.id === operator.id,
        )?.plants,
      ).toEqual(['norte']);

      const sock = await open(`${wsBase}?plant=norte&token=${operator.token}`);
      await until(() => sock.messages.length > 0);

      await api.delete('/api/plants/norte/assets/tk-01', admin).expect(200);
      await api.delete('/api/plants/norte/assets/pump-01', admin).expect(200);
      await api.delete('/api/plants/norte', admin).expect(200, { deleted: true });

      expect(await sock.closed).toBe(4403);
      expect(
        ((await api.get('/api/users', admin).expect(200)).body as ManagedUser[]).find(
          (u) => u.id === operator.id,
        )?.plants,
      ).toEqual([]);
      expect((await api.get('/api/plants', operator.token).expect(200)).body).toEqual([]);
      await api.delete('/api/plants/norte', admin).expect(403);
      await api.get('/api/plants/norte/assets', admin).expect(403);
    });

    it('la auditoría refleja todo, más reciente primero, sin secretos', async () => {
      const entries = await auditAll();
      const actions = entries.map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'plant.create',
          'plant.update',
          'plant.delete',
          'asset.create',
          'asset.update',
          'asset.delete',
          'rule.create',
          'user.plants',
        ]),
      );
      // orden descendente por id
      const ids = entries.map((e) => Number(e.id));
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
      expect(entries[0]).toMatchObject({ action: 'plant.delete', target: 'plant:norte' });

      const created = entries.find(
        (e) => e.action === 'asset.create' && e.target === 'asset:norte/tk-01',
      );
      expect(created).toMatchObject({
        actorEmail: 'admin@campo.test',
        detail: { name: 'Tanque 1', type: 'tank', model3dRef: modelRef },
      });
      expect(typeof created?.ts).toBe('number');
      // metadata no se audita, sólo que cambió
      const upd = entries.find(
        (e) => e.action === 'asset.update' && e.target === 'asset:demo/tk-01',
      );
      expect(upd?.actorId).toBe(engineer.id);
      expect(upd?.detail).toEqual({
        changed: expect.arrayContaining(['name', 'metadata', 'model3dRef']),
        name: 'Tanque principal',
        model3dRef: null,
      });
      expect(
        entries.find((e) => e.action === 'asset.delete' && e.target === 'asset:demo/tk-01'),
      ).toMatchObject({
        detail: { affectedRules: 2 },
      });
      expect(entries.find((e) => e.action === 'plant.delete')?.detail).toEqual({
        unassignedUsers: 2, // el operator y el viewer de la planta
      });
      expect(JSON.stringify(entries)).not.toMatch(/capacityL|password|\$2[aby]\$|eyJ/);
    });

    it('filtros y paginación de GET /api/audit; límites validados', async () => {
      const onlyAssets = await auditAll('action=asset.create');
      expect(onlyAssets.length).toBeGreaterThanOrEqual(3);
      expect(onlyAssets.every((e) => e.action === 'asset.create')).toBe(true);

      const byEngineer = await auditAll(`actor=${engineer.id}`);
      expect(byEngineer.length).toBeGreaterThan(0);
      expect(byEngineer.every((e) => e.actorId === engineer.id)).toBe(true);
      const byEmail = await auditAll(`actor=${engineer.email.toUpperCase()}`);
      expect(byEmail.map((e) => e.id)).toEqual(byEngineer.map((e) => e.id));

      const page1 = await auditAll('limit=3');
      expect(page1).toHaveLength(3);
      const page2 = await auditAll(`limit=3&before=${page1[2].id}`);
      expect(page2).toHaveLength(3);
      expect(Number(page2[0].id)).toBeLessThan(Number(page1[2].id));

      await api.get('/api/audit?limit=201', admin).expect(400);
      await api.get('/api/audit?limit=0', admin).expect(400);
      await api.get('/api/audit?before=abc', admin).expect(400);
      await api.get('/api/audit?action=DROP%20TABLE', admin).expect(400);
      await api.get('/api/audit?foo=1', admin).expect(400);
      await request(http).get('/api/audit').expect(401);
    });

    it('no hay ni edición ni borrado de auditoría por la API', async () => {
      await api.delete('/api/audit', admin).expect(404);
      await api.delete('/api/audit/1', admin).expect(404);
      await api.post('/api/audit', admin).send({}).expect(404);
      await api.patch('/api/audit/1', admin).send({}).expect(404);
    });
  });

  describe('revocación de tokens y cambio de contraseña', () => {
    const PASSWORD = 'operator-password-123';
    const NEW_PASSWORD = 'nueva-clave-muy-larga';

    it('cambio de contraseña: el token anterior (y su WS) dejan de valer y el nuevo sí', async () => {
      const u = await t.makeUser(email('pw'), 'operator', ['demo']);
      await api.get('/api/me', u.token).expect(200);
      const sock = await open(`${wsBase}?plant=demo&token=${u.token}`);
      await until(() => sock.messages.length > 0);

      // validaciones
      const change = (body: object, token = u.token) =>
        api.post('/api/me/password', token).send(body);
      await change({ currentPassword: 'incorrecta-123456', newPassword: NEW_PASSWORD }).expect(400);
      await change({ currentPassword: PASSWORD, newPassword: 'corta-11-ch' }).expect(400);
      await change({ currentPassword: PASSWORD, newPassword: 'x'.repeat(73) }).expect(400);
      await change({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      await change({ currentPassword: PASSWORD }).expect(400);
      await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, extra: 1 }).expect(400);
      await request(http).post('/api/me/password').send({}).expect(401);
      await api.get('/api/me', u.token).expect(200); // nada de lo anterior revocó el token

      const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(
        200,
      );
      const { accessToken } = res.body as { accessToken: string };
      expect(Object.keys(res.body as object)).toEqual(['accessToken']);

      await api.get('/api/me', u.token).expect(401);
      expect(await sock.closed).toBe(4401);
      expect(await (await open(`${wsBase}?plant=demo&token=${u.token}`)).closed).toBe(4401);
      await api.get('/api/me', accessToken).expect(200);
      expect(t.app.get(JwtService).decode(accessToken)).toMatchObject({ sub: u.id, tv: 1 });

      // la contraseña vieja ya no entra; la nueva sí y emite tv=1
      await request(http)
        .post('/api/auth/login')
        .send({ email: u.email, password: PASSWORD })
        .expect(401);
      const login = await request(http)
        .post('/api/auth/login')
        .send({ email: u.email, password: NEW_PASSWORD })
        .expect(200);
      expect(t.app.get(JwtService).decode((login.body as LoginResponse).accessToken)).toMatchObject(
        {
          tv: 1,
        },
      );
      // el nuevo token sigue funcionando con WS
      const sock2 = await open(`${wsBase}?plant=demo&token=${accessToken}`);
      await until(() => sock2.messages.length > 0);

      const audit = (await auditAll('action=me.password')).find((e) => e.target === `user:${u.id}`);
      expect(audit).toMatchObject({ actorId: u.id, actorEmail: u.email, detail: {} });
    });

    it('un token sin `tv` (anterior al despliegue) vale como versión 0 y se revoca con la primera subida', async () => {
      const u = await t.makeUser(email('legacy'), 'viewer', ['demo']);
      const legacy = await t.app
        .get(JwtService)
        .signAsync({ sub: u.id, email: u.email, role: 'viewer' });
      await api.get('/api/me', legacy).expect(200);
      expect((await open(`${wsBase}?plant=demo&token=${legacy}`)).messages).toBeDefined();

      await api.post(`/api/users/${u.id}/revoke`, admin).expect(200);
      await api.get('/api/me', legacy).expect(401);
      await api.get('/api/me', u.token).expect(401);
      // un `tv` manipulado (futuro o con otro tipo) tampoco vale
      const jwt = t.app.get(JwtService);
      await api
        .get('/api/me', await jwt.signAsync({ sub: u.id, email: u.email, role: 'viewer', tv: 99 }))
        .expect(401);
      await api
        .get('/api/me', await jwt.signAsync({ sub: u.id, email: u.email, role: 'viewer', tv: '1' }))
        .expect(401);
      await api
        .get('/api/me', await jwt.signAsync({ sub: u.id, email: u.email, role: 'viewer', tv: -1 }))
        .expect(401);
    });

    it('POST /api/users/:id/revoke (admin): cierra sesiones y WS; el login sigue funcionando', async () => {
      const u = await t.makeUser(email('rev'), 'engineer', ['demo']);
      const sock = await open(`${wsBase}?plant=demo&token=${u.token}`);
      await until(() => sock.messages.length > 0);

      await api.post(`/api/users/${u.id}/revoke`, u.token).expect(403);
      await api.post('/api/users/no-uuid/revoke', admin).expect(400);
      await api.post('/api/users/00000000-0000-4000-8000-000000000000/revoke', admin).expect(404);
      const res = await api.post(`/api/users/${u.id}/revoke`, admin).expect(200);
      expect(res.body).toEqual({
        id: u.id,
        email: u.email,
        role: 'engineer',
        active: true,
        plants: ['demo'],
        org: { id: 'campos-demo', name: 'Agroindustria Ejemplo', modules: [...MODULE_IDS] },
      });

      await api.get('/api/me', u.token).expect(401);
      expect(await sock.closed).toBe(4401);
      const login = await request(http)
        .post('/api/auth/login')
        .send({ email: u.email, password: 'engineer-password-123' })
        .expect(200);
      await api.get('/api/me', (login.body as LoginResponse).accessToken).expect(200);
      expect(
        (await auditAll('action=user.revoke')).find((e) => e.target === `user:${u.id}`),
      ).toMatchObject({ actorEmail: 'admin@campo.test', detail: {} });
    });

    it('un admin que cambia la contraseña de otro usuario, o lo desactiva, revoca sus tokens', async () => {
      const u = await t.makeUser(email('adm-pw'), 'operator', ['demo']);
      await api
        .patch(`/api/users/${u.id}`, admin)
        .send({ password: 'otra-clave-larga-12' })
        .expect(200);
      await api.get('/api/me', u.token).expect(401);

      const v = await t.makeUser(email('adm-off'), 'operator', ['demo']);
      await api.patch(`/api/users/${v.id}`, admin).send({ role: 'viewer' }).expect(200);
      await api.get('/api/me', v.token).expect(200); // cambiar rol no revoca
      await api.patch(`/api/users/${v.id}`, admin).send({ active: false }).expect(200);
      await api.patch(`/api/users/${v.id}`, admin).send({ active: true }).expect(200);
      await api.get('/api/me', v.token).expect(401); // y reactivar no lo resucita
    });

    it('la auditoría de usuarios no contiene contraseñas, hashes ni tokens', async () => {
      const mail = email('audit-user');
      const created = await api
        .post('/api/users', admin)
        .send({ email: mail, password: 'clave-secreta-larga-1', role: 'viewer', plants: ['demo'] })
        .expect(201);
      const id = (created.body as ManagedUser).id;
      await api
        .patch(`/api/users/${id}`, admin)
        .send({ password: 'clave-secreta-larga-2', role: 'operator' })
        .expect(200);
      // una planta ajena (inexistente o de otro cliente) no se puede asignar: 403
      await api.put(`/api/users/${id}/plants`, admin).send({ plants: ['demo', 'otra'] }).expect(403);
      t.plants.register('otra', 'campos-demo');
      await api
        .put(`/api/users/${id}/plants`, admin)
        .send({ plants: ['demo', 'otra'] })
        .expect(200);

      const mine = (await auditAll()).filter((e) => e.target === `user:${id}`);
      expect(mine.map((e) => e.action).sort()).toEqual([
        'user.create',
        'user.plants',
        'user.update',
      ]);
      expect(mine.find((e) => e.action === 'user.create')?.detail).toEqual({
        email: mail,
        role: 'viewer',
        plants: ['demo'],
        orgId: 'campos-demo',
      });
      expect(mine.find((e) => e.action === 'user.update')?.detail).toEqual({
        changed: ['role', 'password'],
        role: 'operator',
      });
      expect(mine.find((e) => e.action === 'user.plants')?.detail).toEqual({
        plants: ['demo', 'otra'],
      });
      expect(JSON.stringify(await auditAll())).not.toMatch(
        /clave-secreta|\$2[aby]\$|eyJ|password-123/,
      );
    });

    it('el ack de una alarma se audita una sola vez (idempotente)', async () => {
      const op = await t.makeUser(email('ack'), 'operator', ['demo']);
      const alarm: AlarmEvent = {
        type: 'alarm',
        id: '00000000-0000-4000-8000-0000000000aa',
        ruleId: '00000000-0000-4000-8000-0000000000a1',
        plant: 'demo',
        asset: 'tk-02',
        metric: 'level',
        severity: 'critical',
        state: 'active',
        value: 95,
        threshold: 90,
        ts: Date.now(),
        message: 'nivel alto',
      };
      await t.alarms.insert(alarm);
      await api.post(`/api/alarms/${alarm.id}/ack`, op.token).expect(200);
      await api.post(`/api/alarms/${alarm.id}/ack`, op.token).expect(200);
      const acks = (await auditAll('action=alarm.ack')).filter(
        (e) => e.target === `alarm:${alarm.id}`,
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        actorId: op.id,
        detail: { plant: 'demo', asset: 'tk-02', metric: 'level', severity: 'critical' },
      });
    });

    it('las reglas de alarma se auditan (alta, edición, baja)', async () => {
      const created = await api
        .post('/api/alarm-rules', admin)
        .send(ruleBody('demo', 'tk-9*'))
        .expect(201);
      const id = (created.body as { id: string }).id;
      await api.patch(`/api/alarm-rules/${id}`, admin).send({ threshold: 50 }).expect(200);
      await api.delete(`/api/alarm-rules/${id}`, admin).expect(204);
      const mine = (await auditAll()).filter((e) => e.target === `rule:${id}`);
      expect(mine.map((e) => e.action)).toEqual(['rule.delete', 'rule.update', 'rule.create']);
      expect(mine[1].detail).toEqual({ changed: ['threshold'], plant: 'demo' });
      expect(mine[2].detail).toMatchObject({ asset: 'tk-9*', metric: 'level', threshold: 90 });
    });
  });

  describe('rate limit de POST /api/me/password', () => {
    it('limita por usuario los intentos (fuerza bruta de la contraseña actual)', async () => {
      const limited = await createTestApp({ loginRateLimit: 3 });
      try {
        const h = limited.app.getHttpServer() as App;
        const a = await limited.makeUser('a@campo.test', 'viewer', ['demo']);
        const b = await limited.makeUser('b@campo.test', 'viewer', ['demo']);
        const attempt = (token: string) =>
          request(h)
            .post('/api/me/password')
            .set(bearer(token))
            .send({ currentPassword: 'incorrecta-123456', newPassword: 'nueva-clave-muy-larga' });
        for (let i = 0; i < 3; i++) await attempt(a.token).expect(400);
        await attempt(a.token).expect(429);
        // otro usuario no se ve afectado, y el límite de login es independiente
        await attempt(b.token).expect(400);
        await request(h)
          .post('/api/auth/login')
          .send({ email: 'a@campo.test', password: 'viewer-password-123' })
          .expect(200);
        // aún con la contraseña correcta, bloqueado mientras dure la ventana
        await request(h)
          .post('/api/me/password')
          .set(bearer(a.token))
          .send({ currentPassword: 'viewer-password-123', newPassword: 'nueva-clave-muy-larga' })
          .expect(429);
      } finally {
        await limited.app.close();
      }
    });
  });

  describe('la auditoría no tumba la operación', () => {
    it('si falla la escritura, la operación principal se completa', async () => {
      t.audit.failWith = new Error('tabla audit_log caída');
      try {
        await api
          .post('/api/plants', admin)
          .send({ id: 'sin-audit', name: 'Sin audit' })
          .expect(201);
        expect((await api.get('/api/plants', admin).expect(200)).body as Plant[]).toContainEqual({
          id: 'sin-audit',
          name: 'Sin audit',
          assets: 0,
          orgId: 'campos-demo',
        });
      } finally {
        t.audit.failWith = undefined;
      }
      expect((await auditAll()).some((e) => e.target === 'plant:sin-audit')).toBe(false);
    });
  });
});
