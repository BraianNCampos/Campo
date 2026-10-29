import type { AlarmEvent } from '@campo/shared';
import { redisKeys } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AlarmRecord, AlarmRule } from '../src/alarms/alarm.types';
import { createTestApp, TestApp } from './support/test-app';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('API (e2e, repositorios en memoria)', () => {
  let t: TestApp;
  let http: App;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await createTestApp();
    http = t.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('sondas y seguridad HTTP', () => {
    it('GET /health es público', async () => {
      const res = await request(http).get('/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok' });
    });

    it('GET /ready comprueba Redis y DB', async () => {
      const res = await request(http).get('/ready').expect(200);
      expect(res.body).toEqual({ status: 'ready', redis: 'up', db: 'up' });

      t.pool.query.mockRejectedValueOnce(new Error('db down'));
      const down = await request(http).get('/ready').expect(503);
      expect(down.body).toMatchObject({ status: 'unavailable', redis: 'up', db: 'down' });
    });

    it('aplica helmet, oculta x-powered-by y CORS por lista de orígenes', async () => {
      const ok = await request(http).get('/health').set('Origin', 'http://localhost:3000');
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      expect(ok.headers['x-powered-by']).toBeUndefined();
      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');

      const bad = await request(http).get('/health').set('Origin', 'http://evil.example');
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('auth', () => {
    it('el admin semilla (ADMIN_EMAIL/ADMIN_PASSWORD) puede iniciar sesión', async () => {
      const res = await request(http)
        .post('/api/auth/login')
        .send({ email: 'admin@campo.test', password: 'admin-password-123' })
        .expect(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.accessToken.split('.')).toHaveLength(3);
      // la contraseña nunca se guarda en claro
      expect(JSON.stringify(t.users.users)).not.toContain('admin-password-123');
    });

    it('credenciales incorrectas -> 401 con mensaje genérico', async () => {
      const wrongPass = await request(http)
        .post('/api/auth/login')
        .send({ email: 'admin@campo.test', password: 'incorrecta' })
        .expect(401);
      const noUser = await request(http)
        .post('/api/auth/login')
        .send({ email: 'nadie@campo.test', password: 'incorrecta' })
        .expect(401);
      expect(wrongPass.body.message).toBe(noUser.body.message);
    });

    it('valida el cuerpo (whitelist estricta)', async () => {
      await request(http)
        .post('/api/auth/login')
        .send({ email: 'no-es-email', password: 'x' })
        .expect(400);
      await request(http).post('/api/auth/login').send({}).expect(400);
      await request(http)
        .post('/api/auth/login')
        .send({ email: 'admin@campo.test', password: 'x', role: 'admin' })
        .expect(400);
    });

    it('rutas protegidas exigen un token válido', async () => {
      await request(http).get('/api/plants/demo/assets').expect(401);
      await request(http).get('/api/plants/demo/assets').set(bearer('basura')).expect(401);
      await request(http).get('/api/alarms').expect(401);
      await request(http).get('/api/alarm-rules').expect(401);
    });

    it('limita los intentos de login', async () => {
      const limited = await createTestApp({ loginRateLimit: 3 });
      try {
        const h = limited.app.getHttpServer() as App;
        const attempt = () =>
          request(h).post('/api/auth/login').send({ email: 'x@campo.test', password: 'mala' });
        await attempt().expect(401);
        await attempt().expect(401);
        await attempt().expect(401);
        await attempt().expect(429);
      } finally {
        await limited.app.close();
      }
    });
  });

  describe('plantas y activos', () => {
    it('GET /api/plants/:plant/assets devuelve el catálogo', async () => {
      const token = await t.tokenFor('viewer');
      const res = await request(http).get('/api/plants/demo/assets').set(bearer(token)).expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ plant: 'demo', id: 'tk-01', type: 'tank' });
      const empty = await request(http)
        .get('/api/plants/otra/assets')
        .set(bearer(token))
        .expect(200);
      expect(empty.body).toEqual([]);
    });

    it('rechaza ids de planta inválidos', async () => {
      const token = await t.tokenFor('viewer');
      await request(http).get('/api/plants/BAD_PLANT/assets').set(bearer(token)).expect(400);
      await request(http).get('/api/plants/-x/state').set(bearer(token)).expect(400);
    });

    it('GET /api/plants/:plant/state lee el hash campo:state:{plant}', async () => {
      const token = await t.tokenFor('viewer');
      const state = { ts: 1730213000000, values: { level: 72.5 }, quality: 'good' };
      await t.redis.hset(redisKeys.state('demo'), 'tk-01', JSON.stringify(state));
      await t.redis.hset(redisKeys.state('demo'), 'roto', '{no-json');
      const res = await request(http).get('/api/plants/demo/state').set(bearer(token)).expect(200);
      expect(res.body).toEqual({ type: 'snapshot', plant: 'demo', assets: { 'tk-01': state } });
    });
  });

  describe('histórico', () => {
    const url = '/api/plants/demo/assets/tk-01/history';

    it('valida parámetros', async () => {
      const token = await t.tokenFor('viewer');
      await request(http).get(url).set(bearer(token)).expect(400); // falta metric
      await request(http)
        .get(url)
        .query({ metric: 'level', bucket: '3s' })
        .set(bearer(token))
        .expect(400);
      await request(http)
        .get(url)
        .query({ metric: "level'; DROP TABLE x;--" })
        .set(bearer(token))
        .expect(400);
      await request(http)
        .get(url)
        .query({ metric: 'level', from: 'ayer' })
        .set(bearer(token))
        .expect(400);
      await request(http)
        .get(url)
        .query({ metric: 'level', from: '2025-02-01T00:00:00Z', to: '2025-01-01T00:00:00Z' })
        .set(bearer(token))
        .expect(400);
      await request(http)
        .get(url)
        .query({ metric: 'level', from: '2020-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' })
        .set(bearer(token))
        .expect(400); // rango máximo
      await request(http)
        .get(url)
        .query({
          metric: 'level',
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-02T00:00:00Z',
          bucket: '1s',
        })
        .set(bearer(token))
        .expect(400); // demasiados puntos
    });

    it('usa la tabla cruda en rangos cortos y telemetry_1m en largos', async () => {
      const token = await t.tokenFor('viewer');
      t.history.calls.length = 0;
      t.history.points = [{ t: 1000, avg: 5, min: 4, max: 6, samples: 3 }];

      const short = await request(http)
        .get(url)
        .query({ metric: 'level', from: '2025-01-01T00:00:00Z', to: '2025-01-01T01:00:00Z' })
        .set(bearer(token))
        .expect(200);
      expect(short.body).toMatchObject({
        plant: 'demo',
        asset: 'tk-01',
        metric: 'level',
        source: 'raw',
        points: [{ t: 1000, avg: 5, min: 4, max: 6, samples: 3 }],
      });

      const long = await request(http)
        .get(url)
        .query({ metric: 'level', from: 1735689600000, to: 1738281600000 })
        .set(bearer(token))
        .expect(200);
      expect(long.body.source).toBe('1m');

      expect(t.history.calls.map((c) => c.plan.source)).toEqual(['raw', '1m']);
      expect(t.history.calls[0]).toMatchObject({ plant: 'demo', asset: 'tk-01', metric: 'level' });
    });
  });

  describe('reglas de alarma (RBAC)', () => {
    const rule = {
      plant: 'demo',
      asset: 'tk-*',
      metric: 'level',
      operator: 'gt',
      threshold: 90,
      severity: 'critical',
    };

    it('operator y viewer no pueden ni leer ni escribir; engineer y admin sí', async () => {
      for (const role of ['viewer', 'operator'] as const) {
        const token = await t.tokenFor(role);
        await request(http).get('/api/alarm-rules').set(bearer(token)).expect(403);
        await request(http).post('/api/alarm-rules').set(bearer(token)).send(rule).expect(403);
      }
      for (const role of ['engineer', 'admin'] as const) {
        const token = await t.tokenFor(role);
        await request(http).get('/api/alarm-rules').set(bearer(token)).expect(200);
      }
    });

    it('CRUD completo con validación', async () => {
      const token = await t.tokenFor('engineer');
      await request(http)
        .post('/api/alarm-rules')
        .set(bearer(token))
        .send({ ...rule, operator: 'eq' })
        .expect(400);
      await request(http)
        .post('/api/alarm-rules')
        .set(bearer(token))
        .send({ ...rule, threshold: 'alto' })
        .expect(400);
      await request(http)
        .post('/api/alarm-rules')
        .set(bearer(token))
        .send({ ...rule, forSeconds: -1 })
        .expect(400);

      const created = await request(http)
        .post('/api/alarm-rules')
        .set(bearer(token))
        .send({ ...rule, forSeconds: 5, hysteresis: 2 })
        .expect(201);
      const r = created.body as AlarmRule;
      expect(r).toMatchObject({
        forSeconds: 5,
        hysteresis: 2,
        enabled: true,
        severity: 'critical',
      });

      const patched = await request(http)
        .patch(`/api/alarm-rules/${r.id}`)
        .set(bearer(token))
        .send({ threshold: 95 })
        .expect(200);
      expect(patched.body).toMatchObject({ threshold: 95, forSeconds: 5, hysteresis: 2 });

      const list = await request(http)
        .get('/api/alarm-rules')
        .query({ plant: 'demo' })
        .set(bearer(token))
        .expect(200);
      expect((list.body as AlarmRule[]).map((x) => x.id)).toContain(r.id);

      await request(http).get('/api/alarm-rules/no-es-uuid').set(bearer(token)).expect(400);
      await request(http)
        .patch('/api/alarm-rules/00000000-0000-4000-8000-0000000000aa')
        .set(bearer(token))
        .send({ threshold: 1 })
        .expect(404);
      await request(http).delete(`/api/alarm-rules/${r.id}`).set(bearer(token)).expect(204);
      await request(http).delete(`/api/alarm-rules/${r.id}`).set(bearer(token)).expect(404);
    });
  });

  describe('alarmas de extremo a extremo (Redis pub/sub -> motor -> REST)', () => {
    const publishTelemetry = async (level: number) => {
      await t.redis.publish(
        redisKeys.events('demo'),
        JSON.stringify({
          type: 'telemetry',
          plant: 'demo',
          asset: 'tk-01',
          ts: Date.now(),
          quality: 'good',
          values: { level },
        }),
      );
      await wait(60);
    };

    it('regla creada por API -> alarma activa -> ack -> cleared', async () => {
      const engineer = await t.tokenFor('engineer');
      const operator = await t.tokenFor('operator');
      const viewer = await t.tokenFor('viewer');

      const created = await request(http)
        .post('/api/alarm-rules')
        .set(bearer(engineer))
        .send({
          plant: 'demo',
          asset: 'tk-01',
          metric: 'level',
          operator: 'gt',
          threshold: 90,
          severity: 'critical',
          hysteresis: 5,
        })
        .expect(201);
      const ruleId = (created.body as AlarmRule).id;

      const channelMsgs: AlarmEvent[] = [];
      const listener = t.redis.duplicate();
      listener.on('message', (_c: string, m: string) =>
        channelMsgs.push(JSON.parse(m) as AlarmEvent),
      );
      await listener.subscribe(redisKeys.alarms('demo'));

      await publishTelemetry(50);
      let active = await request(http)
        .get('/api/alarms')
        .query({ state: 'active' })
        .set(bearer(viewer))
        .expect(200);
      expect(active.body).toEqual([]);

      await publishTelemetry(95);
      active = await request(http)
        .get('/api/alarms')
        .query({ state: 'active' })
        .set(bearer(viewer))
        .expect(200);
      const alarms = active.body as AlarmRecord[];
      expect(alarms).toHaveLength(1);
      expect(alarms[0]).toMatchObject({
        ruleId,
        asset: 'tk-01',
        state: 'active',
        acknowledged: false,
        value: 95,
      });
      const hash = await t.redis.hgetall(redisKeys.activeAlarms('demo'));
      expect(Object.keys(hash)).toEqual([`tk-01:level:${ruleId}`]);
      expect(channelMsgs.map((m) => m.state)).toEqual(['active']);

      // ack: viewer no puede, operator sí
      const id = alarms[0].id;
      await request(http).post(`/api/alarms/${id}/ack`).set(bearer(viewer)).expect(403);
      await request(http).post('/api/alarms/no-uuid/ack').set(bearer(operator)).expect(400);
      await request(http)
        .post('/api/alarms/00000000-0000-4000-8000-0000000000bb/ack')
        .set(bearer(operator))
        .expect(404);
      const acked = await request(http)
        .post(`/api/alarms/${id}/ack`)
        .set(bearer(operator))
        .expect(200);
      expect(acked.body).toMatchObject({ id, acknowledged: true });
      expect(typeof acked.body.acknowledgedBy).toBe('string');
      expect(typeof acked.body.acknowledgedAt).toBe('number');
      await wait(30);
      expect(channelMsgs.at(-1)).toMatchObject({ id, acknowledged: true, state: 'active' });

      // dentro de la banda muerta sigue activa; fuera de ella se normaliza
      await publishTelemetry(88);
      expect(
        (await request(http).get('/api/alarms').query({ state: 'active' }).set(bearer(viewer)))
          .body,
      ).toHaveLength(1);
      await publishTelemetry(70);
      const stillActive = await request(http)
        .get('/api/alarms')
        .query({ state: 'active' })
        .set(bearer(viewer))
        .expect(200);
      expect(stillActive.body).toEqual([]);
      const cleared = await request(http)
        .get('/api/alarms')
        .query({ state: 'cleared' })
        .set(bearer(viewer))
        .expect(200);
      expect(cleared.body).toHaveLength(1);
      expect(cleared.body[0]).toMatchObject({ id, state: 'cleared', acknowledged: true });
      expect(await t.redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({});

      await request(http)
        .get('/api/alarms')
        .query({ state: 'bogus' })
        .set(bearer(viewer))
        .expect(400);
      listener.disconnect();
    });
  });
});
