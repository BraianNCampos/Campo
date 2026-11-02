import { HttpException } from '@nestjs/common';
import { MODULE_IDS, redisKeys } from '@campo/shared';
import type { ModuleId, Order, OrderPreview } from '@campo/shared';
import type Redis from 'ioredis';
import {
  FakeClock,
  FakeCommandBus,
  MemoryOrdersRepository,
  newId,
} from '../../test/support/control';
import {
  MemoryAlarmRulesRepository,
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryPlantCatalog,
  MemoryPlantsRepository,
  MemoryUsersRepository,
  memoryOrgs,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import type { AlarmRuleInput } from '../alarms/alarm.types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { TenantScope } from '../auth/tenant-scope';
import type { Asset } from '../plants/assets.repository';
import { ConfirmStore, RateLimiter } from './control-support';
import { CONTROL_LIMITS, ordersChannel } from './control.types';
import { OrdersService } from './orders.service';

const ORG = 'campos-demo';
const org = (id = ORG, modules: ModuleId[] = [...MODULE_IDS]) => ({ id, name: id, modules });
const user = (role: AuthUser['role'], id = 'u-operator', orgId = ORG): AuthUser => ({
  id,
  email: `${id}@campo.test`,
  role,
  plants: ['demo'],
  org: org(orgId),
});
const operator = user('operator');

const tank = (over: Partial<Asset> = {}): Asset => ({
  plant: 'demo',
  id: 'tk-01',
  name: 'Tanque 01',
  type: 'tank',
  model3dRef: null,
  tag: 'TNK-101',
  metadata: { control: { enabled: true, minTarget: 10, maxTarget: 90, maxDurationMinutes: 30 } },
  ...over,
});
const rule = (over: Partial<AlarmRuleInput>): AlarmRuleInput => ({
  plant: 'demo',
  asset: 'tk-*',
  metric: 'level',
  operator: 'gt',
  threshold: 95,
  severity: 'warning',
  forSeconds: 0,
  hysteresis: 0,
  enabled: true,
  ...over,
});

/** Error HTTP: estado y `error` del cuerpo. */
async function fails(
  p: Promise<unknown>,
): Promise<{ status: number; error?: string; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const ex = e as HttpException;
    const body = ex.getResponse();
    const o = (typeof body === 'string' ? { message: body } : body) as Record<string, unknown>;
    return { status: ex.getStatus(), error: o['error'] as string | undefined, body: o };
  }
  throw new Error('se esperaba un error HTTP');
}

describe('OrdersService (control de llenado, §14.3)', () => {
  let redis: Redis;
  let assets: MemoryAssetsRepository;
  let rules: MemoryAlarmRulesRepository;
  let audit: MemoryAuditRepository;
  let orders: MemoryOrdersRepository;
  let bus: FakeCommandBus;
  let clock: FakeClock;
  let orgs: ReturnType<typeof memoryOrgs>;
  let svc: OrdersService;
  let events: Order[];
  let realPublish: Redis['publish'];

  beforeAll(() => {
    ({ redis } = createRedisMocks());
    realPublish = redis.publish.bind(redis);
  });

  beforeEach(async () => {
    await redis.flushall();
    clock = new FakeClock();
    bus = new FakeCommandBus();
    orders = new MemoryOrdersRepository();
    audit = new MemoryAuditRepository();
    assets = new MemoryAssetsRepository([
      tank(),
      tank({ id: 'tk-02', name: 'Tanque 02', tag: 'TNK-102' }),
      {
        plant: 'demo',
        id: 'pump-01',
        name: 'Bomba',
        type: 'pump',
        model3dRef: null,
        tag: 'PMP-101',
        metadata: { control: { enabled: true } },
      },
      {
        plant: 'demo',
        id: 'valve-01',
        name: 'Válvula',
        type: 'valve',
        model3dRef: null,
        tag: 'VLV-101',
        metadata: { control: { enabled: true } },
      },
      {
        plant: 'demo',
        id: 'clima-01',
        name: 'Clima',
        type: 'climate',
        model3dRef: null,
        tag: null,
        metadata: {},
      },
    ]);
    rules = new MemoryAlarmRulesRepository();
    const users = new MemoryUsersRepository();
    orgs = memoryOrgs(users);
    await orgs.create({ id: ORG, name: 'Demo', modules: [...MODULE_IDS], active: true });
    await orgs.create({ id: 'sin-control', name: 'S', modules: ['tanks'], active: true });
    const plants = new MemoryPlantsRepository(assets, users);
    plants.register('demo', ORG);
    svc = new OrdersService(
      orders,
      assets,
      orgs,
      rules,
      new AuditService(audit),
      bus,
      new ConfirmStore(redis, clock),
      new RateLimiter(redis, clock),
      clock,
      new TenantScope(new MemoryPlantCatalog(plants, redis)),
      redis,
    );
    events = [];
    redis.publish = (channel: string, message: string) => {
      if (channel === ordersChannel('demo'))
        events.push((JSON.parse(message) as { order: Order }).order);
      return realPublish(channel, message);
    };
    await online('tk-01', { level: 40 });
    await online('pump-01', { rpm: 0 });
    await online('valve-01', { position: 0 });
  });

  /** Telemetría reciente (o con la antigüedad indicada) del activo. */
  const online = (asset: string, values: Record<string, number>, ageMs = 0) =>
    redis.hset(
      redisKeys.state('demo'),
      asset,
      JSON.stringify({ ts: clock.now() - ageMs, values, quality: 'good' }),
    );

  const preview = (
    command: Parameters<OrdersService['preview']>[4]['command'],
    target?: number,
    asset = 'tk-01',
    who = operator,
    orgId: string | null = ORG,
  ) => svc.preview(who, 'demo', orgId, asset, { command, target });
  const confirm = (p: OrderPreview, asset = 'tk-01', who = operator, orgId: string | null = ORG) =>
    svc.execute(who, 'demo', orgId, asset, p.confirmId);
  /** Vista previa + confirmación. */
  const order = async (
    command: Parameters<typeof preview>[0],
    target?: number,
    asset = 'tk-01',
    who = operator,
  ) => confirm(await preview(command, target, asset, who), asset, who);

  describe('vista previa y confirmación en dos pasos', () => {
    it('la vista previa valida y devuelve resumen y confirmId de 60 s, sin enviar nada al equipo', async () => {
      const p = await preview('fill', 80);
      expect(p.confirmId).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.expiresAt).toBe(clock.now() + 60_000);
      expect(p.summary).toBe('Llenar TNK-101 (Tanque 01) hasta 80 %');
      expect(p.blocked).toBeNull();
      expect(p.warnings.join(' ')).toContain('30 min');
      expect(bus.published).toHaveLength(0);
      expect(orders.orders.size).toBe(0);
    });

    it('confirmar publica en campo/v1/{planta}/{activo}/cmd {id, command, target, ts, by}, registra, audita y difunde', async () => {
      const o = await order('fill', 80);
      expect(o).toMatchObject({
        plant: 'demo',
        asset: 'tk-01',
        tag: 'TNK-101',
        command: 'fill',
        target: 80,
        status: 'pending',
        requestedBy: { id: 'u-operator', email: 'u-operator@campo.test' },
        requestedAt: clock.now(),
      });
      expect(bus.published).toHaveLength(1);
      expect(bus.last().topic).toBe('campo/v1/demo/tk-01/cmd');
      expect(bus.last().payload).toEqual({
        id: o.id,
        command: 'fill',
        target: 80,
        ts: clock.now(),
        by: 'u-operator@campo.test',
      });
      expect(audit.entries.map((e) => e.action)).toEqual(['order.create']);
      expect(audit.entries[0]).toMatchObject({
        target: `order:${o.id}`,
        detail: { plant: 'demo', asset: 'tk-01', command: 'fill', target: 80 },
      });
      expect(audit.orgOfEntry.get(audit.entries[0].id)).toBe(ORG);
      expect(events.map((e) => [e.id, e.status])).toEqual([[o.id, 'pending']]);
      expect((await svc.list('demo', ORG, {})).map((x) => x.id)).toEqual([o.id]);
    });

    it('el confirmId es de un solo uso', async () => {
      const p = await preview('fill', 80);
      await confirm(p);
      expect(await fails(confirm(p))).toMatchObject({ status: 409, error: 'invalid_confirm' });
      expect(bus.published).toHaveLength(1);
    });

    it('caduca a los 60 s', async () => {
      const p = await preview('fill', 80);
      clock.advance(CONTROL_LIMITS.confirmTtlMs + 1);
      expect(await fails(confirm(p))).toMatchObject({ status: 409, error: 'invalid_confirm' });
      expect(bus.published).toHaveLength(0);
    });

    it('un confirmId inventado (o de otra orden) no ejecuta nada', async () => {
      const bogus = '00000000-0000-4000-8000-000000000000';
      expect(await fails(svc.execute(operator, 'demo', ORG, 'tk-01', bogus))).toMatchObject({
        status: 409,
        error: 'invalid_confirm',
      });
      expect(bus.published).toHaveLength(0);
    });

    it('está atado al usuario: otro usuario no puede usarlo (y el original queda quemado)', async () => {
      const p = await preview('fill', 80);
      const other = user('engineer', 'u-engineer');
      expect(await fails(confirm(p, 'tk-01', other))).toMatchObject({
        status: 409,
        error: 'invalid_confirm',
      });
      expect(await fails(confirm(p))).toMatchObject({ status: 409, error: 'invalid_confirm' });
      expect(bus.published).toHaveLength(0);
    });

    it('está atado al activo: no sirve para otro activo', async () => {
      const p = await preview('fill', 80, 'tk-01');
      await online('tk-02', { level: 40 });
      expect(await fails(confirm(p, 'tk-02'))).toMatchObject({
        status: 409,
        error: 'invalid_confirm',
      });
      expect(bus.published).toHaveLength(0);
    });

    it('está atado a la orden exacta: lo publicado es lo previsualizado', async () => {
      await confirm(await preview('drain', 20));
      expect(bus.last().payload).toMatchObject({ command: 'drain', target: 20 });
    });

    it('una vista previa bloqueada no emite confirmId (y confirmar con uno vacío falla)', async () => {
      const p = await preview('fill', 95);
      expect(p.blocked).toContain('fuera del rango');
      expect(p.confirmId).toBe('');
      expect(await fails(confirm(p))).toMatchObject({ status: 409, error: 'invalid_confirm' });
    });
  });

  describe('validación del comando', () => {
    it.each([
      ['pump', 'fill', 80, 'pump-01'],
      ['tank', 'start', undefined, 'tk-01'],
      ['tank', 'fill', undefined, 'tk-01'],
      ['tank', 'fill', 0, 'tk-01'],
      ['tank', 'drain', 100, 'tk-01'],
      ['tank', 'stop', 50, 'tk-01'],
      ['valve', 'set_position', undefined, 'valve-01'],
      ['valve', 'set_position', 101, 'valve-01'],
      ['valve', 'open', 5, 'valve-01'],
      ['climate', 'stop', undefined, 'clima-01'],
    ] as const)('%s + %s %p -> 400', async (_t, command, target, asset) => {
      expect((await fails(preview(command, target, asset))).status).toBe(400);
    });

    it('activo inexistente -> 404', async () => {
      expect((await fails(preview('stop', undefined, 'nada'))).status).toBe(404);
    });

    it('bomba y válvula: sus comandos pasan sin los enclavamientos de nivel', async () => {
      await expect(order('start', undefined, 'pump-01')).resolves.toMatchObject({
        command: 'start',
      });
      await expect(order('set_position', 40, 'valve-01')).resolves.toMatchObject({
        command: 'set_position',
        target: 40,
      });
      expect((await preview('close', undefined, 'valve-01')).blocked).toContain('orden en curso');
    });
  });

  describe('enclavamientos (en el servidor), uno por uno', () => {
    it('módulo control no contratado -> 403 module_disabled (vista previa y confirmación)', async () => {
      expect(await fails(preview('fill', 80, 'tk-01', operator, 'sin-control'))).toMatchObject({
        status: 403,
        error: 'module_disabled',
        body: { module: 'control' },
      });
      const p = await preview('fill', 80);
      expect(await fails(confirm(p, 'tk-01', operator, 'sin-control'))).toMatchObject({
        status: 403,
        error: 'module_disabled',
      });
      expect(bus.published).toHaveLength(0);
    });

    it('si el módulo se desactiva entre la vista previa y la confirmación, tampoco ejecuta', async () => {
      const p = await preview('fill', 80);
      await orgs.update(ORG, { modules: ['tanks'] });
      expect(await fails(confirm(p))).toMatchObject({ status: 403, error: 'module_disabled' });
      expect(bus.published).toHaveLength(0);
    });

    it('metadata.control.enabled ausente o false -> bloqueado (el stop sigue permitido)', async () => {
      for (const metadata of [{}, { control: { enabled: false } }]) {
        await assets.update('demo', 'tk-01', { metadata });
        expect((await preview('fill', 80)).blocked).toContain('no está habilitado');
        expect((await preview('stop')).blocked).toBeNull();
      }
    });

    it('si el control se deshabilita entre la vista previa y la confirmación -> 409 interlock_blocked', async () => {
      const p = await preview('fill', 80);
      await assets.update('demo', 'tk-01', { metadata: { control: { enabled: false } } });
      expect(await fails(confirm(p))).toMatchObject({
        status: 409,
        error: 'interlock_blocked',
        body: { interlock: 'enabled' },
      });
      expect(bus.published).toHaveLength(0);
    });

    it.each([
      ['sin telemetría', undefined],
      ['telemetría de hace 31 s', 31_000],
    ])('equipo fuera de línea (%s) -> 409 device_offline', async (_n, age) => {
      await redis.hdel(redisKeys.state('demo'), 'tk-01');
      if (age !== undefined) await online('tk-01', { level: 40 }, age);
      const p = await preview('fill', 80);
      expect(p.blocked).toContain('no informa datos');
      await online('tk-01', { level: 40 });
      const fresh = await preview('fill', 80);
      await redis.hdel(redisKeys.state('demo'), 'tk-01');
      if (age !== undefined) await online('tk-01', { level: 40 }, age);
      expect(await fails(confirm(fresh))).toMatchObject({ status: 409, error: 'device_offline' });
    });

    it('telemetría de hace 29 s todavía cuenta como reciente', async () => {
      await online('tk-01', { level: 40 }, 29_000);
      await expect(order('fill', 80)).resolves.toMatchObject({ status: 'pending' });
    });

    it.each([
      ['por debajo del mínimo', 5],
      ['por encima del máximo', 95],
    ])('objetivo %s de [minTarget, maxTarget] -> bloqueado', async (_n, target) => {
      const p = await preview('fill', target);
      expect(p.blocked).toContain('fuera del rango permitido');
    });

    it('los valores por defecto de minTarget/maxTarget son 5 y 95', async () => {
      await assets.update('demo', 'tk-01', { metadata: { control: { enabled: true } } });
      expect((await preview('fill', 96)).blocked).toContain('fuera del rango');
      expect((await preview('fill', 4)).blocked).toContain('fuera del rango');
      expect((await preview('fill', 95)).blocked).toBeNull();
    });

    it('objetivo por encima del límite HI menos el 2 % -> bloqueado', async () => {
      await rules.create(rule({ threshold: 85 }));
      expect((await preview('fill', 84)).blocked).toContain('límite alto');
      expect((await preview('fill', 83)).blocked).toBeNull();
      expect((await preview('fill', 83)).confirmId).not.toBe('');
    });

    it('sin regla HI, el límite HH hace de tope (nunca se llena hasta el punto crítico)', async () => {
      await rules.create(rule({ threshold: 90, severity: 'critical' })); // HH
      expect((await preview('fill', 89)).blocked).toContain('límite alto');
      expect((await preview('fill', 88)).blocked).toBeNull();
    });

    it('una regla desactivada o de otro activo no cuenta', async () => {
      await rules.create(
        rule({ threshold: 50, enabled: false, outOfServiceReason: 'mantenimiento' }),
      );
      await rules.create(rule({ asset: 'silo-*', threshold: 50 }));
      expect((await preview('fill', 80)).blocked).toBeNull();
    });

    it('fill sólo si nivel < objetivo; drain sólo si nivel > objetivo', async () => {
      expect((await preview('fill', 30)).blocked).toContain('ya alcanzó');
      expect((await preview('fill', 40)).blocked).toContain('ya alcanzó');
      expect((await preview('fill', 41)).blocked).toBeNull();
      expect((await preview('drain', 50)).blocked).toContain('ya está en o bajo');
      expect((await preview('drain', 40)).blocked).toContain('ya está en o bajo');
      expect((await preview('drain', 39)).blocked).toBeNull();
    });

    it('sin lectura de nivel no se llena ni se vacía', async () => {
      await online('tk-01', { temp: 20 });
      expect((await preview('fill', 80)).blocked).toBe('Sin lectura de nivel');
      expect((await preview('drain', 20)).blocked).toBe('Sin lectura de nivel');
    });

    it('con una alarma HH activa no se llena (vaciar sí)', async () => {
      await redis.hset(
        redisKeys.activeAlarms('demo'),
        'tk-01:level:r1',
        JSON.stringify({ asset: 'tk-01', metric: 'level', kind: 'HH', state: 'active' }),
      );
      expect((await preview('fill', 80)).blocked).toContain('alarma HH');
      expect((await preview('drain', 20)).blocked).toBeNull();
      // la HH de otro activo no afecta
      await redis.del(redisKeys.activeAlarms('demo'));
      await redis.hset(
        redisKeys.activeAlarms('demo'),
        'tk-02:level:r1',
        JSON.stringify({ asset: 'tk-02', metric: 'level', kind: 'HH', state: 'active' }),
      );
      expect((await preview('fill', 80)).blocked).toBeNull();
    });

    it('una sola orden en curso por activo -> 409 order_in_progress; otro activo no se ve afectado', async () => {
      const fresh = await preview('fill', 80); // emitida mientras el activo estaba libre
      await order('fill', 70);
      expect((await preview('drain', 20)).blocked).toContain('orden en curso');
      expect(await fails(confirm(fresh))).toMatchObject({
        status: 409,
        error: 'order_in_progress',
      });
      expect(bus.published).toHaveLength(1);
      await online('tk-02', { level: 40 });
      await expect(order('fill', 80, 'tk-02')).resolves.toMatchObject({ asset: 'tk-02' });
    });

    it('la base también impide dos órdenes en curso (carrera): 409 order_in_progress', async () => {
      const fresh = await preview('fill', 80);
      await orders.create(
        {
          id: newId(),
          orgId: ORG,
          plant: 'demo',
          asset: 'tk-01',
          tag: null,
          command: 'fill',
          requestedBy: { id: 'x', email: 'x@x' },
          maxDurationMinutes: 30,
          now: clock.now(),
        },
        null,
      );
      // el enclavamiento ve la orden en curso antes de llegar a la base; con la base como único juez:
      jest.spyOn(orders, 'findOpenByAsset').mockResolvedValue([]);
      expect(await fails(confirm(fresh))).toMatchObject({
        status: 409,
        error: 'order_in_progress',
      });
    });

    it('stop siempre se permite aunque falle todo lo demás, y reemplaza la orden en curso', async () => {
      const fill = await order('fill', 80);
      await assets.update('demo', 'tk-01', { metadata: {} }); // control deshabilitado
      await redis.hdel(redisKeys.state('demo'), 'tk-01'); // fuera de línea
      const p = await preview('stop');
      expect(p.blocked).toBeNull();
      expect(p.warnings.join(' ')).toContain('Se cancelará la orden en curso');
      expect(p.warnings.join(' ')).toContain('podría no llegar');
      const stop = await confirm(p);
      expect(stop).toMatchObject({ command: 'stop', status: 'pending' });
      expect(bus.last().payload).toMatchObject({ command: 'stop' });
      expect((await orders.findById(fill.id))?.status).toBe('cancelled');
      expect((await orders.findById(fill.id))?.reason).toContain('detención');
      // auditoría y evento de la orden reemplazada
      expect(audit.entries.map((e) => e.action)).toEqual([
        'order.create',
        'order.status',
        'order.create',
      ]);
      expect(audit.entries[1].detail).toMatchObject({ status: 'cancelled', command: 'fill' });
      expect(events.some((e) => e.id === fill.id && e.status === 'cancelled')).toBe(true);
    });

    it('stop sigue exigiendo el módulo contratado', async () => {
      expect(
        (await fails(preview('stop', undefined, 'tk-01', operator, 'sin-control'))).error,
      ).toBe('module_disabled');
    });
  });

  describe('límite de frecuencia (10 por minuto y usuario)', () => {
    const finish = async () => {
      const [id] = [...orders.orders.keys()].slice(-1);
      await svc.handleAck('campo/v1/demo/tk-01/cmd/ack', JSON.stringify({ id, status: 'done' }));
    };

    it('la orden 11 en un minuto recibe 429; pasado el minuto vuelve a admitirse', async () => {
      for (let i = 0; i < CONTROL_LIMITS.ordersPerMinute; i++) {
        await order('fill', 80);
        await finish();
        clock.advance(1000);
      }
      expect(await fails(order('fill', 80))).toMatchObject({ status: 429, error: 'rate_limited' });
      clock.advance(60_000);
      await online('tk-01', { level: 40 });
      await expect(order('fill', 80)).resolves.toMatchObject({ status: 'pending' });
    });

    it('es por usuario: otro usuario no se ve afectado', async () => {
      const eng = user('engineer', 'u-eng');
      for (let i = 0; i < CONTROL_LIMITS.ordersPerMinute; i++) {
        await order('fill', 80);
        await finish();
      }
      expect((await fails(order('fill', 80))).status).toBe(429);
      await expect(order('fill', 80, 'tk-01', eng)).resolves.toMatchObject({ status: 'pending' });
    });

    it('el stop no se bloquea por el límite normal', async () => {
      for (let i = 0; i < CONTROL_LIMITS.ordersPerMinute; i++) {
        await order('fill', 80);
        await finish();
      }
      expect((await fails(order('fill', 80))).status).toBe(429);
      await expect(order('stop')).resolves.toMatchObject({ command: 'stop' });
    });

    it('un 429 no envía nada al equipo', async () => {
      for (let i = 0; i < CONTROL_LIMITS.ordersPerMinute; i++) {
        await order('fill', 80);
        await finish();
      }
      const n = bus.published.length;
      await fails(order('fill', 80));
      expect(bus.published).toHaveLength(n);
    });
  });

  describe('respuestas del equipo (cmd/ack) y estados', () => {
    const ack = (o: Order, body: object, topic = `campo/v1/${o.plant}/${o.asset}/cmd/ack`) =>
      svc.handleAck(topic, JSON.stringify({ id: o.id, ...body }));
    const status = async (o: Order) => (await orders.findById(o.id))?.status;

    it('pending -> accepted -> running -> done, con auditoría order.status y evento por transición', async () => {
      const o = await order('fill', 80);
      await ack(o, { status: 'accepted' });
      expect(await status(o)).toBe('accepted');
      await ack(o, { status: 'running' });
      expect(await status(o)).toBe('running');
      await ack(o, { status: 'done' });
      const rec = await orders.findById(o.id);
      expect(rec).toMatchObject({ status: 'done', completedAt: clock.now() });
      expect(events.map((e) => e.status)).toEqual(['pending', 'accepted', 'running', 'done']);
      const st = audit.entries.filter((e) => e.action === 'order.status');
      expect(st.map((e) => (e.detail as { status: string }).status)).toEqual([
        'accepted',
        'running',
        'done',
      ]);
      expect(st[0].actorId).toBeNull(); // lo informa el equipo, no un usuario
      expect(st[2].detail).toMatchObject({ previous: 'running', command: 'fill' });
    });

    it('rejected y failed guardan el motivo del equipo', async () => {
      const a = await order('fill', 80);
      await ack(a, { status: 'rejected', reason: 'Nivel fuera de rango' });
      expect(await orders.findById(a.id)).toMatchObject({
        status: 'rejected',
        reason: 'Nivel fuera de rango',
      });
      const b = await order('fill', 80);
      await ack(b, { status: 'accepted' });
      await ack(b, { status: 'failed', reason: 'Sensor en falla' });
      expect(await orders.findById(b.id)).toMatchObject({
        status: 'failed',
        reason: 'Sensor en falla',
      });
    });

    it('un estado terminal no cambia más; no se retrocede (running -> accepted)', async () => {
      const o = await order('fill', 80);
      await ack(o, { status: 'running' });
      await ack(o, { status: 'accepted' });
      expect(await status(o)).toBe('running');
      await ack(o, { status: 'done' });
      await ack(o, { status: 'running' });
      await ack(o, { status: 'failed' });
      expect(await status(o)).toBe('done');
    });

    it('acks inválidos o ajenos se descartan: otro activo/planta, id desconocido, estado raro, JSON malo', async () => {
      const o = await order('fill', 80);
      await ack(o, { status: 'done' }, 'campo/v1/demo/tk-02/cmd/ack'); // de otro activo
      await ack(o, { status: 'done' }, 'campo/v1/otra/tk-01/cmd/ack'); // de otra planta
      await ack(o, { status: 'done' }, 'campo/v1/demo/tk-01/telemetry'); // tópico que no es ack
      await ack(o, { status: 'cancelled' }); // estados que decide la API, no el equipo
      await ack(o, { status: 'pending' });
      await ack(o, { status: 42 });
      await svc.handleAck('campo/v1/demo/tk-01/cmd/ack', '{no json');
      await svc.handleAck(
        'campo/v1/demo/tk-01/cmd/ack',
        JSON.stringify({ id: 'x', status: 'done' }),
      );
      await svc.handleAck(
        'campo/v1/demo/tk-01/cmd/ack',
        JSON.stringify({ id: o.id, status: 'done', pad: 'x'.repeat(3000) }),
      );
      expect(await status(o)).toBe('pending');
    });

    it('el servicio escucha el bus de comandos (suscripción a cmd/ack)', async () => {
      svc.onModuleInit();
      try {
        const o = await order('fill', 80);
        bus.ack('demo', 'tk-01', { id: o.id, status: 'accepted' });
        await new Promise((r) => setTimeout(r, 20));
        expect(await status(o)).toBe('accepted');
      } finally {
        svc.onModuleDestroy();
      }
    });
  });

  describe('plazos (timeouts)', () => {
    it('sin accepted en 10 s -> timeout; antes de los 10 s no', async () => {
      const o = await order('fill', 80);
      clock.advance(CONTROL_LIMITS.acceptTimeoutMs);
      await svc.sweep();
      expect((await orders.findById(o.id))?.status).toBe('pending');
      clock.advance(1);
      await svc.sweep();
      expect(await orders.findById(o.id)).toMatchObject({ status: 'timeout' });
      expect((await orders.findById(o.id))?.reason).toContain('10 s');
      expect(events.at(-1)).toMatchObject({ id: o.id, status: 'timeout' });
      const st = audit.entries.find((e) => e.action === 'order.status');
      expect(st).toMatchObject({
        actorId: null,
        detail: { status: 'timeout', previous: 'pending' },
      });
    });

    it('running sin done pasado maxDurationMinutes -> timeout (desde que empezó a correr)', async () => {
      const o = await order('fill', 80);
      await svc.handleAck(
        'campo/v1/demo/tk-01/cmd/ack',
        JSON.stringify({ id: o.id, status: 'accepted' }),
      );
      clock.advance(5000);
      await svc.handleAck(
        'campo/v1/demo/tk-01/cmd/ack',
        JSON.stringify({ id: o.id, status: 'running' }),
      );
      clock.advance(30 * 60_000); // maxDurationMinutes = 30
      await svc.sweep();
      expect((await orders.findById(o.id))?.status).toBe('running');
      clock.advance(1);
      await svc.sweep();
      const rec = await orders.findById(o.id);
      expect(rec?.status).toBe('timeout');
      expect(rec?.reason).toContain('30 min');
    });

    it('usa la duración máxima copiada al crear la orden y 120 min por defecto', async () => {
      await assets.update('demo', 'tk-01', { metadata: { control: { enabled: true } } });
      const o = await order('fill', 80);
      expect((await orders.findById(o.id))?.maxDurationMinutes).toBe(120);
    });

    it('una orden terminada no se toca', async () => {
      const o = await order('fill', 80);
      await svc.handleAck(
        'campo/v1/demo/tk-01/cmd/ack',
        JSON.stringify({ id: o.id, status: 'done' }),
      );
      clock.advance(10 * 3600_000);
      await svc.sweep();
      expect((await orders.findById(o.id))?.status).toBe('done');
    });

    it('tras un timeout el activo queda libre para otra orden', async () => {
      await order('fill', 80);
      clock.advance(11_000);
      await svc.sweep();
      await online('tk-01', { level: 40 });
      await expect(order('fill', 80)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  describe('cancelar', () => {
    it('envía un stop al equipo, deja la orden original cancelled y registra el stop', async () => {
      const o = await order('fill', 80);
      await svc.handleAck(
        'campo/v1/demo/tk-01/cmd/ack',
        JSON.stringify({ id: o.id, status: 'running' }),
      );
      const c = await svc.cancel(operator, o.id);
      expect(c).toMatchObject({ id: o.id, status: 'cancelled' });
      expect(c.reason).toContain('Cancelada por');
      expect(bus.last()).toMatchObject({
        topic: 'campo/v1/demo/tk-01/cmd',
        payload: { command: 'stop' },
      });
      const all = await svc.list('demo', ORG, {});
      expect(all.map((x) => [x.command, x.status])).toEqual(
        expect.arrayContaining([
          ['fill', 'cancelled'],
          ['stop', 'pending'],
        ]),
      );
      const created = audit.entries.filter((e) => e.action === 'order.create');
      expect(created.at(-1)?.detail).toMatchObject({ command: 'stop', cancelOf: o.id });
      expect(events.some((e) => e.id === o.id && e.status === 'cancelled')).toBe(true);
    });

    it.each(['done', 'failed', 'rejected', 'timeout', 'cancelled'] as const)(
      'una orden %s no se puede cancelar (409)',
      async (st) => {
        const o = await order('fill', 80);
        await orders.transition(o.id, ['pending'], st, { now: clock.now() });
        expect(await fails(svc.cancel(operator, o.id))).toMatchObject({
          status: 409,
          error: 'order_not_cancellable',
        });
      },
    );

    it('funciona aunque el módulo se haya desactivado después y el control esté deshabilitado', async () => {
      const o = await order('fill', 80);
      await orgs.update(ORG, { modules: ['tanks'] });
      await assets.update('demo', 'tk-01', { metadata: {} });
      await expect(svc.cancel(operator, o.id)).resolves.toMatchObject({ status: 'cancelled' });
    });

    it('un usuario de otro cliente recibe 403; una orden inexistente, el mismo 403 (404 para platform_admin)', async () => {
      const o = await order('fill', 80);
      const foreign = user('admin', 'u-foreign', 'otro-cliente');
      expect((await fails(svc.cancel(foreign, o.id))).status).toBe(403);
      const unknown = await fails(svc.cancel(foreign, '00000000-0000-4000-8000-000000000000'));
      expect(unknown.status).toBe(403);
      expect(unknown.body['message']).toBe(
        (await fails(svc.cancel(foreign, o.id))).body['message'],
      );
      const platform: AuthUser = {
        id: 'p',
        email: 'p@x',
        role: 'platform_admin',
        plants: ['*'],
        org: null,
      };
      expect(
        (await fails(svc.cancel(platform, '00000000-0000-4000-8000-000000000000'))).status,
      ).toBe(404);
      expect(bus.published).toHaveLength(1); // nada se envió
    });

    it('un operador de otra planta del mismo cliente recibe 403', async () => {
      const o = await order('fill', 80);
      const other: AuthUser = { ...operator, id: 'u-otro', plants: ['otra'] };
      expect((await fails(svc.cancel(other, o.id))).status).toBe(403);
    });
  });

  describe('disponibilidad del canal (MQTT)', () => {
    it('sin MQTT_URL: preview, confirmación y cancelación responden 503 control_unavailable', async () => {
      const o = await order('fill', 80);
      const p = await preview('stop');
      bus.isConfigured = false;
      for (const call of [preview('fill', 80), confirm(p), svc.cancel(operator, o.id)]) {
        expect(await fails(call)).toMatchObject({ status: 503, error: 'control_unavailable' });
      }
    });

    it('broker caído al publicar: la orden queda failed, se difunde y se responde 503', async () => {
      const p = await preview('fill', 80);
      bus.down = true;
      const r = await fails(confirm(p));
      expect(r).toMatchObject({ status: 503, error: 'control_unavailable' });
      const [rec] = [...orders.orders.values()];
      expect(rec).toMatchObject({ status: 'failed' });
      expect(rec.reason).toContain('broker');
      expect(events.map((e) => e.status)).toEqual(['pending', 'failed']);
      // el activo queda libre
      bus.down = false;
      await online('tk-01', { level: 40 });
      await expect(order('fill', 80)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  describe('registro e interlocks (lectura)', () => {
    it('list filtra por activo y estado, ordena del más reciente y pagina con before/limit', async () => {
      const a = await order('fill', 80);
      clock.advance(1000);
      await orders.transition(a.id, ['pending'], 'done', { now: clock.now() });
      const b = await order('drain', 20);
      await online('tk-02', { level: 40 });
      clock.advance(1000);
      const c = await order('fill', 80, 'tk-02');
      expect((await svc.list('demo', ORG, {})).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
      expect((await svc.list('demo', ORG, { asset: 'tk-01' })).map((x) => x.id)).toEqual([
        b.id,
        a.id,
      ]);
      expect((await svc.list('demo', ORG, { status: 'done' })).map((x) => x.id)).toEqual([a.id]);
      expect((await svc.list('demo', ORG, { limit: 1 })).map((x) => x.id)).toEqual([c.id]);
      expect((await svc.list('demo', ORG, { before: c.requestedAt })).map((x) => x.id)).toEqual([
        b.id,
        a.id,
      ]);
      expect(await svc.list('otra', ORG, {})).toEqual([]); // sólo la planta pedida
      expect(await svc.list('demo', 'otro-cliente', {})).toEqual([]); // ni órdenes de otro cliente (planta reutilizada)
      expect(await svc.list('demo', null, {})).toEqual([]);
      expect(JSON.stringify(await svc.list('demo', ORG, {}))).not.toContain('orgId');
    });

    it('interlocks: ítems con ok/reason; sin módulo no es 403 sino un ítem en falla', async () => {
      const items = await svc.interlocks('demo', ORG, 'tk-01', {});
      expect(items.map((i) => [i.id, i.ok])).toEqual([
        ['broker', true],
        ['module', true],
        ['enabled', true],
        ['online', true],
        ['idle', true],
        ['no_hh', true],
      ]);
      const none = await svc.interlocks('demo', 'sin-control', 'tk-01', {});
      expect(none.find((i) => i.id === 'module')).toMatchObject({ ok: false });
      expect(none.find((i) => i.id === 'module')?.reason).toBeTruthy();
      await redis.hdel(redisKeys.state('demo'), 'tk-01');
      expect(
        (await svc.interlocks('demo', ORG, 'tk-01', {})).find((i) => i.id === 'online'),
      ).toMatchObject({ ok: false });
    });

    it('interlocks con command+target incluye los del comando', async () => {
      const items = await svc.interlocks('demo', ORG, 'tk-01', { command: 'fill', target: 95 });
      expect(items.map((i) => i.id)).toEqual(
        expect.arrayContaining(['target_range', 'level_direction']),
      );
      expect(items.find((i) => i.id === 'target_range')?.ok).toBe(false);
      expect(
        (await fails(svc.interlocks('demo', ORG, 'pump-01', { command: 'fill', target: 5 })))
          .status,
      ).toBe(400);
      expect((await fails(svc.interlocks('demo', ORG, 'nada', {}))).status).toBe(404);
    });
  });
});
