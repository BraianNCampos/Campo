import type { AddressInfo } from 'node:net';
import { MODULE_IDS, redisKeys } from '@campo/shared';
import type { AuditEntry, Limit, LoginResponse, ManagedUser, Org, Plant } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { createTestApp, TestApp } from './support/test-app';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(url: string): Promise<{ closed: Promise<number>; messages: { type: string }[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: { type: string }[] = [];
    ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString())));
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('open', () => resolve({ closed, messages }));
    ws.on('error', reject);
  });
}

describe('Clientes, módulos y límites (e2e)', () => {
  let t: TestApp;
  let http: App;
  let wsBase: string;
  let platform: string;

  // Con caché de acceso ACTIVA (30 s) a propósito: los cambios del cliente deben aplicarse al instante.
  beforeAll(async () => {
    t = await createTestApp({ wsRevalidateMs: 5000 });
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer() as App;
    wsBase = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/ws`;
    platform = await t.tokenFor('platform_admin');
  });
  afterAll(async () => {
    await t.app.close();
  });

  const api = {
    get: (path: string, token?: string) => {
      const r = request(http).get(path);
      return token ? r.set(bearer(token)) : r;
    },
    post: (path: string, token: string) => request(http).post(path).set(bearer(token)),
    patch: (path: string, token: string) => request(http).patch(path).set(bearer(token)),
    delete: (path: string, token: string) => request(http).delete(path).set(bearer(token)),
  };
  const login = async (email: string, password: string) =>
    (await request(http).post('/api/auth/login').send({ email, password }).expect(200))
      .body as LoginResponse;

  /** Crea un cliente por la API, con su primer administrador, y devuelve el token de éste. */
  async function provision(id: string, modules: string[]): Promise<string> {
    await api
      .post('/api/orgs', platform)
      .send({ id, name: `Cliente ${id}`, modules })
      .expect(201);
    await api
      .post(`/api/orgs/${id}/admins`, platform)
      .send({ email: `admin@${id}.test`, password: 'clave-admin-larga-1' })
      .expect(201);
    return (await login(`admin@${id}.test`, 'clave-admin-larga-1')).accessToken;
  }

  describe('API de plataforma /api/orgs', () => {
    it('platform_admin lista, crea, lee, edita; los contadores cuentan plantas y usuarios', async () => {
      const created = await api
        .post('/api/orgs', platform)
        .send({ id: 'acme', name: '  Acme SA ', modules: ['tanks', 'gas'] })
        .expect(201);
      expect(created.body).toEqual({
        id: 'acme',
        name: 'Acme SA',
        modules: ['tanks', 'gas'],
        active: true,
        createdAt: expect.any(Number),
        plants: 0,
        users: 0,
      } satisfies Org);
      await api
        .post('/api/orgs', platform)
        .send({ id: 'acme', name: 'Otro', modules: [] })
        .expect(409);

      await api
        .post('/api/orgs/acme/admins', platform)
        .send({ email: 'jefe@acme.test', password: 'clave-larga-123' })
        .expect(201);
      t.plants.register('acme-1', 'acme');
      const one = (await api.get('/api/orgs/acme', platform).expect(200)).body as Org;
      expect([one.plants, one.users]).toEqual([1, 1]);
      const all = (await api.get('/api/orgs', platform).expect(200)).body as Org[];
      expect(all.map((o) => o.id)).toEqual(expect.arrayContaining(['acme', 'campos-demo']));
      expect(all.find((o) => o.id === 'campos-demo')?.modules).toEqual([...MODULE_IDS]);

      const patched = await api
        .patch('/api/orgs/acme', platform)
        .send({ name: 'Acme', modules: ['tanks'], active: true })
        .expect(200);
      expect(patched.body).toMatchObject({ name: 'Acme', modules: ['tanks'] });
      await api.get('/api/orgs/nadie', platform).expect(404);
      await api.patch('/api/orgs/nadie', platform).send({ name: 'x' }).expect(404);
    });

    it('valida: módulos desconocidos o repetidos, ids y nombres inválidos, cuerpo vacío, campos extra', async () => {
      const post = (body: object) => api.post('/api/orgs', platform).send(body);
      await post({ id: 'v1', name: 'x', modules: ['tanks', 'inventado'] }).expect(400);
      await post({ id: 'v1', name: 'x', modules: ['tanks', 'tanks'] }).expect(400);
      await post({ id: 'v1', name: 'x', modules: 'tanks' }).expect(400);
      await post({ id: 'v1', name: 'x' }).expect(400);
      await post({ id: 'BAD ID', name: 'x', modules: [] }).expect(400);
      await post({ id: 'v1', name: '   ', modules: [] }).expect(400);
      await post({ id: 'v1', name: 'x', modules: [], plan: 'oro' }).expect(400);
      await api
        .patch('/api/orgs/campos-demo', platform)
        .send({ modules: ['inventado'] })
        .expect(400);
      await api.patch('/api/orgs/campos-demo', platform).send({}).expect(400);
      await api.patch('/api/orgs/campos-demo', platform).send({ id: 'otro' }).expect(400);
      await api.patch('/api/orgs/campos-demo', platform).send({ active: 'si' }).expect(400);
      expect(t.orgs.orgs.has('v1')).toBe(false);
      expect(t.orgs.orgs.get('campos-demo')?.modules).toEqual([...MODULE_IDS]);
    });

    it('DELETE: 409 con plantas o usuarios; 404 si no existe; 200 cuando está vacío', async () => {
      await api
        .post('/api/orgs', platform)
        .send({ id: 'borrar', name: 'B', modules: [] })
        .expect(201);
      t.plants.register('borrar-1', 'borrar');
      await api.delete('/api/orgs/borrar', platform).expect(409);
      t.plants.names.delete('borrar-1');
      t.plants.orgs.delete('borrar-1');
      await api
        .post('/api/orgs/borrar/admins', platform)
        .send({ email: 'b@borrar.test', password: 'clave-larga-123' })
        .expect(201);
      await api.delete('/api/orgs/borrar', platform).expect(409);
      const u = t.users.users.find((x) => x.email === 'b@borrar.test')!;
      t.users.users.splice(t.users.users.indexOf(u), 1);
      await api.delete('/api/orgs/borrar', platform).expect(200);
      await api.delete('/api/orgs/borrar', platform).expect(404);
    });

    it('POST /orgs/:id/admins: 404 si el cliente no existe, 409 si el email existe, valida contraseña y email', async () => {
      await api
        .post('/api/orgs/nadie/admins', platform)
        .send({ email: 'x@y.test', password: 'clave-larga-123' })
        .expect(404);
      await api
        .post('/api/orgs/campos-demo/admins', platform)
        .send({ email: 'x@y.test', password: 'corta' })
        .expect(400);
      await api
        .post('/api/orgs/campos-demo/admins', platform)
        .send({ email: 'no-es-email', password: 'clave-larga-123' })
        .expect(400);
      await api
        .post('/api/orgs/campos-demo/admins', platform)
        .send({ email: 'x@y.test', password: 'clave-larga-123' })
        .expect(201);
      await api
        .post('/api/orgs/campos-demo/admins', platform)
        .send({ email: 'X@y.test', password: 'clave-larga-123' })
        .expect(409);
    });

    it('audita org.create|update|delete y org.admin.create con el cliente, nunca contraseñas', async () => {
      await api
        .post('/api/orgs', platform)
        .send({ id: 'audi', name: 'Audi', modules: ['gas'] })
        .expect(201);
      await api
        .post('/api/orgs/audi/admins', platform)
        .send({ email: 'a@audi.test', password: 'clave-secreta-larga-9' })
        .expect(201);
      await api.patch('/api/orgs/audi', platform).send({ active: false }).expect(200);
      const adm = t.users.users.find((u) => u.email === 'a@audi.test')!;
      t.users.users.splice(t.users.users.indexOf(adm), 1);
      await api.delete('/api/orgs/audi', platform).expect(200);
      const entries = (await api.get('/api/audit?orgId=audi&limit=50', platform).expect(200))
        .body as AuditEntry[];
      expect(entries.map((e) => e.action).reverse()).toEqual([
        'org.create',
        'org.admin.create',
        'org.update',
        'org.delete',
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/clave-secreta|\$2[aby]\$|password/i);
      expect(entries.find((e) => e.action === 'org.update')?.detail).toEqual({
        changed: ['active'],
        active: false,
      });
    });
  });

  describe('flujo completo: el platform_admin sembrado crea un cliente y su administrador, que sólo ve lo suyo', () => {
    let admin: string;
    beforeAll(async () => {
      admin = await provision('flujo', ['tanks']);
      // datos de OTRO cliente (campos-demo): `demo` con 2 activos
    });

    it('el administrador ve su cliente (me.org), ninguna planta ajena y 403 en las de campos-demo', async () => {
      const me = (await api.get('/api/me', admin).expect(200)).body;
      expect(me).toMatchObject({
        role: 'admin',
        plants: ['*'],
        org: { id: 'flujo', name: 'Cliente flujo', modules: ['tanks'] },
      });
      expect((await api.get('/api/plants', admin).expect(200)).body).toEqual([]);
      for (const p of [
        '/api/plants/demo/assets',
        '/api/plants/demo/state',
        '/api/plants/demo/limits',
        '/api/plants/demo/models',
      ]) {
        await api.get(p, admin).expect(403);
      }
      expect((await api.get('/api/users', admin).expect(200)).body).toHaveLength(1);
      await api.get('/api/orgs', admin).expect(403);
    });

    it('crea su planta (cliente implícito), activos y reglas; platform_admin lo ve todo', async () => {
      const plant = (
        await api.post('/api/plants', admin).send({ id: 'flujo-1', name: 'Planta 1' }).expect(201)
      ).body as Plant;
      expect(plant).toEqual({ id: 'flujo-1', name: 'Planta 1', assets: 0, orgId: 'flujo' });
      await api
        .post('/api/plants/flujo-1/assets', admin)
        .send({ id: 'tk-1', name: 'T1', type: 'tank', metadata: { capacityM3: 40 } })
        .expect(201);
      await api
        .post('/api/alarm-rules', admin)
        .send({
          plant: 'flujo-1',
          asset: 'tk-*',
          metric: 'level',
          operator: 'gt',
          threshold: 90,
          severity: 'critical',
        })
        .expect(201);
      const mine = (await api.get('/api/plants', admin).expect(200)).body as Plant[];
      expect(mine.map((p) => p.id)).toEqual(['flujo-1']);
      const all = (await api.get('/api/plants', platform).expect(200)).body as Plant[];
      expect(all.map((p) => [p.id, p.orgId])).toEqual(
        expect.arrayContaining([
          ['demo', 'campos-demo'],
          ['flujo-1', 'flujo'],
        ]),
      );
      expect((await api.get('/api/plants?orgId=flujo', platform).expect(200)).body).toHaveLength(1);
      // el admin de campos-demo no ve nada de esto
      const demoAdmin = await t.tokenFor('admin');
      await api.get('/api/plants/flujo-1/assets', demoAdmin).expect(403);
      expect(
        JSON.stringify((await api.get('/api/alarm-rules', demoAdmin).expect(200)).body),
      ).not.toContain('flujo');
    });

    it('platform_admin debe indicar orgId al crear planta o usuario (400); admin no lo necesita', async () => {
      await api.post('/api/plants', platform).send({ id: 'sin-org', name: 'x' }).expect(400);
      await api
        .post('/api/plants', platform)
        .send({ id: 'sin-org', name: 'x', orgId: 'nadie' })
        .expect(404);
      await api
        .post('/api/users', platform)
        .send({ email: 'u@flujo.test', password: 'clave-larga-123', role: 'viewer' })
        .expect(400);
      const u = await api
        .post('/api/users', platform)
        .send({
          email: 'u@flujo.test',
          password: 'clave-larga-123',
          role: 'viewer',
          orgId: 'flujo',
          plants: ['flujo-1'],
        })
        .expect(201);
      expect((u.body as ManagedUser).org?.id).toBe('flujo');
      await api
        .post('/api/users', platform)
        .send({
          email: 'u2@flujo.test',
          password: 'clave-larga-123',
          role: 'viewer',
          orgId: 'flujo',
          plants: ['demo'],
        })
        .expect(400);
      // el admin lo hace siempre en su cliente
      await api
        .post('/api/users', admin)
        .send({ email: 'u3@flujo.test', password: 'clave-larga-123', role: 'viewer' })
        .expect(201);
      expect(t.users.users.find((x) => x.email === 'u3@flujo.test')?.orgId).toBe('flujo');
    });

    it('platform_admin crea otro platform_admin (sin cliente) que a su vez ve todo', async () => {
      const res = await api
        .post('/api/users', platform)
        .send({ email: 'p2@campo.test', password: 'clave-larga-123', role: 'platform_admin' })
        .expect(201);
      expect(res.body).toMatchObject({ role: 'platform_admin', org: null, plants: [] });
      const p2 = (await login('p2@campo.test', 'clave-larga-123')).accessToken;
      await api.get('/api/plants/flujo-1/assets', p2).expect(200);
      await api.get('/api/orgs', p2).expect(200);
    });
  });

  describe('módulos contratados', () => {
    let admin: string;
    beforeAll(async () => {
      admin = await provision('mods', ['tanks']);
      await api.post('/api/plants', admin).send({ id: 'mods-1', name: 'M' }).expect(201);
    });
    const create = (token: string, type: string, id = `a-${type}`, extra: object = {}) =>
      api.post('/api/plants/mods-1/assets', token).send({ id, name: id, type, ...extra });

    it('un tipo de un módulo NO contratado -> 403 {error:module_disabled, module}', async () => {
      for (const [type, module] of [
        ['climate', 'climate'],
        ['energy', 'energy'],
        ['gas', 'gas'],
        ['machine', 'machines'],
        ['pressure', 'flow'],
        ['flow', 'flow'],
      ]) {
        const res = await create(admin, type).expect(403);
        expect(res.body).toEqual({
          statusCode: 403,
          error: 'module_disabled',
          module,
          message: expect.any(String),
        });
      }
      expect(t.assets.assets.some((a) => a.plant === 'mods-1')).toBe(false);
    });

    it('los tipos del módulo contratado y el genérico `sensor` sí', async () => {
      for (const type of ['tank', 'pump', 'valve', 'sensor']) await create(admin, type).expect(201);
    });

    it('editar: cambiar el tipo a uno no contratado -> 403; platform_admin tampoco lo salta', async () => {
      await api.patch('/api/plants/mods-1/assets/a-tank', admin).send({ type: 'gas' }).expect(403);
      await api
        .patch('/api/plants/mods-1/assets/a-tank', platform)
        .send({ type: 'gas' })
        .expect(403);
      await create(platform, 'machine', 'a-maq').expect(403);
      await api
        .patch('/api/plants/mods-1/assets/a-tank', admin)
        .send({ name: 'Renombrado' })
        .expect(200);
    });

    it('activar un módulo surte efecto AL INSTANTE (caché de acceso invalidada); quitarlo bloquea nuevas altas pero no borra datos', async () => {
      await api
        .patch('/api/orgs/mods', platform)
        .send({ modules: ['tanks', 'gas'] })
        .expect(200);
      await create(admin, 'gas').expect(201);
      expect((await api.get('/api/me', admin).expect(200)).body.org.modules).toEqual([
        'tanks',
        'gas',
      ]);
      await api
        .patch('/api/orgs/mods', platform)
        .send({ modules: ['tanks'] })
        .expect(200);
      await create(admin, 'gas', 'gas-2').expect(403);
      const assets = (await api.get('/api/plants/mods-1/assets', admin).expect(200)).body as {
        id: string;
      }[];
      expect(assets.map((a) => a.id)).toContain('a-gas'); // el dato sigue
      await api
        .patch('/api/plants/mods-1/assets/a-gas', admin)
        .send({ name: 'sigue editable' })
        .expect(200);
    });

    it('acepta los 10 tipos con todos los módulos y rechaza tipos desconocidos (400)', async () => {
      const all = await provision('todos', [...MODULE_IDS]);
      await api.post('/api/plants', all).send({ id: 'todos-1', name: 'T' }).expect(201);
      for (const type of [
        'tank',
        'pump',
        'valve',
        'sensor',
        'climate',
        'energy',
        'gas',
        'machine',
        'pressure',
        'flow',
      ]) {
        await api
          .post('/api/plants/todos-1/assets', all)
          .send({ id: `x-${type}`, name: type, type })
          .expect(201);
      }
      await api
        .post('/api/plants/todos-1/assets', all)
        .send({ id: 'x-raro', name: 'x', type: 'turbina' })
        .expect(400);
    });

    it('metadatos de dominio: capacityM3, contractedKw y scale se validan; tope de 8 KB', async () => {
      const bad = (metadata: object) => create(admin, 'sensor', 'meta', { metadata }).expect(400);
      await bad({ capacityM3: 0 });
      await bad({ capacityM3: -5 });
      await bad({ capacityM3: 'mucho' });
      await bad({ contractedKw: 0 });
      await bad({ scale: { level: { min: 5, max: 5 } } });
      await bad({ scale: { level: { min: 9, max: 1 } } });
      await bad({ scale: { level: { min: 0 } } });
      await bad({ scale: [] });
      await bad({ blob: 'x'.repeat(9000) });
      await create(admin, 'sensor', 'meta', {
        metadata: {
          capacityM3: 12.5,
          contractedKw: 30,
          scale: { level: { min: 0, max: 50 } },
          layout: { x: 1, z: 2 },
        },
      }).expect(201);
    });
  });

  describe('límites GET /plants/:plant/limits', () => {
    let admin: string;
    let viewer: string;
    beforeAll(async () => {
      admin = await provision('lim', ['tanks', 'energy']);
      await api.post('/api/plants', admin).send({ id: 'lim-1', name: 'L' }).expect(201);
      for (const [id, type] of [
        ['tk-01', 'tank'],
        ['tk-02', 'tank'],
        ['en-1', 'energy'],
        ['pump-1', 'pump'],
      ]) {
        await api.post('/api/plants/lim-1/assets', admin).send({ id, name: id, type }).expect(201);
      }
      const rule = (body: object) =>
        api
          .post('/api/alarm-rules', admin)
          .send({ plant: 'lim-1', ...body })
          .expect(201);
      await rule({
        asset: 'tk-*',
        metric: 'level',
        operator: 'gt',
        threshold: 90,
        severity: 'critical',
      });
      await rule({
        asset: 'tk-*',
        metric: 'level',
        operator: 'lt',
        threshold: 10,
        severity: 'warning',
      });
      await rule({
        asset: 'en-1',
        metric: 'kw',
        operator: 'gt',
        threshold: 100,
        severity: 'warning',
      });
      await rule({
        asset: 'en-1',
        metric: 'kw',
        operator: 'gt',
        threshold: 120,
        severity: 'critical',
      });
      await rule({
        asset: 'fantasma-*',
        metric: 'level',
        operator: 'gt',
        threshold: 1,
        severity: 'warning',
      });
      await rule({
        asset: '*',
        metric: 'temp',
        operator: 'gt',
        threshold: 40,
        severity: 'warning',
        enabled: false,
      });
      // reglas de otra planta y de otro cliente: no deben aparecer
      await api
        .post('/api/alarm-rules', platform)
        .send({
          plant: 'demo',
          asset: '*',
          metric: 'level',
          operator: 'gt',
          threshold: 77,
          severity: 'warning',
        })
        .expect(201);
      viewer = (await t.makeUser('v@lim.test', 'viewer', ['lim-1'], 'lim')).token;
    });

    it('cualquier rol con acceso resuelve las reglas activas contra los activos existentes, en orden estable', async () => {
      const expected: Limit[] = [
        { asset: 'en-1', metric: 'kw', operator: 'gt', threshold: 100, severity: 'warning' },
        { asset: 'en-1', metric: 'kw', operator: 'gt', threshold: 120, severity: 'critical' },
        { asset: 'tk-01', metric: 'level', operator: 'lt', threshold: 10, severity: 'warning' },
        { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical' },
        { asset: 'tk-02', metric: 'level', operator: 'lt', threshold: 10, severity: 'warning' },
        { asset: 'tk-02', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical' },
      ];
      for (const token of [admin, viewer, platform]) {
        const res = await api.get('/api/plants/lim-1/limits', token).expect(200);
        expect(res.body).toEqual(expected);
      }
    });

    it('sin acceso a la planta: 403 (otro cliente, no asignada); sin token: 401; id inválido: 400', async () => {
      await api.get('/api/plants/lim-1/limits', await t.tokenFor('admin')).expect(403);
      const other = (await t.makeUser('v2@lim.test', 'viewer', [], 'lim')).token;
      await api.get('/api/plants/lim-1/limits', other).expect(403);
      await api.get('/api/plants/lim-1/limits').expect(401);
      await api.get('/api/plants/BAD_ID/limits', admin).expect(400);
      // los límites de `demo` (cliente campos-demo) son sólo los de su regla: nada de lim-1
      const demo = (
        await api.get('/api/plants/demo/limits', await t.tokenFor('viewer')).expect(200)
      ).body as Limit[];
      expect(demo.map((l) => [l.asset, l.threshold])).toEqual([
        ['pump-01', 77],
        ['tk-01', 77],
      ]);
    });

    it('un cambio de regla o de activo se refleja en la siguiente lectura', async () => {
      await api
        .post('/api/plants/lim-1/assets', admin)
        .send({ id: 'tk-03', name: 'T3', type: 'tank' })
        .expect(201);
      await api.delete('/api/plants/lim-1/assets/tk-01', admin).expect(200);
      const assets = (
        (await api.get('/api/plants/lim-1/limits', viewer).expect(200)).body as Limit[]
      ).map((l) => l.asset);
      expect([...new Set(assets)]).toEqual(['en-1', 'tk-02', 'tk-03']);
    });
  });

  describe('cliente desactivado', () => {
    it('login 401, tokens existentes 401 y sockets 4401; reactivar no resucita los tokens viejos', async () => {
      const admin = await provision('baja', ['tanks']);
      await api.post('/api/plants', admin).send({ id: 'baja-1', name: 'B' }).expect(201);
      const viewer = await t.makeUser('v@baja.test', 'viewer', ['baja-1'], 'baja');
      await t.redis.hset(
        redisKeys.state('baja-1'),
        'x',
        JSON.stringify({ ts: 1, values: {}, quality: 'good' }),
      );
      const wsAdmin = await open(`${wsBase}?plant=baja-1&token=${admin}`);
      const wsViewer = await open(`${wsBase}?plant=baja-1&token=${viewer.token}`);
      const wsPlat = await open(`${wsBase}?plant=baja-1&token=${platform}`);
      await sleep(50);
      await api.get('/api/plants/baja-1/assets', admin).expect(200); // cachea al usuario (TTL 30 s)

      await api.patch('/api/orgs/baja', platform).send({ active: false }).expect(200);

      // REST al instante, aunque haya caché
      await api.get('/api/me', admin).expect(401);
      await api.get('/api/plants/baja-1/assets', viewer.token).expect(401);
      // WS: los abiertos se cierran con 4401 y los nuevos no entran
      expect(await wsAdmin.closed).toBe(4401);
      expect(await wsViewer.closed).toBe(4401);
      const late = await open(`${wsBase}?plant=baja-1&token=${admin}`);
      expect(await late.closed).toBe(4401);
      // login 401 (mismo mensaje que credenciales erróneas)
      const denied = await request(http)
        .post('/api/auth/login')
        .send({ email: 'admin@baja.test', password: 'clave-admin-larga-1' })
        .expect(401);
      expect(denied.body.message).toBe('Credenciales inválidas');
      // platform_admin sigue viendo el cliente y sus datos
      await api.get('/api/plants/baja-1/assets', platform).expect(200);
      expect((await api.get('/api/orgs/baja', platform).expect(200)).body.active).toBe(false);
      expect(wsPlat.messages.length).toBeGreaterThan(0);

      // reactivar: los tokens viejos siguen revocados; un login nuevo funciona
      await api.patch('/api/orgs/baja', platform).send({ active: true }).expect(200);
      await api.get('/api/me', admin).expect(401);
      const fresh = (await login('admin@baja.test', 'clave-admin-larga-1')).accessToken;
      await api.get('/api/me', fresh).expect(200);
    });
  });

  describe('auditoría por cliente', () => {
    it('cada entrada lleva el cliente del recurso; cada admin sólo ve el suyo; platform filtra con orgId', async () => {
      const adminX = await provision('aud-x', ['tanks']);
      const adminY = await provision('aud-y', ['tanks']);
      await api.post('/api/plants', adminX).send({ id: 'aud-x1', name: 'X' }).expect(201);
      await api.post('/api/plants', adminY).send({ id: 'aud-y1', name: 'Y' }).expect(201);
      // plataforma actúa en el cliente X: queda en la auditoría de X, no en la suya
      await api
        .post('/api/plants/aud-x1/assets', platform)
        .send({ id: 'by-platform', name: 'P', type: 'tank' })
        .expect(201);

      const ofX = (await api.get('/api/audit?limit=100', adminX).expect(200)).body as AuditEntry[];
      const ofY = (await api.get('/api/audit?limit=100&orgId=aud-x', adminY).expect(200))
        .body as AuditEntry[];
      expect(ofX.map((e) => e.target)).toEqual(
        expect.arrayContaining(['plant:aud-x1', 'asset:aud-x1/by-platform']),
      );
      expect(JSON.stringify(ofX)).not.toMatch(/aud-y/);
      expect(JSON.stringify(ofY)).not.toMatch(/aud-x/);
      expect(ofY.map((e) => e.target)).toContain('plant:aud-y1');

      const viaPlatform = (await api.get('/api/audit?limit=200&orgId=aud-x', platform).expect(200))
        .body as AuditEntry[];
      expect(JSON.stringify(viaPlatform)).not.toMatch(/aud-y/);
      expect(viaPlatform.some((e) => e.actorEmail === 'platform@campo.test')).toBe(true);
      const everything = JSON.stringify(
        (await api.get('/api/audit?limit=200', platform).expect(200)).body,
      );
      expect(everything).toMatch(/aud-x/);
      expect(everything).toMatch(/aud-y/);
    });
  });
});
