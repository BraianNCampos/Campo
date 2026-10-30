import type { AddressInfo } from 'node:net';
import { MODULE_IDS, redisKeys } from '@campo/shared';
import type { Role } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import type { AlarmRecord, AlarmRule } from '../src/alarms/alarm.types';
import { triangleGlb } from './support/glb';
import { createTestApp, TestApp } from './support/test-app';

/**
 * Matriz de aislamiento entre clientes (docs/architecture.md §11.1). Dos clientes, A y B, con datos de todo
 * tipo en cada uno. Para CADA endpoint existente:
 *  - un usuario de A (admin, engineer, operator, viewer) recibe 403 sobre recursos de B (o una lista sin B);
 *  - la MISMA operación sobre el recurso equivalente de A sí funciona para los roles que el contrato permite
 *    (control: el 403 es de cliente, no un artefacto del rol o de la petición);
 *  - un platform_admin accede a los dos.
 * Si se quita el filtro de cliente de un endpoint de lectura, esta matriz falla.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const U = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const ID = {
  ruleA: U(1),
  ruleB: U(2),
  alarmA: U(3),
  alarmB: U(4),
  modelA: U(5),
  modelB: U(6),
  sha: (c: string) => c.repeat(64),
};

type Level = 'viewer' | 'operator' | 'engineer' | 'admin' | 'platform';
const ROLES_BY_LEVEL: Record<Level, Role[]> = {
  viewer: ['admin', 'engineer', 'operator', 'viewer'],
  operator: ['admin', 'engineer', 'operator'], // ack de alarmas: engineer/operator (+ admin)
  engineer: ['admin', 'engineer'],
  admin: ['admin'],
  platform: [],
};

interface Case {
  name: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** Ruta sobre un recurso de B. */
  foreign: string;
  /** Ruta equivalente sobre un recurso de A (control). */
  own?: string;
  level: Level;
  body?: object;
  /** Cuerpo para el control sobre A (si difiere: apunta a un recurso de A). */
  ownBody?: object;
  /** Estado que obtiene platform_admin sobre B (y el control sobre A). */
  ok: number;
  /** Listado: la respuesta no debe contener ningún dato de B. */
  list?: boolean;
  upload?: boolean;
}

const newUser = (email: string, orgId: string) => ({
  email,
  password: 'una-clave-larga-1',
  role: 'viewer',
  orgId,
});
const rule = (plant: string) => ({
  plant,
  asset: 'tk-*',
  metric: 'level',
  operator: 'gt',
  threshold: 80,
  severity: 'warning',
});

const CASES: Case[] = [
  // plantas
  {
    name: 'GET /plants',
    method: 'get',
    foreign: '/api/plants',
    level: 'viewer',
    ok: 200,
    list: true,
  },
  {
    name: 'GET /plants?orgId=org-b',
    method: 'get',
    foreign: '/api/plants?orgId=org-b',
    level: 'viewer',
    ok: 200,
    list: true,
  },
  {
    name: 'POST /plants (orgId de B)',
    method: 'post',
    foreign: '/api/plants',
    own: '/api/plants',
    body: { id: 'nueva', name: 'Nueva', orgId: 'org-b' },
    ownBody: { id: 'nueva', name: 'Nueva' },
    level: 'admin',
    ok: 201,
  },
  {
    name: 'PATCH /plants/:plant',
    method: 'patch',
    foreign: '/api/plants/pb',
    own: '/api/plants/pa',
    body: { name: 'Otro' },
    level: 'admin',
    ok: 200,
  },
  {
    name: 'DELETE /plants/:plant',
    method: 'delete',
    foreign: '/api/plants/pb2',
    own: '/api/plants/pa2',
    level: 'admin',
    ok: 200,
  },
  {
    name: 'GET /plants/:plant/assets',
    method: 'get',
    foreign: '/api/plants/pb/assets',
    own: '/api/plants/pa/assets',
    level: 'viewer',
    ok: 200,
  },
  {
    name: 'GET /plants/:plant/state',
    method: 'get',
    foreign: '/api/plants/pb/state',
    own: '/api/plants/pa/state',
    level: 'viewer',
    ok: 200,
  },
  {
    name: 'GET /plants/:plant/limits',
    method: 'get',
    foreign: '/api/plants/pb/limits',
    own: '/api/plants/pa/limits',
    level: 'viewer',
    ok: 200,
  },
  {
    name: 'GET /plants/:plant/assets/:asset/history',
    method: 'get',
    foreign: '/api/plants/pb/assets/tk-b1/history?metric=level',
    own: '/api/plants/pa/assets/tk-a1/history?metric=level',
    level: 'viewer',
    ok: 200,
  },
  // activos
  {
    name: 'POST /plants/:plant/assets',
    method: 'post',
    foreign: '/api/plants/pb/assets',
    own: '/api/plants/pa/assets',
    body: { id: 'nuevo', name: 'N', type: 'tank' },
    level: 'engineer',
    ok: 201,
  },
  {
    name: 'PATCH /plants/:plant/assets/:asset',
    method: 'patch',
    foreign: '/api/plants/pb/assets/tk-b1',
    own: '/api/plants/pa/assets/tk-a1',
    body: { name: 'X' },
    level: 'engineer',
    ok: 200,
  },
  {
    name: 'DELETE /plants/:plant/assets/:asset',
    method: 'delete',
    foreign: '/api/plants/pb/assets/tk-b1',
    own: '/api/plants/pa/assets/tk-a1',
    level: 'engineer',
    ok: 200,
  },
  // modelos
  {
    name: 'GET /plants/:plant/models',
    method: 'get',
    foreign: '/api/plants/pb/models',
    own: '/api/plants/pa/models',
    level: 'viewer',
    ok: 200,
  },
  {
    name: 'POST /plants/:plant/models',
    method: 'post',
    foreign: '/api/plants/pb/models?name=x',
    own: '/api/plants/pa/models?name=x',
    upload: true,
    level: 'engineer',
    ok: 201,
  },
  {
    name: 'GET /models/:id',
    method: 'get',
    foreign: `/api/models/${ID.modelB}`,
    own: `/api/models/${ID.modelA}`,
    level: 'viewer',
    ok: 200,
  },
  {
    name: 'DELETE /plants/:plant/models/:id',
    method: 'delete',
    foreign: `/api/plants/pb/models/${ID.modelB}`,
    own: `/api/plants/pa/models/${ID.modelA}`,
    level: 'engineer',
    ok: 200,
  },
  // reglas
  {
    name: 'GET /alarm-rules',
    method: 'get',
    foreign: '/api/alarm-rules',
    level: 'engineer',
    ok: 200,
    list: true,
  },
  {
    name: 'GET /alarm-rules?plant=',
    method: 'get',
    foreign: '/api/alarm-rules?plant=pb',
    own: '/api/alarm-rules?plant=pa',
    level: 'engineer',
    ok: 200,
  },
  {
    name: 'GET /alarm-rules/:id',
    method: 'get',
    foreign: `/api/alarm-rules/${ID.ruleB}`,
    own: `/api/alarm-rules/${ID.ruleA}`,
    level: 'engineer',
    ok: 200,
  },
  {
    name: 'POST /alarm-rules',
    method: 'post',
    foreign: '/api/alarm-rules',
    own: '/api/alarm-rules',
    body: rule('pb'),
    ownBody: rule('pa'),
    level: 'engineer',
    ok: 201,
  },
  {
    name: 'PATCH /alarm-rules/:id',
    method: 'patch',
    foreign: `/api/alarm-rules/${ID.ruleB}`,
    own: `/api/alarm-rules/${ID.ruleA}`,
    body: { threshold: 50 },
    level: 'engineer',
    ok: 200,
  },
  {
    name: 'DELETE /alarm-rules/:id',
    method: 'delete',
    foreign: `/api/alarm-rules/${ID.ruleB}`,
    own: `/api/alarm-rules/${ID.ruleA}`,
    level: 'engineer',
    ok: 204,
  },
  // alarmas
  {
    name: 'GET /alarms',
    method: 'get',
    foreign: '/api/alarms',
    level: 'viewer',
    ok: 200,
    list: true,
  },
  {
    name: 'GET /alarms?state=active',
    method: 'get',
    foreign: '/api/alarms?state=active&limit=500',
    level: 'viewer',
    ok: 200,
    list: true,
  },
  {
    name: 'GET /alarms?plant=',
    method: 'get',
    foreign: '/api/alarms?plant=pb',
    own: '/api/alarms?plant=pa',
    level: 'viewer',
    ok: 200,
  },
  {
    name: 'POST /alarms/:id/ack',
    method: 'post',
    foreign: `/api/alarms/${ID.alarmB}/ack`,
    own: `/api/alarms/${ID.alarmA}/ack`,
    level: 'operator',
    ok: 200,
  },
  // usuarios
  { name: 'GET /users', method: 'get', foreign: '/api/users', level: 'admin', ok: 200, list: true },
  {
    name: 'GET /users?orgId=org-b',
    method: 'get',
    foreign: '/api/users?orgId=org-b',
    level: 'admin',
    ok: 200,
    list: true,
  },
  {
    name: 'POST /users (orgId de B)',
    method: 'post',
    foreign: '/api/users',
    own: '/api/users',
    body: newUser('nuevo@org-b.test', 'org-b'),
    ownBody: newUser('nuevo@org-a.test', 'org-a'),
    level: 'admin',
    ok: 201,
  },
  {
    name: 'PATCH /users/:id',
    method: 'patch',
    foreign: '/api/users/UB',
    own: '/api/users/UA',
    body: { active: false },
    level: 'admin',
    ok: 200,
  },
  {
    name: 'POST /users/:id/revoke',
    method: 'post',
    foreign: '/api/users/UB/revoke',
    own: '/api/users/UA/revoke',
    level: 'admin',
    ok: 200,
  },
  {
    name: 'PUT /users/:id/plants',
    method: 'put',
    foreign: '/api/users/UB/plants',
    own: '/api/users/UA/plants',
    body: { plants: [] },
    level: 'admin',
    ok: 200,
  },
  // auditoría
  {
    name: 'GET /audit',
    method: 'get',
    foreign: '/api/audit?limit=200',
    level: 'admin',
    ok: 200,
    list: true,
  },
  {
    name: 'GET /audit?orgId=&org=',
    method: 'get',
    foreign: '/api/audit?limit=200&orgId=org-b&org=org-b',
    level: 'admin',
    ok: 200,
    list: true,
  },
  // plataforma: ningún rol de cliente
  { name: 'GET /orgs', method: 'get', foreign: '/api/orgs', level: 'platform', ok: 200 },
  {
    name: 'POST /orgs',
    method: 'post',
    foreign: '/api/orgs',
    body: { id: 'org-z', name: 'Z', modules: [] },
    level: 'platform',
    ok: 201,
  },
  { name: 'GET /orgs/:id', method: 'get', foreign: '/api/orgs/org-b', level: 'platform', ok: 200 },
  {
    name: 'PATCH /orgs/:id',
    method: 'patch',
    foreign: '/api/orgs/org-b',
    body: { name: 'Nuevo' },
    level: 'platform',
    ok: 200,
  },
  {
    name: 'DELETE /orgs/:id',
    method: 'delete',
    foreign: '/api/orgs/org-vacia',
    level: 'platform',
    ok: 200,
  },
  {
    name: 'POST /orgs/:id/admins',
    method: 'post',
    foreign: '/api/orgs/org-b/admins',
    body: { email: 'adm2@org-b.test', password: 'una-clave-larga-1' },
    level: 'platform',
    ok: 201,
  },
];

describe('Aislamiento entre clientes: matriz endpoint x rol (e2e)', () => {
  let t: TestApp;
  let http: App;
  let wsBase: string;
  const tokens = new Map<string, string>(); // `${org}:${role}` -> JWT
  const userIds = new Map<string, string>();
  let platform: string;
  let snapshot: Map<string, string>;
  const MARKERS_B = ['pb', 'tk-b1', ID.ruleB, ID.alarmB, ID.modelB, 'org-b.test', 'org-b'];

  beforeAll(async () => {
    t = await createTestApp({ authCacheTtlMs: 0, wsRevalidateMs: 100 });
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer() as App;
    wsBase = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/ws`;
    await t.makeOrg('org-a', [...MODULE_IDS], ['pa', 'pa2']);
    await t.makeOrg('org-b', [...MODULE_IDS], ['pb', 'pb2']);
    await t.makeOrg('org-vacia', ['tanks']);
    for (const [org, plant] of [
      ['org-a', 'pa'],
      ['org-b', 'pb'],
    ] as const) {
      for (const role of ['admin', 'engineer', 'operator', 'viewer'] as const) {
        const u = await t.makeUser(
          `${role}@${org}.test`,
          role,
          role === 'admin' ? [] : [plant],
          org,
        );
        tokens.set(`${org}:${role}`, u.token);
        userIds.set(`${org}:${role}`, u.id);
      }
      await t.redis.hset(
        redisKeys.state(plant),
        plant === 'pa' ? 'tk-a1' : 'tk-b1',
        JSON.stringify({ ts: 1, values: { level: 10 }, quality: 'good' }),
      );
    }
    platform = await t.tokenFor('platform_admin');
    snapshot = new Map(t.users.users.map((u) => [u.id, JSON.stringify(u)]));
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** Estado inicial determinista de los recursos (cada test parte de él). */
  beforeEach(async () => {
    const asset = (plant: string, id: string) => ({
      plant,
      id,
      name: id,
      type: 'tank' as const,
      model3dRef: null,
      metadata: {},
    });
    t.assets.assets.splice(0, t.assets.assets.length, asset('pa', 'tk-a1'), asset('pb', 'tk-b1'));
    t.plants.names.clear();
    t.plants.orgs.clear();
    for (const [p, o] of [
      ['pa', 'org-a'],
      ['pa2', 'org-a'],
      ['pb', 'org-b'],
      ['pb2', 'org-b'],
    ])
      t.plants.register(p, o);
    const mkRule = (id: string, plantId: string): AlarmRule => ({
      id,
      plant: plantId,
      asset: 'tk-*',
      metric: 'level',
      operator: 'gt',
      threshold: 90,
      severity: 'critical',
      forSeconds: 0,
      hysteresis: 0,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    t.rules.rules.clear();
    t.rules.rules.set(ID.ruleA, mkRule(ID.ruleA, 'pa'));
    t.rules.rules.set(ID.ruleB, mkRule(ID.ruleB, 'pb'));
    const mkAlarm = (id: string, plantId: string, ruleId: string): AlarmRecord => ({
      type: 'alarm',
      id,
      ruleId,
      plant: plantId,
      asset: plantId === 'pa' ? 'tk-a1' : 'tk-b1',
      metric: 'level',
      severity: 'critical',
      state: 'active',
      value: 99,
      threshold: 90,
      ts: 1,
      message: `alarma de ${plantId}`,
      acknowledged: false,
    });
    t.alarms.alarms.clear();
    t.alarms.alarms.set(ID.alarmA, mkAlarm(ID.alarmA, 'pa', ID.ruleA));
    t.alarms.alarms.set(ID.alarmB, mkAlarm(ID.alarmB, 'pb', ID.ruleB));
    t.models.rows.splice(0, t.models.rows.length);
    for (const [id, plantId, c] of [
      [ID.modelA, 'pa', 'a'],
      [ID.modelB, 'pb', 'b'],
    ] as const) {
      t.models.rows.push({
        id,
        plant: plantId,
        name: `m-${plantId}`,
        size: 1,
        sha256: ID.sha(c),
        createdAt: 1,
        data: triangleGlb(),
        createdBy: null,
      });
    }
    t.audit.entries.splice(0, t.audit.entries.length);
    t.audit.orgOfEntry.clear();
    for (const [org, plantId] of [
      ['org-a', 'pa'],
      ['org-b', 'pb'],
    ] as const) {
      await t.audit.insert({
        actorId: null,
        actorEmail: `x@${org}.test`,
        action: 'plant.update',
        target: `plant:${plantId}`,
        orgId: org,
        detail: {},
      });
    }
    // usuarios: los modifican los casos de plataforma (PATCH/revoke/plants); se restauran
    for (const extra of t.users.users.filter((u) => !snapshot.has(u.id)))
      t.users.users.splice(t.users.users.indexOf(extra), 1);
    for (const u of t.users.users) Object.assign(u, JSON.parse(snapshot.get(u.id) as string));
  });

  const fill = (path: string, org: 'org-a' | 'org-b') =>
    path
      .replace('/UB', `/${userIds.get('org-b:viewer')}`)
      .replace('/UA', `/${userIds.get('org-a:viewer')}`)
      .replace(org === 'org-a' ? 'unused' : 'unused', '');

  const call = (c: Case, path: string, token: string, own = false) => {
    const r = request(http)[c.method](fill(path, 'org-b')).set(bearer(token));
    if (c.upload) return r.set('Content-Type', 'model/gltf-binary').send(triangleGlb());
    const body = own ? (c.ownBody ?? c.body) : c.body;
    return body ? r.send(body) : r;
  };
  const leaks = (body: unknown) => {
    const text = JSON.stringify(body);
    return MARKERS_B.filter((m) => text.includes(m));
  };

  describe.each(['admin', 'engineer', 'operator', 'viewer'] as const)(
    'usuario %s del cliente A',
    (role) => {
      it.each(CASES)('$name', async (c) => {
        const token = tokens.get(`org-a:${role}`) as string;
        const allowedByRole = ROLES_BY_LEVEL[c.level].includes(role);

        // 1) sobre B: 403 siempre; los listados permitidos devuelven 200 pero sin datos de B
        const res = await call(c, c.foreign, token);
        if (c.list && allowedByRole) {
          expect(res.status).toBe(200);
          expect(leaks(res.body)).toEqual([]);
        } else {
          expect(res.status).toBe(403);
          expect(leaks(res.body)).toEqual([]); // el mensaje de error tampoco revela nada
        }

        // 2) control: lo mismo sobre A funciona si el rol lo permite (y si no, es 403 por rol)
        if (c.own) {
          const own = await call(c, c.own, token, true);
          expect([c.name, own.status]).toEqual([c.name, allowedByRole ? c.ok : 403]);
        }
        if (c.list && allowedByRole) {
          const own = await call(c, c.foreign, token);
          expect(JSON.stringify(own.body)).toMatch(/pa|org-a|tk-a1/); // el listado de A no está vacío
        }
      });
    },
  );

  describe('platform_admin accede a los dos clientes', () => {
    it.each(CASES)('$name', async (c) => {
      const res = await call(c, c.foreign, platform);
      expect([c.name, res.status]).toEqual([c.name, c.ok]);
      if (c.list) {
        const text = JSON.stringify(res.body);
        expect(text).toMatch(/org-b|pb|tk-b1/); // lo de B
        // y, si no está filtrado por cliente, también lo de A
        if (!c.foreign.includes('org-b')) expect(text).toMatch(/org-a|pa|tk-a1/);
      }
    });

    it('los listados incluyen a la vez datos de A y de B', async () => {
      for (const path of [
        '/api/plants',
        '/api/alarms',
        '/api/alarm-rules',
        '/api/users',
        '/api/audit?limit=200',
      ]) {
        const text = JSON.stringify(
          (await request(http).get(path).set(bearer(platform)).expect(200)).body,
        );
        expect([
          path,
          text.includes('pa') || text.includes('org-a'),
          text.includes('pb') || text.includes('org-b'),
        ]).toEqual([path, true, true]);
      }
      const plants = (
        await request(http).get('/api/plants?orgId=org-b').set(bearer(platform)).expect(200)
      ).body as { id: string; orgId: string }[];
      expect(plants.map((p) => p.id)).toEqual(['pb', 'pb2']);
      expect(plants.every((p) => p.orgId === 'org-b')).toBe(true);
    });
  });

  describe('lo que A ve de sí mismo', () => {
    it('GET /me lleva sólo su cliente; GET /plants sólo sus plantas con orgId', async () => {
      const me = await request(http)
        .get('/api/me')
        .set(bearer(tokens.get('org-a:admin') as string))
        .expect(200);
      expect(me.body.org).toMatchObject({ id: 'org-a' });
      const plants = (
        await request(http)
          .get('/api/plants')
          .set(bearer(tokens.get('org-a:admin') as string))
          .expect(200)
      ).body;
      expect(plants).toEqual([
        { id: 'pa', name: 'pa', assets: 1, orgId: 'org-a' },
        { id: 'pa2', name: 'pa2', assets: 0, orgId: 'org-a' },
      ]);
      const viewer = (
        await request(http)
          .get('/api/plants')
          .set(bearer(tokens.get('org-a:viewer') as string))
          .expect(200)
      ).body;
      expect((viewer as { id: string }[]).map((p) => p.id)).toEqual(['pa']);
    });

    it('el 403 de una planta de B es idéntico al de una planta inexistente (no se puede adivinar)', async () => {
      const token = tokens.get('org-a:admin') as string;
      const real = await request(http).get('/api/plants/pb/assets').set(bearer(token));
      const fake = await request(http).get('/api/plants/no-existe-nada/assets').set(bearer(token));
      expect([real.status, real.body]).toEqual([fake.status, fake.body]);
    });
  });

  describe('un admin de A no puede escalar privilegios', () => {
    const admin = () => tokens.get('org-a:admin') as string;
    const send = (method: 'post' | 'patch' | 'put', path: string, body: object, token = admin()) =>
      request(http)[method](path).set(bearer(token)).send(body);

    it('no crea platform_admin ni usuarios en B', async () => {
      await send('post', '/api/users', {
        email: 'p@x.test',
        password: 'una-clave-larga-1',
        role: 'platform_admin',
      }).expect(403);
      await send('post', '/api/users', {
        email: 'p@x.test',
        password: 'una-clave-larga-1',
        role: 'platform_admin',
        orgId: 'org-a',
      }).expect(403);
      await send('post', '/api/users', {
        email: 'p@x.test',
        password: 'una-clave-larga-1',
        role: 'admin',
        orgId: 'org-b',
      }).expect(403);
      expect(t.users.users.some((u) => u.email === 'p@x.test')).toBe(false);
    });

    it('no se otorga platform_admin a sí mismo ni a otro, ni cambia su cliente (el campo no existe -> 400)', async () => {
      const self = userIds.get('org-a:admin');
      const other = userIds.get('org-a:viewer');
      await send('patch', `/api/users/${self}`, { role: 'platform_admin' }).expect(403);
      await send('patch', `/api/users/${other}`, { role: 'platform_admin' }).expect(403);
      await send('patch', `/api/users/${self}`, { orgId: 'org-b' }).expect(400);
      await send('patch', `/api/users/${self}`, { org: 'org-b' }).expect(400);
      expect(t.users.users.find((u) => u.id === self)).toMatchObject({
        role: 'admin',
        orgId: 'org-a',
      });
      expect(t.users.users.find((u) => u.id === other)).toMatchObject({
        role: 'viewer',
        orgId: 'org-a',
      });
    });

    it('no asigna plantas de B (ni inexistentes) a sus usuarios', async () => {
      const other = userIds.get('org-a:viewer');
      await send('put', `/api/users/${other}/plants`, { plants: ['pb'] }).expect(403);
      await send('put', `/api/users/${other}/plants`, { plants: ['pa', 'pb'] }).expect(403);
      await send('put', `/api/users/${other}/plants`, { plants: ['inexistente'] }).expect(403);
      await send('post', '/api/users', {
        email: 'q@x.test',
        password: 'una-clave-larga-1',
        role: 'viewer',
        plants: ['pb'],
      }).expect(403);
      expect(t.users.users.find((u) => u.id === other)?.plants).toEqual(['pa']);
      await send('put', `/api/users/${other}/plants`, { plants: ['pa', 'pa2'] }).expect(200);
    });

    it('no mueve una regla propia a una planta de B', async () => {
      await send('patch', `/api/alarm-rules/${ID.ruleA}`, { plant: 'pb' }).expect(403);
      expect(t.rules.rules.get(ID.ruleA)?.plant).toBe('pa');
    });

    it('ni siquiera un platform_admin saca una regla de su cliente (400)', async () => {
      await send('patch', `/api/alarm-rules/${ID.ruleA}`, { plant: 'pb' }, platform).expect(400);
      expect(t.rules.rules.get(ID.ruleA)?.plant).toBe('pa');
      await send('patch', `/api/alarm-rules/${ID.ruleA}`, { plant: 'pa2' }, platform).expect(200);
    });

    it('no ve la auditoría de B aunque pida el filtro; no toca los clientes', async () => {
      for (const q of ['', '&orgId=org-b', '&org=org-b', '&orgId=org-b&org=org-b']) {
        const res = await request(http)
          .get(`/api/audit?limit=200${q}`)
          .set(bearer(admin()))
          .expect(200);
        const text = JSON.stringify(res.body);
        expect([q, text.includes('org-b'), text.includes('pb')]).toEqual([q, false, false]);
        expect(text).toContain('pa');
      }
      await request(http).get('/api/orgs').set(bearer(admin())).expect(403);
      await send('patch', '/api/orgs/org-a', { modules: [] }).expect(403);
      await send('patch', '/api/orgs/org-a', { active: false }).expect(403);
      await request(http).delete('/api/orgs/org-a').set(bearer(admin())).expect(403);
      expect(t.orgs.orgs.get('org-a')).toMatchObject({ active: true });
    });

    it('un id de B nunca se crea en una planta propia: los activos y reglas de A se quedan en A', async () => {
      await send('post', '/api/plants/pa/assets', { id: 'x1', name: 'x', type: 'tank' }).expect(
        201,
      );
      expect(t.assets.assets.filter((a) => a.id === 'x1').map((a) => a.plant)).toEqual(['pa']);
      await request(http)
        .get('/api/models/' + ID.modelB)
        .set(bearer(admin()))
        .expect(403);
      await request(http)
        .delete(`/api/plants/pa/models/${ID.modelB}`)
        .set(bearer(admin()))
        .expect(404); // no es de pa: ni existe para él
      expect(t.models.rows.some((m) => m.id === ID.modelB)).toBe(true);
    });
  });

  describe('WebSocket', () => {
    const open = (plant: string, token: string) =>
      new Promise<{ closed: Promise<number>; messages: { type: string; plant?: string }[] }>(
        (resolve, reject) => {
          const ws = new WebSocket(`${wsBase}?plant=${plant}&token=${token}`);
          const messages: { type: string; plant?: string }[] = [];
          ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString())));
          const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
          ws.on('open', () => resolve({ closed, messages }));
          ws.on('error', reject);
        },
      );

    it.each(['admin', 'engineer', 'operator', 'viewer'] as const)(
      '%s de A: una planta de B cierra con 4403 y no recibe nada',
      async (role) => {
        const s = await open('pb', tokens.get(`org-a:${role}`) as string);
        expect(await s.closed).toBe(4403);
        expect(s.messages).toEqual([]);
      },
    );

    it('platform_admin se conecta a las plantas de ambos y sólo recibe la suya', async () => {
      const a = await open('pa', platform);
      const b = await open('pb', platform);
      await sleep(100);
      expect(a.messages.map((m) => m.type)).toEqual(['snapshot']);
      expect(a.messages[0].plant).toBe('pa');
      expect(b.messages[0].plant).toBe('pb');
      await t.redis.publish(
        redisKeys.events('pb'),
        JSON.stringify({
          type: 'telemetry',
          plant: 'pb',
          asset: 'tk-b1',
          ts: 1,
          quality: 'good',
          values: { level: 5 },
        }),
      );
      await sleep(250);
      expect(a.messages.every((m) => m.plant === 'pa')).toBe(true);
      expect(b.messages.some((m) => m.type === 'telemetry')).toBe(true);
    });
  });
});
