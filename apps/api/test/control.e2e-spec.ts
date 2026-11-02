import type { AddressInfo } from 'node:net';
import { redisKeys } from '@campo/shared';
import type { AssetDef, AuditEntry, InterlockItem, Order, OrderPreview } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { createTestApp, TestApp } from './support/test-app';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg {
  type: string;
  [k: string]: unknown;
}
function open(url: string): Promise<{ ws: WebSocket; messages: Msg[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Msg[] = [];
    ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString()) as Msg));
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('error', reject);
  });
}
const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condición');
    await sleep(10);
  }
};

/** Tags, tipos nuevos, control de llenado, setpoints y sincronización de reloj (docs/architecture.md §13-14). */
describe('Control de llenado, tags y reloj (e2e)', () => {
  let t: TestApp;
  let http: App;
  let wsBase: string;
  let admin: string;
  let engineer: string;
  let operator: string;
  let viewer: string;

  beforeAll(async () => {
    t = await createTestApp({ wsRevalidateMs: 100, authCacheTtlMs: 0 });
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer() as App;
    wsBase = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/ws`;
    [admin, engineer, operator, viewer] = await Promise.all(
      (['admin', 'engineer', 'operator', 'viewer'] as const).map((r) => t.tokenFor(r)),
    );
  });
  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    t.orders.orders.clear();
    t.bus.published.length = 0;
    t.bus.isConfigured = true;
    t.bus.down = false;
    for (const key of await t.redis.keys('campo:control:*')) await t.redis.del(key);
    const tk = t.assets.assets.find((a) => a.id === 'tk-01');
    if (tk) {
      tk.tag = 'TNK-101';
      tk.metadata = { control: { enabled: true, minTarget: 10, maxTarget: 90 } };
    }
    await online('tk-01', 40);
  });

  const online = (asset: string, level: number) =>
    t.redis.hset(
      redisKeys.state('demo'),
      asset,
      JSON.stringify({ ts: Date.now(), values: { level }, quality: 'good' }),
    );
  const api = {
    get: (p: string, token: string) => request(http).get(p).set(bearer(token)),
    post: (p: string, token: string) => request(http).post(p).set(bearer(token)),
    put: (p: string, token: string) => request(http).put(p).set(bearer(token)),
    patch: (p: string, token: string) => request(http).patch(p).set(bearer(token)),
  };
  const base = '/api/plants/demo/assets/tk-01';
  const preview = (token: string, body: object) =>
    api.post(`${base}/commands/preview`, token).send(body);
  const execute = (token: string, confirmId: string) =>
    api.post(`${base}/commands`, token).send({ confirmId });
  /** Vista previa + confirmación; devuelve la orden. */
  async function order(token: string, body: object): Promise<Order> {
    const p = (await preview(token, body).expect(200)).body as OrderPreview;
    expect(p.blocked).toBeNull();
    return (await execute(token, p.confirmId).expect(201)).body as Order;
  }

  describe('órdenes: flujo completo', () => {
    it('vista previa -> confirmación -> MQTT -> acks -> estados y WebSocket', async () => {
      const ws = await open(`${wsBase}?plant=demo&token=${viewer}`);
      await until(() => ws.messages.length >= 1); // snapshot
      const p = (await preview(operator, { command: 'fill', target: 80 }).expect(200))
        .body as OrderPreview;
      expect(p).toMatchObject({
        blocked: null,
        summary: expect.stringContaining('TNK-101') as string,
      });
      expect(t.bus.published).toHaveLength(0); // la vista previa no envía nada
      const o = (await execute(operator, p.confirmId).expect(201)).body as Order;
      expect(o).toMatchObject({ command: 'fill', target: 80, status: 'pending', asset: 'tk-01' });
      expect(t.bus.last()).toMatchObject({
        topic: 'campo/v1/demo/tk-01/cmd',
        payload: { id: o.id, command: 'fill', target: 80, by: 'operator@campo.test' },
      });
      // el equipo responde
      t.bus.ack('demo', 'tk-01', { id: o.id, status: 'accepted' });
      await sleep(30);
      t.bus.ack('demo', 'tk-01', { id: o.id, status: 'running' });
      await sleep(30);
      t.bus.ack('demo', 'tk-01', { id: o.id, status: 'done' });
      await until(() => ws.messages.filter((m) => m.type === 'order').length >= 4);
      expect(
        ws.messages.filter((m) => m.type === 'order').map((m) => (m['order'] as Order).status),
      ).toEqual(['pending', 'accepted', 'running', 'done']);
      // el registro lo ve cualquier rol con acceso a la planta, con el asset y el estado final
      for (const token of [viewer, operator, engineer, admin]) {
        const list = (await api.get('/api/plants/demo/orders', token).expect(200)).body as Order[];
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: o.id, status: 'done', tag: 'TNK-101' });
        expect(JSON.stringify(list)).not.toContain('orgId');
      }
      // auditoría: order.create y order.status (equipo, sin actor)
      const audit = (await api.get('/api/audit?limit=200', admin).expect(200)).body as AuditEntry[];
      expect(audit.filter((e) => e.action === 'order.create')).toHaveLength(1);
      expect(
        audit
          .filter((e) => e.action === 'order.status')
          .map((e) => e.detail['status'])
          .sort(),
      ).toEqual(['accepted', 'done', 'running']);
      expect(audit.find((e) => e.action === 'order.create')).toMatchObject({
        actorEmail: 'operator@campo.test',
        orgId: 'campos-demo',
      });
      ws.ws.close();
    });

    it('viewer no puede ordenar ni consultar enclavamientos (403) pero sí leer el registro; sin token 401', async () => {
      await preview(viewer, { command: 'stop' }).expect(403);
      await execute(viewer, '00000000-0000-4000-8000-000000000000').expect(403);
      await api.get(`${base}/interlocks`, viewer).expect(403);
      await api.post('/api/orders/00000000-0000-4000-8000-000000000000/cancel', viewer).expect(403);
      await api.get('/api/plants/demo/orders', viewer).expect(200);
      await request(http).post(`${base}/commands/preview`).send({ command: 'stop' }).expect(401);
      await request(http).get('/api/plants/demo/orders').expect(401);
    });

    it.each(['operator', 'engineer', 'admin', 'platform_admin'] as const)(
      '%s puede ordenar',
      async (role) => {
        const token = await t.tokenFor(role);
        await order(token, { command: 'stop' });
        expect(t.bus.last().payload).toMatchObject({ command: 'stop' });
      },
    );

    it('validación: comando/objetivo inválidos 400, campos de más 400, confirmId no UUID 400, activo inexistente 404', async () => {
      for (const body of [
        {},
        { command: 'explode' },
        { command: 'fill' },
        { command: 'fill', target: 100 },
        { command: 'fill', target: '80' },
        { command: 'stop', target: 5 },
        { command: 'start' }, // bomba, no tanque
        { command: 'fill', target: 80, extra: 1 },
      ]) {
        await preview(operator, body).expect(400);
      }
      await execute(operator, 'no-es-uuid').expect(400);
      await api
        .post(`${base}/commands`, operator)
        .send({ confirmId: '00000000-0000-4000-8000-000000000000', otro: 1 })
        .expect(400);
      await api
        .post('/api/plants/demo/assets/nada/commands/preview', operator)
        .send({ command: 'stop' })
        .expect(404);
      expect(t.bus.published).toHaveLength(0);
    });

    it('la vista previa bloqueada informa el motivo sin confirmId; la confirmación vieja da 409 con el código del enclavamiento', async () => {
      const p = (await preview(operator, { command: 'fill', target: 95 }).expect(200))
        .body as OrderPreview;
      expect(p.blocked).toContain('fuera del rango');
      expect(p.confirmId).toBe('');
      const fresh = (await preview(operator, { command: 'fill', target: 80 }).expect(200))
        .body as OrderPreview;
      await t.redis.hdel(redisKeys.state('demo'), 'tk-01');
      const r = await execute(operator, fresh.confirmId).expect(409);
      expect(r.body).toMatchObject({ error: 'device_offline' });
      await online('tk-01', 40);
      const used = await execute(operator, fresh.confirmId).expect(409); // ya quemado
      expect(used.body).toMatchObject({ error: 'invalid_confirm' });
      expect(t.bus.published).toHaveLength(0);
    });

    it('una orden en curso -> 409 order_in_progress; el stop la reemplaza; cancelar envía stop', async () => {
      const o = await order(operator, { command: 'fill', target: 80 });
      const p = (await preview(operator, { command: 'drain', target: 20 }).expect(200))
        .body as OrderPreview;
      expect(p.blocked).toContain('orden en curso');
      const c = (await api.post(`/api/orders/${o.id}/cancel`, operator).expect(200)).body as Order;
      expect(c).toMatchObject({ id: o.id, status: 'cancelled' });
      expect(t.bus.last().payload).toMatchObject({ command: 'stop' });
      await api.post(`/api/orders/${o.id}/cancel`, operator).expect(409);
      const list = (await api.get('/api/plants/demo/orders?status=cancelled', viewer).expect(200))
        .body as Order[];
      expect(list.map((x) => x.id)).toEqual([o.id]);
    });

    it('registro: filtros asset/status/limit/before validados', async () => {
      await order(operator, { command: 'stop' });
      await api.get('/api/plants/demo/orders?status=raro', viewer).expect(400);
      await api.get('/api/plants/demo/orders?limit=0', viewer).expect(400);
      await api.get('/api/plants/demo/orders?limit=201', viewer).expect(400);
      await api.get('/api/plants/demo/orders?asset=MAL ID', viewer).expect(400);
      await api.get('/api/plants/demo/orders?before=abc', viewer).expect(400);
      expect(
        (await api.get('/api/plants/demo/orders?asset=pump-01', viewer).expect(200)).body,
      ).toEqual([]);
      expect(
        (await api.get('/api/plants/demo/orders?limit=1&before=1', viewer).expect(200)).body,
      ).toEqual([]);
    });

    it('interlocks: ítems para operator+; con command+target incluye los del comando', async () => {
      const items = (await api.get(`${base}/interlocks`, operator).expect(200))
        .body as InterlockItem[];
      expect(items.map((i) => i.id)).toEqual([
        'broker',
        'module',
        'enabled',
        'online',
        'idle',
        'no_hh',
      ]);
      expect(items.every((i) => i.ok)).toBe(true);
      const withCmd = (
        await api.get(`${base}/interlocks?command=fill&target=95`, engineer).expect(200)
      ).body as InterlockItem[];
      expect(withCmd.find((i) => i.id === 'target_range')).toMatchObject({ ok: false });
      await api.get(`${base}/interlocks?command=boom`, operator).expect(400);
    });
  });

  describe('disponibilidad y módulo', () => {
    it('sin MQTT_URL: 503 control_unavailable en vista previa, confirmación y cancelación; el registro sigue legible', async () => {
      const o = await order(operator, { command: 'fill', target: 80 });
      t.bus.isConfigured = false;
      for (const res of [
        await preview(operator, { command: 'stop' }),
        await execute(operator, '00000000-0000-4000-8000-000000000000'),
        await api.post(`/api/orders/${o.id}/cancel`, operator),
      ]) {
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ error: 'control_unavailable' });
      }
      await api.get('/api/plants/demo/orders', viewer).expect(200);
      expect(
        ((await api.get(`${base}/interlocks`, operator).expect(200)).body as InterlockItem[])[0],
      ).toMatchObject({
        id: 'broker',
        ok: false,
      });
    });

    it('broker caído al publicar: 503 y la orden queda failed (el activo se libera)', async () => {
      const p = (await preview(operator, { command: 'fill', target: 80 }).expect(200))
        .body as OrderPreview;
      t.bus.down = true;
      const r = await execute(operator, p.confirmId).expect(503);
      expect(r.body).toMatchObject({ error: 'control_unavailable' });
      const list = (await api.get('/api/plants/demo/orders', viewer).expect(200)).body as Order[];
      expect(list[0]).toMatchObject({ status: 'failed' });
    });

    it('cliente sin el módulo control: 403 module_disabled (el resto de la API sigue igual); los interlocks lo muestran', async () => {
      await t.makeOrg('solo-tanques', ['tanks'], ['pt']);
      t.assets.assets.push({
        plant: 'pt',
        id: 'tk-a',
        name: 'A',
        type: 'tank',
        model3dRef: null,
        tag: 'TNK-101',
        metadata: { control: { enabled: true } },
      });
      const op = (await t.makeUser('op@solo.test', 'operator', ['pt'], 'solo-tanques')).token;
      const r = await api
        .post('/api/plants/pt/assets/tk-a/commands/preview', op)
        .send({ command: 'stop' })
        .expect(403);
      expect(r.body).toMatchObject({ error: 'module_disabled', module: 'control' });
      await api
        .post('/api/plants/pt/assets/tk-a/commands', op)
        .send({ confirmId: '00000000-0000-4000-8000-000000000000' })
        .expect(403);
      const items = (await api.get('/api/plants/pt/assets/tk-a/interlocks', op).expect(200))
        .body as InterlockItem[];
      expect(items.find((i) => i.id === 'module')).toMatchObject({ ok: false });
      await api.get('/api/plants/pt/orders', op).expect(200);
      expect(t.bus.published).toHaveLength(0);
      // el personal de plataforma le activa el módulo y funciona
      const platform = await t.tokenFor('platform_admin');
      await api
        .patch('/api/orgs/solo-tanques', platform)
        .send({ modules: ['tanks', 'control'] })
        .expect(200);
      await t.redis.hset(
        redisKeys.state('pt'),
        'tk-a',
        JSON.stringify({ ts: Date.now(), values: { level: 40 }, quality: 'good' }),
      );
      await api
        .post('/api/plants/pt/assets/tk-a/commands/preview', op)
        .send({ command: 'fill', target: 60 })
        .expect(200);
    });

    it('control es un módulo válido de clientes (alta y edición) y un módulo desconocido sigue siendo 400', async () => {
      const platform = await t.tokenFor('platform_admin');
      const created = await api
        .post('/api/orgs', platform)
        .send({ id: 'con-control', name: 'C', modules: ['tanks', 'control'] })
        .expect(201);
      expect((created.body as { modules: string[] }).modules).toEqual(['tanks', 'control']);
      await api
        .post('/api/orgs', platform)
        .send({ id: 'sin', name: 'S', modules: ['tanks'] })
        .expect(201);
      await api
        .patch('/api/orgs/sin', platform)
        .send({ modules: ['control'] })
        .expect(200);
      await api
        .patch('/api/orgs/sin', platform)
        .send({ modules: ['control', 'nada'] })
        .expect(400);
    });
  });

  describe('catálogo: tags, tipos nuevos y metadata.control', () => {
    const create = (token: string, body: object) =>
      api.post('/api/plants/demo/assets', token).send(body);

    it('el tag se normaliza a mayúsculas, viaja en el catálogo y es único por planta (409)', async () => {
      const r = await create(engineer, {
        id: 'tk-20',
        name: 'T20',
        type: 'tank',
        tag: ' tnk-120 ',
      }).expect(201);
      expect((r.body as AssetDef).tag).toBe('TNK-120');
      const list = (await api.get('/api/plants/demo/assets', viewer).expect(200))
        .body as AssetDef[];
      expect(list.find((a) => a.id === 'tk-20')?.tag).toBe('TNK-120');
      await create(engineer, { id: 'tk-21', name: 'T21', type: 'tank', tag: 'TNK-120' }).expect(
        409,
      );
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer)
        .send({ tag: 'tnk-120' })
        .expect(409);
      await api
        .patch('/api/plants/demo/assets/tk-20', engineer)
        .send({ tag: 'TNK-120' })
        .expect(200); // el suyo
      const cleared = await api
        .patch('/api/plants/demo/assets/tk-20', engineer)
        .send({ tag: null })
        .expect(200);
      expect((cleared.body as AssetDef).tag).toBeNull();
    });

    it.each(['TNK-1', 'ABC-123', 'TNK-12345', 'TNK_123', 'tnk 123', '', 'TNK-123AB', 5])(
      'tag inválido %p -> 400',
      async (tag) => {
        await create(engineer, { id: 'tk-30', name: 'T', type: 'tank', tag }).expect(400);
      },
    );

    it('tags válidos: sufijo de letra, 3-4 dígitos y todos los prefijos', async () => {
      let n = 400;
      for (const tag of [
        'TNK-401A',
        'PMP-1234',
        'VLV-402',
        'MTR-403',
        'XMTR-404',
        'PID-405',
        'COMP-406',
        'CONV-407',
      ]) {
        await create(engineer, { id: `a-${n++}`, name: 'x', type: 'sensor', tag }).expect(201);
      }
    });

    it('silo, conveyor y structure se crean (módulos tanks/machines; structure sin módulo) y el operator no puede', async () => {
      await create(engineer, {
        id: 'silo-9',
        name: 'S',
        type: 'silo',
        tag: 'TNK-309',
        metadata: { capacityM3: 120 },
      }).expect(201);
      await create(engineer, { id: 'conv-9', name: 'C', type: 'conveyor', tag: 'CONV-109' }).expect(
        201,
      );
      await create(engineer, {
        id: 'nave-9',
        name: 'N',
        type: 'structure',
        metadata: { layout: { x: 0, z: 0 } },
      }).expect(201);
      await create(operator, { id: 'silo-8', name: 'S', type: 'silo' }).expect(403);
      await create(engineer, { id: 'x-1', name: 'S', type: 'boiler' }).expect(400);
    });

    it('metadata.control: engineer+ la edita y se valida; operator no; el cambio de habilitación se audita', async () => {
      const good = {
        control: { enabled: true, minTarget: 10, maxTarget: 90, maxDurationMinutes: 60 },
      };
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer)
        .send({ metadata: good })
        .expect(200);
      await api
        .patch('/api/plants/demo/assets/tk-01', operator)
        .send({ metadata: good })
        .expect(403);
      for (const control of [
        { enabled: 'si' },
        { enabled: true, minTarget: 90, maxTarget: 10 },
        { enabled: true, maxTarget: 120 },
        { enabled: true, maxDurationMinutes: 0 },
        { enabled: true, raro: 1 },
        true,
      ]) {
        await api
          .patch('/api/plants/demo/assets/tk-01', engineer)
          .send({ metadata: { control } })
          .expect(400);
      }
      const audit = (await api.get('/api/audit?limit=200&action=asset.update', admin).expect(200))
        .body as AuditEntry[];
      expect(audit[0].detail).toMatchObject({ controlEnabled: true });
    });
  });

  describe('setpoints (PUT /api/plants/:plant/assets/:asset/setpoints/:metric)', () => {
    it('engineer+ lo fija dentro de la escala, queda en metadata.setpoints y se audita; operator/viewer 403', async () => {
      const ok = await api.put(`${base}/setpoints/level`, engineer).send({ value: 65 }).expect(200);
      expect((ok.body as AssetDef).metadata['setpoints']).toEqual({ level: 65 });
      await api.put(`${base}/setpoints/level`, admin).send({ value: 70 }).expect(200);
      await api.put(`${base}/setpoints/level`, operator).send({ value: 50 }).expect(403);
      await api.put(`${base}/setpoints/level`, viewer).send({ value: 50 }).expect(403);
      const cat = (await api.get('/api/plants/demo/assets', viewer).expect(200)).body as AssetDef[];
      expect(cat.find((a) => a.id === 'tk-01')?.metadata['setpoints']).toEqual({ level: 70 });
      const audit = (await api.get('/api/audit?limit=200&action=asset.setpoint', admin).expect(200))
        .body as AuditEntry[];
      expect(audit.map((e) => e.detail)).toEqual([
        { plant: 'demo', metric: 'level', value: 70, previous: 65 },
        { plant: 'demo', metric: 'level', value: 65 },
      ]);
    });

    it('valida: fuera de escala, no numérico, campos de más, métrica sin escala, activo inexistente', async () => {
      await api.put(`${base}/setpoints/level`, engineer).send({ value: 101 }).expect(400);
      await api.put(`${base}/setpoints/level`, engineer).send({ value: -1 }).expect(400);
      await api.put(`${base}/setpoints/level`, engineer).send({ value: '50' }).expect(400);
      await api.put(`${base}/setpoints/level`, engineer).send({}).expect(400);
      await api.put(`${base}/setpoints/level`, engineer).send({ value: 5, otro: 1 }).expect(400);
      await api.put(`${base}/setpoints/rara`, engineer).send({ value: 5 }).expect(400);
      await api.put(`${base}/setpoints/mala métrica`, engineer).send({ value: 5 }).expect(400);
      await api
        .put('/api/plants/demo/assets/nada/setpoints/level', engineer)
        .send({ value: 5 })
        .expect(404);
      await api
        .put('/api/plants/otra/assets/tk-01/setpoints/level', engineer)
        .send({ value: 5 })
        .expect(403);
    });
  });

  describe('WebSocket: reloj e ingestTs (§13)', () => {
    it('responde {type:"time", t0} con {type:"time", t0, t1} (reloj del servidor)', async () => {
      const s = await open(`${wsBase}?plant=demo&token=${viewer}`);
      await until(() => s.messages.some((m) => m.type === 'snapshot'));
      const before = Date.now();
      s.ws.send(JSON.stringify({ type: 'time', t0: 1234.5 }));
      await until(() => s.messages.some((m) => m.type === 'time'));
      const reply = s.messages.find((m) => m.type === 'time') as unknown as {
        t0: number;
        t1: number;
      };
      expect(reply.t0).toBe(1234.5);
      expect(reply.t1).toBeGreaterThanOrEqual(before);
      expect(reply.t1).toBeLessThanOrEqual(Date.now());
      s.ws.close();
    });

    it('mensajes desconocidos o inválidos se ignoran sin cerrar el socket ni romper el reloj', async () => {
      const s = await open(`${wsBase}?plant=demo&token=${viewer}`);
      await until(() => s.messages.some((m) => m.type === 'snapshot'));
      for (const junk of [
        'no es json',
        '[]',
        'null',
        '42',
        JSON.stringify({ type: 'hola' }),
        JSON.stringify({ type: 'time' }),
        JSON.stringify({ type: 'time', t0: 'x' }),
        JSON.stringify({ type: 'subscribe', plant: 'otra' }),
      ]) {
        s.ws.send(junk);
      }
      await sleep(100);
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
      expect(s.messages.map((m) => m.type)).toEqual(['snapshot']);
      s.ws.send(JSON.stringify({ type: 'time', t0: 7 }));
      await until(() => s.messages.some((m) => m.type === 'time'));
      s.ws.close();
    });

    it('reenvía ingestTs de la telemetría y conserva el del último valor al coalescer', async () => {
      const s = await open(`${wsBase}?plant=demo&token=${viewer}`);
      await until(() => s.messages.some((m) => m.type === 'snapshot'));
      const publish = (level: number, ingestTs: number) =>
        t.redis.publish(
          redisKeys.events('demo'),
          JSON.stringify({
            type: 'telemetry',
            plant: 'demo',
            asset: 'tk-01',
            ts: Date.now(),
            quality: 'good',
            values: { level },
            ingestTs,
          }),
        );
      await publish(1, 1000);
      await publish(2, 1005);
      await publish(3, 1010);
      await until(() => s.messages.some((m) => m.type === 'telemetry'));
      await sleep(250);
      const tel = s.messages.filter((m) => m.type === 'telemetry');
      expect(tel.at(-1)).toMatchObject({ values: { level: 3 }, ingestTs: 1010 });
      s.ws.close();
    });

    it('un viewer de otra planta no recibe eventos de órdenes de ésta (4403 al conectar a una planta ajena)', async () => {
      const s = await open(`${wsBase}?plant=otra&token=${viewer}`);
      expect(await s.closed).toBe(4403);
    });
  });
});
