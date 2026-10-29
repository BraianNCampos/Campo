import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AlarmEvent, LoginResponse, ManagedUser, Me } from '@campo/shared';
import { redisKeys } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import type { AlarmRecord, AlarmRule } from '../src/alarms/alarm.types';
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
  ws: WebSocket;
  messages: { type: string; plant?: string }[];
  closed: Promise<number>;
  closeCode: () => number | undefined;
}

function open(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Socket['messages'] = [];
    let code: number | undefined;
    ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString())));
    const closed = new Promise<number>((r) =>
      ws.on('close', (c) => {
        code = c;
        r(c);
      }),
    );
    ws.on('open', () => resolve({ ws, messages, closed, closeCode: () => code }));
    ws.on('error', reject);
    ws.on('unexpected-response', () => reject(new Error('unexpected-response')));
  });
}

const alarmEvent = (id: string, plant: string): AlarmEvent => ({
  type: 'alarm',
  id,
  ruleId: '00000000-0000-4000-8000-0000000000a1',
  plant,
  asset: 'tk-01',
  metric: 'level',
  severity: 'critical',
  state: 'active',
  value: 95,
  threshold: 90,
  ts: Date.now(),
  message: `alarma ${plant}`,
});

const rule = (plant: string) => ({
  plant,
  asset: 'tk-*',
  metric: 'level',
  operator: 'gt',
  threshold: 90,
  severity: 'critical',
});

describe('Autorización por planta (e2e)', () => {
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
    // dos plantas con datos vivos
    for (const plant of ['demo', 'otra']) {
      await t.redis.hset(
        redisKeys.state(plant),
        'tk-01',
        JSON.stringify({ ts: 1, values: { level: 10 }, quality: 'good' }),
      );
    }
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

  describe('GET /api/me y login', () => {
    it('login devuelve user {id,email,role,plants}; admin -> ["*"]', async () => {
      const u = await t.makeUser(email('ana'), 'operator', ['demo']);
      const res = await request(http)
        .post('/api/auth/login')
        .send({ email: u.email, password: 'operator-password-123' })
        .expect(200);
      const body = res.body as LoginResponse;
      expect(body.user).toEqual({ id: u.id, email: u.email, role: 'operator', plants: ['demo'] });
      expect(JSON.stringify(res.body)).not.toMatch(/hash|\$2[aby]\$/);

      const adm = await request(http)
        .post('/api/auth/login')
        .send({ email: 'admin@campo.test', password: 'admin-password-123' })
        .expect(200);
      expect((adm.body as LoginResponse).user).toMatchObject({ role: 'admin', plants: ['*'] });
    });

    it('GET /api/me refleja la base y exige token', async () => {
      const u = await t.makeUser(email('eva'), 'viewer', ['demo', 'otra']);
      const res = await api.get('/api/me', u.token).expect(200);
      expect(res.body).toEqual({
        id: u.id,
        email: u.email,
        role: 'viewer',
        plants: ['demo', 'otra'],
      } satisfies Me);
      expect((await api.get('/api/me', admin).expect(200)).body.plants).toEqual(['*']);
      await request(http).get('/api/me').expect(401);
    });
  });

  describe('rutas con :plant', () => {
    it('operator con `demo` ve demo y recibe 403 en `otra` (state, assets, history)', async () => {
      const u = await t.makeUser(email('op'), 'operator', ['demo']);
      await api.get('/api/plants/demo/state', u.token).expect(200);
      await api.get('/api/plants/demo/assets', u.token).expect(200);
      await api.get('/api/plants/demo/assets/tk-01/history?metric=level', u.token).expect(200);

      for (const path of [
        '/api/plants/otra/state',
        '/api/plants/otra/assets',
        '/api/plants/otra/assets/tk-01/history?metric=level',
      ]) {
        await api.get(path, u.token).expect(403);
      }
    });

    it('el 403 es el mismo exista o no la planta', async () => {
      const u = await t.makeUser(email('op'), 'operator', ['demo']);
      const real = await api.get('/api/plants/otra/state', u.token).expect(403);
      const fake = await api.get('/api/plants/no-existe/state', u.token).expect(403);
      expect(real.body).toEqual(fake.body);
    });

    it('sin asignaciones no hay acceso; el id inválido sigue siendo 400', async () => {
      const u = await t.makeUser(email('sin'), 'viewer', []);
      await api.get('/api/plants/demo/state', u.token).expect(403);
      await api.get('/api/plants/BAD_ID/state', u.token).expect(400);
    });

    it('admin accede a todas; planta inexistente -> 404 sólo para admin', async () => {
      await api.get('/api/plants/otra/state', admin).expect(200);
      await api.get('/api/plants/fantasma/state', admin).expect(404);
    });
  });

  describe('revocación sin esperar a la expiración del token', () => {
    it('quitar la planta: REST 403 al instante con el mismo token, y el WS abierto se cierra con 4403', async () => {
      const u = await t.makeUser(email('rev'), 'operator', ['demo']);
      await api.get('/api/plants/demo/state', u.token).expect(200); // cachea al usuario
      const sock = await open(`${wsBase}?plant=demo&token=${u.token}`);
      await until(() => sock.messages.some((m) => m.type === 'snapshot'));

      await api.put(`/api/users/${u.id}/plants`, admin).send({ plants: [] }).expect(200);

      await api.get('/api/plants/demo/state', u.token).expect(403);
      expect(await sock.closed).toBe(4403);
      // reconectar tampoco funciona
      expect(await (await open(`${wsBase}?plant=demo&token=${u.token}`)).closed).toBe(4403);
      // el token sigue siendo válido para lo que no depende de plantas
      expect((await api.get('/api/me', u.token).expect(200)).body.plants).toEqual([]);
    });

    it('quitar sólo una planta no afecta a los sockets de la otra', async () => {
      const u = await t.makeUser(email('dos'), 'viewer', ['demo', 'otra']);
      const demo = await open(`${wsBase}?plant=demo&token=${u.token}`);
      const otra = await open(`${wsBase}?plant=otra&token=${u.token}`);
      await until(() => demo.messages.length > 0 && otra.messages.length > 0);
      await api
        .put(`/api/users/${u.id}/plants`, admin)
        .send({ plants: ['otra'] })
        .expect(200);
      expect(await demo.closed).toBe(4403);
      await sleep(250);
      expect(otra.closeCode()).toBeUndefined();
      otra.ws.close();
    });

    it('usuario desactivado -> 401 en REST y el WS abierto se cierra con 4401; el login falla', async () => {
      const u = await t.makeUser(email('baja'), 'engineer', ['demo']);
      await api.get('/api/alarm-rules', u.token).expect(200);
      const sock = await open(`${wsBase}?plant=demo&token=${u.token}`);
      await until(() => sock.messages.length > 0);

      await api.patch(`/api/users/${u.id}`, admin).send({ active: false }).expect(200);

      await api.get('/api/alarm-rules', u.token).expect(401);
      await api.get('/api/me', u.token).expect(401);
      expect(await sock.closed).toBe(4401);
      expect(await (await open(`${wsBase}?plant=demo&token=${u.token}`)).closed).toBe(4401);
      await request(http)
        .post('/api/auth/login')
        .send({ email: u.email, password: 'engineer-password-123' })
        .expect(401);

      // reactivar NO resucita el token anterior (desactivar sube token_version, §9.1): hay que volver a entrar
      await api.patch(`/api/users/${u.id}`, admin).send({ active: true }).expect(200);
      await api.get('/api/alarm-rules', u.token).expect(401);
      const relogin = await request(http)
        .post('/api/auth/login')
        .send({ email: u.email, password: 'engineer-password-123' })
        .expect(200);
      await api.get('/api/alarm-rules', (relogin.body as LoginResponse).accessToken).expect(200);
    });

    it('el rol efectivo es el de la base, no el del token', async () => {
      const u = await t.makeUser(email('rol'), 'viewer', ['demo']);
      const jwt = t.app.get(JwtService);
      const forged = await jwt.signAsync({ sub: u.id, email: u.email, role: 'admin' });
      await api.get('/api/users', forged).expect(403);
      await api.get('/api/alarm-rules', forged).expect(403);
      await api.get('/api/plants/otra/state', forged).expect(403);
      // y un ascenso en la base se aplica con el token viejo
      await api.patch(`/api/users/${u.id}`, admin).send({ role: 'engineer' }).expect(200);
      await api.get('/api/alarm-rules', u.token).expect(200);
    });
  });

  describe('cambios hechos fuera de este proceso (otra réplica): convergen por TTL', () => {
    it('REST y WS pierden el acceso en <= TTL sin aviso de invalidación', async () => {
      const short = await createTestApp({ authCacheTtlMs: 300, wsRevalidateMs: 150 });
      await short.app.listen(0, '127.0.0.1');
      try {
        const h = short.app.getHttpServer() as App;
        const base = `ws://127.0.0.1:${(short.app.getHttpServer().address() as AddressInfo).port}/ws`;
        const u = await short.makeUser(email('ttl'), 'viewer', ['demo']);
        await request(h).get('/api/plants/demo/state').set(bearer(u.token)).expect(200);
        const sock = await open(`${base}?plant=demo&token=${u.token}`);
        await until(() => sock.messages.length > 0);

        await short.users.setPlants(u.id, []); // directo al repositorio: no invalida la caché
        const t0 = Date.now();
        await until(
          async () =>
            (await request(h).get('/api/plants/demo/state').set(bearer(u.token))).status === 403,
        );
        expect(Date.now() - t0).toBeLessThanOrEqual(300 + 150); // TTL + margen de la petición
        expect(await sock.closed).toBe(4403);
        expect(Date.now() - t0).toBeLessThanOrEqual(300 + 400);
      } finally {
        await short.app.close();
      }
    });
  });

  describe('WebSocket: códigos de cierre y aislamiento por planta', () => {
    it('4401 token inválido, 4400 planta inválida, 4403 sin acceso', async () => {
      const u = await t.makeUser(email('wsu'), 'viewer', ['demo']);
      expect(await (await open(`${wsBase}?plant=demo&token=falso`)).closed).toBe(4401);
      expect(await (await open(`${wsBase}?plant=BAD!&token=${u.token}`)).closed).toBe(4400);
      expect(await (await open(`${wsBase}?plant=otra&token=${u.token}`)).closed).toBe(4403);
      expect(await (await open(`${wsBase}?plant=no-existe&token=${u.token}`)).closed).toBe(4403);
    });

    it('sólo recibe eventos de la planta suscrita y su snapshot', async () => {
      const u = await t.makeUser(email('aisl'), 'viewer', ['demo', 'otra']);
      const sock = await open(`${wsBase}?plant=demo&token=${u.token}`);
      await until(() => sock.messages.length > 0);
      for (const plant of ['otra', 'demo']) {
        await t.redis.publish(
          redisKeys.events(plant),
          JSON.stringify({
            type: 'telemetry',
            plant,
            asset: 'tk-01',
            ts: Date.now(),
            quality: 'good',
            values: { level: 55 },
          }),
        );
        await t.redis.publish(
          redisKeys.alarms(plant),
          JSON.stringify(alarmEvent(`ws-${plant}`, plant)),
        );
      }
      await sleep(300);
      expect(sock.messages.length).toBeGreaterThan(1);
      expect(sock.messages.every((m) => m.plant === 'demo')).toBe(true);
      sock.ws.close();
    });

    it('admin se conecta a cualquier planta', async () => {
      const sock = await open(`${wsBase}?plant=otra&token=${admin}`);
      await until(() => sock.messages.some((m) => m.type === 'snapshot'));
      sock.ws.close();
    });
  });

  describe('alarmas', () => {
    beforeAll(async () => {
      for (const [id, plant] of [
        ['00000000-0000-4000-8000-00000000d001', 'demo'],
        ['00000000-0000-4000-8000-00000000d002', 'demo'],
        ['00000000-0000-4000-8000-00000000e001', 'otra'],
      ]) {
        await t.alarms.insert({ ...alarmEvent(id, plant), ts: Date.now() + Number(id.slice(-1)) });
      }
    });

    const plantsOf = (body: AlarmRecord[]) => [...new Set(body.map((a) => a.plant))].sort();

    it('el listado no mezcla plantas: cada usuario sólo ve las suyas', async () => {
      const demoOnly = await t.makeUser(email('a1'), 'viewer', ['demo']);
      const both = await t.makeUser(email('a2'), 'viewer', ['demo', 'otra']);
      const none = await t.makeUser(email('a3'), 'operator', []);

      const a = (await api.get('/api/alarms', demoOnly.token).expect(200)).body as AlarmRecord[];
      expect(plantsOf(a)).toEqual(['demo']);
      expect(a).toHaveLength(2);

      expect(plantsOf((await api.get('/api/alarms', both.token)).body)).toEqual(['demo', 'otra']);
      expect((await api.get('/api/alarms', none.token).expect(200)).body).toEqual([]);
      expect(plantsOf((await api.get('/api/alarms', admin)).body)).toEqual(['demo', 'otra']);
    });

    it('`?plant=` opcional: permitida filtra; no permitida -> 403', async () => {
      const u = await t.makeUser(email('a4'), 'viewer', ['demo']);
      const ok = await api.get('/api/alarms?plant=demo', u.token).expect(200);
      expect(plantsOf(ok.body)).toEqual(['demo']);
      await api.get('/api/alarms?plant=otra', u.token).expect(403);
      const both = await t.makeUser(email('a5'), 'viewer', ['demo', 'otra']);
      expect(plantsOf((await api.get('/api/alarms?plant=otra', both.token)).body)).toEqual([
        'otra',
      ]);
    });

    it('el límite se aplica tras filtrar: las alarmas ajenas no desplazan a las propias', async () => {
      const u = await t.makeUser(email('a6'), 'viewer', ['demo']);
      // la alarma de `otra` es la más reciente; con limit=1 un filtro posterior daría []
      await t.alarms.insert({
        ...alarmEvent('00000000-0000-4000-8000-00000000e002', 'otra'),
        ts: Date.now() + 10_000,
      });
      const res = await api.get('/api/alarms?limit=1', u.token).expect(200);
      expect(res.body).toHaveLength(1);
      expect((res.body as AlarmRecord[])[0].plant).toBe('demo');
    });

    it('ack: según la planta de la alarma; 403 en otra planta (sin efecto), 404 si no existe', async () => {
      const op = await t.makeUser(email('a7'), 'operator', ['demo']);
      const foreign = '00000000-0000-4000-8000-00000000e001';
      await api.post(`/api/alarms/${foreign}/ack`, op.token).expect(403);
      expect(t.alarms.alarms.get(foreign)?.acknowledged).toBe(false);

      await api.post('/api/alarms/00000000-0000-4000-8000-00000000d001/ack', op.token).expect(200);
      await api.post('/api/alarms/00000000-0000-4000-8000-0000000fffff/ack', op.token).expect(404);

      // admin sí puede reconocer en cualquier planta
      await api.post(`/api/alarms/${foreign}/ack`, admin).expect(200);
    });
  });

  describe('reglas de alarma (CRUD por planta)', () => {
    let ruleDemo: AlarmRule;
    let ruleOtra: AlarmRule;

    beforeAll(async () => {
      ruleDemo = (await api.post('/api/alarm-rules', admin).send(rule('demo')).expect(201))
        .body as AlarmRule;
      ruleOtra = (await api.post('/api/alarm-rules', admin).send(rule('otra')).expect(201))
        .body as AlarmRule;
    });

    it('engineer con `demo`: sólo ve y toca reglas de demo', async () => {
      const eng = await t.makeUser(email('r1'), 'engineer', ['demo']);

      const list = (await api.get('/api/alarm-rules', eng.token).expect(200)).body as AlarmRule[];
      expect(list.map((r) => r.plant)).not.toContain('otra');
      expect(list.map((r) => r.id)).toContain(ruleDemo.id);
      await api.get('/api/alarm-rules?plant=otra', eng.token).expect(403);

      await api.get(`/api/alarm-rules/${ruleDemo.id}`, eng.token).expect(200);
      await api.get(`/api/alarm-rules/${ruleOtra.id}`, eng.token).expect(403);

      // crear
      const mine = await api.post('/api/alarm-rules', eng.token).send(rule('demo')).expect(201);
      await api.post('/api/alarm-rules', eng.token).send(rule('otra')).expect(403);

      // editar: la de otra planta no; y no se puede mover una propia a una ajena
      await api
        .patch(`/api/alarm-rules/${ruleOtra.id}`, eng.token)
        .send({ threshold: 1 })
        .expect(403);
      await api
        .patch(`/api/alarm-rules/${mine.body.id}`, eng.token)
        .send({ plant: 'otra' })
        .expect(403);
      await api
        .patch(`/api/alarm-rules/${mine.body.id}`, eng.token)
        .send({ threshold: 77 })
        .expect(200);
      expect(t.rules.rules.get(ruleOtra.id)?.threshold).toBe(90); // intacta

      // borrar
      await api.delete(`/api/alarm-rules/${ruleOtra.id}`, eng.token).expect(403);
      await api.delete(`/api/alarm-rules/${mine.body.id}`, eng.token).expect(204);
      expect(t.rules.rules.has(ruleOtra.id)).toBe(true);
    });

    it('engineer sin plantas no ve nada ni puede crear', async () => {
      const eng = await t.makeUser(email('r2'), 'engineer', []);
      expect((await api.get('/api/alarm-rules', eng.token).expect(200)).body).toEqual([]);
      await api.post('/api/alarm-rules', eng.token).send(rule('demo')).expect(403);
    });

    it('admin gestiona reglas de cualquier planta', async () => {
      const all = (await api.get('/api/alarm-rules', admin).expect(200)).body as AlarmRule[];
      expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([ruleDemo.id, ruleOtra.id]));
      await api.patch(`/api/alarm-rules/${ruleOtra.id}`, admin).send({ plant: 'demo' }).expect(200);
      await api.patch(`/api/alarm-rules/${ruleOtra.id}`, admin).send({ plant: 'otra' }).expect(200);
    });
  });

  describe('administración de usuarios', () => {
    it('sólo admin: el resto recibe 403 y sin token 401', async () => {
      for (const role of ['engineer', 'operator', 'viewer'] as const) {
        const u = await t.makeUser(email(`na-${role}`), role, ['demo']);
        await api.get('/api/users', u.token).expect(403);
        await api.post('/api/users', u.token).send({}).expect(403);
        await api.patch(`/api/users/${u.id}`, u.token).send({ role: 'admin' }).expect(403);
        await api
          .put(`/api/users/${u.id}/plants`, u.token)
          .send({ plants: ['otra'] })
          .expect(403);
      }
      await request(http).get('/api/users').expect(401);
    });

    it('crea, lista, modifica y asigna plantas; nunca expone el hash', async () => {
      const mail = email('nuevo');
      const created = await api
        .post('/api/users', admin)
        .send({
          email: mail.toUpperCase(),
          password: 'una-clave-larga-1',
          role: 'operator',
          plants: ['demo'],
        })
        .expect(201);
      const user = created.body as ManagedUser;
      expect(user).toEqual({
        id: expect.any(String),
        email: mail,
        role: 'operator',
        active: true,
        plants: ['demo'],
      });
      expect(JSON.stringify(created.body)).not.toMatch(/hash|password|\$2[aby]\$/i);

      const list = await api.get('/api/users', admin).expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/hash|password|\$2[aby]\$/i);
      expect((list.body as ManagedUser[]).find((x) => x.id === user.id)).toEqual(user);

      // el nuevo usuario puede entrar y ve su planta
      const login = await request(http)
        .post('/api/auth/login')
        .send({ email: mail, password: 'una-clave-larga-1' })
        .expect(200);
      const token = (login.body as LoginResponse).accessToken;
      await api.get('/api/plants/demo/state', token).expect(200);

      // PATCH: rol y contraseña
      const patched = await api
        .patch(`/api/users/${user.id}`, admin)
        .send({ role: 'viewer', password: 'otra-clave-larga-2' })
        .expect(200);
      expect(patched.body).toMatchObject({ role: 'viewer', active: true, plants: ['demo'] });
      expect(JSON.stringify(patched.body)).not.toMatch(/hash|password/i);
      await request(http)
        .post('/api/auth/login')
        .send({ email: mail, password: 'una-clave-larga-1' })
        .expect(401);
      await request(http)
        .post('/api/auth/login')
        .send({ email: mail, password: 'otra-clave-larga-2' })
        .expect(200);
      expect(t.users.users.find((x) => x.id === user.id)?.passwordHash).toMatch(/^\$2[aby]\$/);

      // PUT plants reemplaza y deduplica
      const put = await api
        .put(`/api/users/${user.id}/plants`, admin)
        .send({ plants: ['otra', 'demo'] })
        .expect(200);
      expect(put.body.plants).toEqual(['demo', 'otra']);
    });

    it('validación: contraseña < 12, email inválido, rol desconocido, plantas inválidas, campos extra', async () => {
      const ok = { email: email('v'), password: 'una-clave-larga-1', role: 'viewer' };
      await api
        .post('/api/users', admin)
        .send({ ...ok, password: 'corta-11-ch' })
        .expect(400);
      await api
        .post('/api/users', admin)
        .send({ ...ok, password: 'x'.repeat(73) })
        .expect(400);
      await api
        .post('/api/users', admin)
        .send({ ...ok, email: 'no-es-email' })
        .expect(400);
      await api
        .post('/api/users', admin)
        .send({ ...ok, role: 'root' })
        .expect(400);
      await api
        .post('/api/users', admin)
        .send({ ...ok, plants: ['BAD!'] })
        .expect(400);
      await api
        .post('/api/users', admin)
        .send({ ...ok, plants: ['*'] })
        .expect(400);
      await api
        .post('/api/users', admin)
        .send({ ...ok, active: false })
        .expect(400);
      const u = await t.makeUser(email('v2'), 'viewer', []);
      await api.patch(`/api/users/${u.id}`, admin).send({ password: 'corta-11-ch' }).expect(400);
      await api.patch(`/api/users/${u.id}`, admin).send({}).expect(400);
      await api.patch(`/api/users/${u.id}`, admin).send({ email: 'x@y.z' }).expect(400);
      await api.put(`/api/users/${u.id}/plants`, admin).send({ plants: 'demo' }).expect(400);
      await api
        .put(`/api/users/${u.id}/plants`, admin)
        .send({ plants: ['demo', 'demo'] })
        .expect(400);
      await api
        .put(`/api/users/${u.id}/plants`, admin)
        .send({ plants: ['A b'] })
        .expect(400);
      await api.patch('/api/users/no-uuid', admin).send({ active: false }).expect(400);
    });

    it('email duplicado -> 409; usuario inexistente -> 404', async () => {
      const dup = email('dup');
      await t.makeUser(dup, 'viewer');
      await api
        .post('/api/users', admin)
        .send({ email: dup, password: 'una-clave-larga-1', role: 'viewer' })
        .expect(409);
      const ghost = '00000000-0000-4000-8000-0000000fffff';
      await api.patch(`/api/users/${ghost}`, admin).send({ active: false }).expect(404);
      await api.put(`/api/users/${ghost}/plants`, admin).send({ plants: [] }).expect(404);
    });
  });

  describe('no se puede dejar el sistema sin admins', () => {
    it('el último admin activo no se desactiva ni se degrada; con otro admin sí', async () => {
      const solo = await createTestApp();
      try {
        const h = solo.app.getHttpServer() as App;
        const tok = await solo.tokenFor('admin');
        const seed = solo.users.users[0];
        const patch = (id: string, token: string, body: object) =>
          request(h).patch(`/api/users/${id}`).set(bearer(token)).send(body);

        await patch(seed.id, tok, { active: false }).expect(409);
        await patch(seed.id, tok, { role: 'viewer' }).expect(409);
        await patch(seed.id, tok, { active: false, role: 'engineer' }).expect(409);
        expect(solo.users.users[0]).toMatchObject({ role: 'admin', active: true });
        // cambios que no lo dejan sin admin siguen permitidos
        await patch(seed.id, tok, { role: 'admin', password: 'nueva-clave-larga-1' }).expect(200);
        // cambiar la contraseña revoca el token (§9.1): se vuelve a entrar con la nueva
        await request(h).get('/api/me').set(bearer(tok)).expect(401);
        const tokNew = (
          await request(h)
            .post('/api/auth/login')
            .send({ email: seed.email, password: 'nueva-clave-larga-1' })
            .expect(200)
        ).body.accessToken as string;

        // segundo admin
        const second = await request(h)
          .post('/api/users')
          .set(bearer(tokNew))
          .send({ email: 'admin2@campo.test', password: 'clave-admin-larga-2', role: 'admin' })
          .expect(201);
        const tok2 = (
          await request(h)
            .post('/api/auth/login')
            .send({ email: 'admin2@campo.test', password: 'clave-admin-larga-2' })
        ).body.accessToken as string;

        await patch(seed.id, tok2, { role: 'viewer' }).expect(200); // ahora queda admin2
        await patch(second.body.id, tok2, { active: false }).expect(409); // y es el último
        await patch(second.body.id, tok2, { role: 'operator' }).expect(409);
      } finally {
        await solo.app.close();
      }
    });
  });

  describe('log de denegaciones', () => {
    it('registra 401/403 con userId, ruta y planta, sin datos sensibles', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const u = await t.makeUser(email('log'), 'viewer', ['demo']);
        await api.get('/api/plants/otra/state?token=secreto-en-query', u.token).expect(403);
        await request(http).get('/api/me').set(bearer('basura')).expect(401);

        const entries = warn.mock.calls
          .map(([m]) => m as Record<string, unknown>)
          .filter((m) => m?.msg === 'acceso denegado');
        expect(entries).toContainEqual({
          msg: 'acceso denegado',
          status: 403,
          userId: u.id,
          method: 'GET',
          path: '/api/plants/otra/state',
          plant: 'otra',
        });
        expect(entries).toContainEqual(
          expect.objectContaining({ status: 401, path: '/api/me', userId: undefined }),
        );
        const text = JSON.stringify(entries);
        expect(text).not.toContain(u.token);
        expect(text).not.toContain('secreto-en-query');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
