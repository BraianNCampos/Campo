import type { AddressInfo } from 'node:net';
import { redisKeys } from '@campo/shared';
import type { AlarmEvent, AlarmKpis, Limit } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { AlarmEngine } from '../src/alarms/alarm-engine.service';
import type { RuleView } from '../src/alarms/alarm-rules.service';
import type { AlarmRecord } from '../src/alarms/alarm.types';
import { createTestApp, TestApp } from './support/test-app';

/**
 * Alarmas ISA-18.2 de extremo a extremo (docs/architecture.md §12): Redis pub/sub -> motor -> REST + WebSocket.
 * Cada test arranca una app nueva (repositorios en memoria, Redis simulado).
 */
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condición');
    await wait(10);
  }
};

describe('Alarmas ISA-18.2 (e2e)', () => {
  let t: TestApp;
  let http: App;
  let wsBase: string;
  let tok: Record<'viewer' | 'operator' | 'engineer' | 'admin' | 'platform_admin', string>;
  let sockets: WebSocket[];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer() as App;
    wsBase = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/ws`;
    tok = {
      viewer: await t.tokenFor('viewer'),
      operator: await t.tokenFor('operator'),
      engineer: await t.tokenFor('engineer'),
      admin: await t.tokenFor('admin'),
      platform_admin: await t.tokenFor('platform_admin'),
    };
    sockets = [];
  });
  afterEach(async () => {
    for (const s of sockets) s.close();
    await t.app.close();
  });

  const api = {
    get: (path: string, token: string) => request(http).get(path).set(bearer(token)),
    post: (path: string, token: string, body?: object) =>
      request(http).post(path).set(bearer(token)).send(body),
    patch: (path: string, token: string, body: object) =>
      request(http).patch(path).set(bearer(token)).send(body),
    put: (path: string, token: string, body: object) =>
      request(http).put(path).set(bearer(token)).send(body),
  };
  const rule = (over: object = {}) => ({
    plant: 'demo',
    asset: 'tk-01',
    metric: 'level',
    operator: 'gt',
    threshold: 90,
    severity: 'critical',
    ...over,
  });
  const createRule = async (over: object = {}) =>
    (await api.post('/api/alarm-rules', tok.engineer, rule(over)).expect(201)).body as RuleView;
  const telemetry = async (asset: string, values: Record<string, number>) => {
    await t.redis.publish(
      redisKeys.events('demo'),
      JSON.stringify({
        type: 'telemetry',
        plant: 'demo',
        asset,
        ts: Date.now(),
        quality: 'good',
        values,
      }),
    );
    await wait(50);
  };
  const level = (v: number) => telemetry('tk-01', { level: v });
  const list = async (state: string, token = tok.viewer) =>
    (await api.get(`/api/alarms?state=${state}`, token).expect(200)).body as AlarmRecord[];
  const openWs = (token = tok.viewer) =>
    new Promise<AlarmEvent[]>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}?plant=demo&token=${token}`);
      sockets.push(ws);
      const alarms: AlarmEvent[] = [];
      ws.on('message', (d) => {
        const m = JSON.parse((d as Buffer).toString()) as { type: string };
        if (m.type === 'alarm') alarms.push(m as AlarmEvent);
      });
      ws.on('open', () => setTimeout(() => resolve(alarms), 80)); // tras el snapshot
      ws.on('error', reject);
    });

  describe('reglas: campos nuevos', () => {
    it('una regla clásica sigue igual y deriva su kind; la respuesta lleva todos los campos ISA', async () => {
      const r = await createRule({ hysteresis: 5, forSeconds: 3 });
      expect(r).toMatchObject({
        kind: 'HH',
        severity: 'critical',
        forSeconds: 3,
        hysteresis: 5,
        offDelaySeconds: 0,
        rocWindowSeconds: 60,
        rocDirection: 'any',
        suppressWhen: null,
        description: null,
        consequence: null,
        response: null,
        outOfServiceReason: null,
        evaluable: true,
        status: 'ok',
      });
      expect((await createRule({ operator: 'lt', threshold: 10, severity: 'warning' })).kind).toBe(
        'LO',
      );
      expect((await createRule({ operator: 'lte', threshold: 5 })).kind).toBe('LL');
      expect((await createRule({ threshold: 80, severity: 'warning' })).kind).toBe('HI');
    });

    it('acepta racionalización, retardos, ROC y supresión', async () => {
      const r = await createRule({
        kind: 'ROC',
        threshold: 8,
        severity: 'warning',
        rocWindowSeconds: 120,
        rocDirection: 'rise',
        offDelaySeconds: 15,
        description: 'Llenado rápido',
        consequence: 'Rebalse',
        response: 'Cerrar entrada',
        suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 },
      });
      expect(r).toMatchObject({
        kind: 'ROC',
        rocWindowSeconds: 120,
        rocDirection: 'rise',
        offDelaySeconds: 15,
        description: 'Llenado rápido',
        suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 },
      });
      const got = await api.get(`/api/alarm-rules/${r.id}`, tok.engineer).expect(200);
      expect(got.body).toMatchObject({ kind: 'ROC', evaluable: true });
    });

    it.each([
      ['kind HH con operador lt', { kind: 'HH', operator: 'lt' }],
      ['kind LL con operador gt', { kind: 'LL', operator: 'gt' }],
      ['kind DEV con operador lte', { kind: 'DEV', operator: 'lte' }],
      ['kind desconocido', { kind: 'XX' }],
      ['offDelaySeconds negativo', { offDelaySeconds: -1 }],
      ['rocWindowSeconds 9', { rocWindowSeconds: 9 }],
      ['rocWindowSeconds 601', { rocWindowSeconds: 601 }],
      ['descripción de 201 caracteres', { description: 'x'.repeat(201) }],
      ['consecuencia de 301 caracteres', { consequence: 'x'.repeat(301) }],
      [
        'suppressWhen con operador gte',
        { suppressWhen: { asset: 'a', metric: 'm', operator: 'gte', value: 1 } },
      ],
      [
        'suppressWhen con valor texto',
        { suppressWhen: { asset: 'a', metric: 'm', operator: 'eq', value: 'x' } },
      ],
      ['enabled=false sin motivo', { enabled: false }],
      ['enabled=false con motivo corto', { enabled: false, outOfServiceReason: 'ab' }],
    ])('rechaza (400): %s', async (_n, over) => {
      await api.post('/api/alarm-rules', tok.engineer, rule(over)).expect(400);
    });

    it('PATCH: el tipo sigue a operador+severidad, y la coherencia se comprueba contra la regla guardada', async () => {
      const r = await createRule();
      const toWarn = await api
        .patch(`/api/alarm-rules/${r.id}`, tok.engineer, { severity: 'warning' })
        .expect(200);
      expect(toWarn.body.kind).toBe('HI');
      const toLow = await api
        .patch(`/api/alarm-rules/${r.id}`, tok.engineer, { operator: 'lt', severity: 'critical' })
        .expect(200);
      expect(toLow.body.kind).toBe('LL');
      await api.patch(`/api/alarm-rules/${r.id}`, tok.engineer, { kind: 'HH' }).expect(400); // lt exige LO/LL
      await api.patch(`/api/alarm-rules/${r.id}`, tok.engineer, { kind: 'DEV' }).expect(400);
      const dev = await createRule({ kind: 'DEV', threshold: 25 });
      await api.patch(`/api/alarm-rules/${dev.id}`, tok.engineer, { operator: 'lt' }).expect(400);
      const ok = await api
        .patch(`/api/alarm-rules/${dev.id}`, tok.engineer, { severity: 'warning' })
        .expect(200);
      expect(ok.body.kind).toBe('DEV'); // DEV no se re-deriva
      const cleared = await api
        .patch(`/api/alarm-rules/${r.id}`, tok.engineer, {
          description: 'hola',
          suppressWhen: null,
        })
        .expect(200);
      expect(cleared.body).toMatchObject({ description: 'hola', suppressWhen: null });
      const wipe = await api
        .patch(`/api/alarm-rules/${r.id}`, tok.engineer, { description: null })
        .expect(200);
      expect(wipe.body.description).toBeNull();
    });

    it('DEV: sin setpoint la regla no es evaluable y la lista lo dice; con setpoint en el activo sí', async () => {
      const dev = await createRule({ kind: 'DEV', threshold: 25, severity: 'warning' });
      expect(dev).toMatchObject({
        evaluable: false,
        status: 'no_setpoint',
        assetsWithoutSetpoint: ['tk-01'],
      });
      let rules = (await api.get('/api/alarm-rules?plant=demo', tok.engineer).expect(200))
        .body as RuleView[];
      expect(rules.find((r) => r.id === dev.id)).toMatchObject({
        evaluable: false,
        status: 'no_setpoint',
      });

      await api
        .patch('/api/plants/demo/assets/tk-01', tok.engineer, {
          metadata: { setpoints: { level: 60 } },
        })
        .expect(200);
      rules = (await api.get('/api/alarm-rules?plant=demo', tok.engineer).expect(200))
        .body as RuleView[];
      const after = rules.find((r) => r.id === dev.id);
      expect(after).toMatchObject({ evaluable: true, status: 'ok' });
      expect(after).not.toHaveProperty('assetsWithoutSetpoint');
    });

    it('fuera de servicio: enabled=false exige motivo, se audita, y volver a habilitar lo borra', async () => {
      const r = await createRule();
      await api.patch(`/api/alarm-rules/${r.id}`, tok.engineer, { enabled: false }).expect(400);
      const off = await api
        .patch(`/api/alarm-rules/${r.id}`, tok.engineer, {
          enabled: false,
          outOfServiceReason: 'sensor en reparación',
        })
        .expect(200);
      expect(off.body).toMatchObject({
        enabled: false,
        outOfServiceReason: 'sensor en reparación',
        evaluable: false,
        status: 'disabled',
      });
      const audit = await api.get('/api/audit?action=rule.out_of_service', tok.admin).expect(200);
      expect(audit.body).toHaveLength(1);
      expect(audit.body[0]).toMatchObject({
        action: 'rule.out_of_service',
        detail: { plant: 'demo', asset: 'tk-01', metric: 'level', reason: 'sensor en reparación' },
      });
      // editar otra cosa mientras está fuera de servicio no exige repetir el motivo
      await api.patch(`/api/alarm-rules/${r.id}`, tok.engineer, { threshold: 95 }).expect(200);
      expect(
        (await api.get('/api/plants/demo/alarm-kpis', tok.viewer).expect(200)).body.outOfService,
      ).toBe(1);
      const on = await api
        .patch(`/api/alarm-rules/${r.id}`, tok.engineer, { enabled: true })
        .expect(200);
      expect(on.body).toMatchObject({ enabled: true, outOfServiceReason: null, status: 'ok' });
      expect(
        (await api.get('/api/plants/demo/alarm-kpis', tok.viewer).expect(200)).body.outOfService,
      ).toBe(0);
      // crear directamente fuera de servicio también lo audita
      await createRule({ enabled: false, outOfServiceReason: 'en obra', metric: 'temp' });
      expect((await api.get('/api/audit?action=rule.out_of_service', tok.admin)).body).toHaveLength(
        2,
      );
    });

    it('GET /plants/:plant/limits: incluye kind y omite DEV y ROC (no son un límite fijo)', async () => {
      await createRule({ threshold: 90 });
      await createRule({ operator: 'lt', threshold: 10, severity: 'warning' });
      await createRule({ kind: 'DEV', threshold: 25 });
      await createRule({ kind: 'ROC', threshold: 8 });
      const lim = (await api.get('/api/plants/demo/limits', tok.viewer).expect(200))
        .body as Limit[];
      expect(lim.map((l) => [l.operator, l.threshold, l.kind])).toEqual([
        ['lt', 10, 'LO'],
        ['gt', 90, 'HH'],
      ]);
    });

    it('metadata.setpoints se valida al crear y editar activos', async () => {
      const bad = [{ level: '60' }, { level: null }, [60], 60, { 'a b': 1 }];
      for (const setpoints of bad) {
        await api
          .patch('/api/plants/demo/assets/tk-01', tok.engineer, { metadata: { setpoints } })
          .expect(400);
        await api
          .post('/api/plants/demo/assets', tok.engineer, {
            id: 'tk-09',
            name: 'T',
            type: 'tank',
            metadata: { setpoints },
          })
          .expect(400);
      }
      await api
        .post('/api/plants/demo/assets', tok.engineer, {
          id: 'tk-09',
          name: 'T',
          type: 'tank',
          metadata: { setpoints: { level: 60, temp: 20.5 } },
        })
        .expect(201);
    });
  });

  describe('flujo completo (HH con racionalización)', () => {
    const hh = () =>
      createRule({
        hysteresis: 5,
        description: 'Nivel muy alto',
        consequence: 'Rebalse del tanque',
        response: 'Cerrar la válvula de entrada',
      });

    it('telemetría -> unacked (WS con campos nuevos) -> ack -> acked -> normaliza -> closed', async () => {
      const ws = await openWs();
      const r = await hh();
      await level(50);
      expect(await list('active')).toEqual([]);
      await level(95);
      await until(() => ws.length >= 1);
      expect(ws[0]).toMatchObject({
        ruleId: r.id,
        state: 'active',
        lifecycle: 'unacked',
        kind: 'HH',
        acknowledged: false,
        rationale: {
          description: 'Nivel muy alto',
          consequence: 'Rebalse del tanque',
          response: 'Cerrar la válvula de entrada',
        },
      });
      const [a] = await list('active');
      expect(a).toMatchObject({
        lifecycle: 'unacked',
        kind: 'HH',
        rationale: { consequence: 'Rebalse del tanque' },
      });

      await api.post(`/api/alarms/${a.id}/ack`, tok.operator).expect(200);
      await until(() => ws.length >= 2);
      expect(ws[1]).toMatchObject({
        id: a.id,
        state: 'active',
        lifecycle: 'acked',
        acknowledged: true,
      });
      expect((await list('active'))[0].lifecycle).toBe('acked');

      await level(88); // banda muerta: sigue
      expect(await list('active')).toHaveLength(1);
      await level(80);
      await until(() => ws.length >= 3);
      expect(ws[2]).toMatchObject({ id: a.id, state: 'cleared', lifecycle: 'closed', kind: 'HH' });
      expect(await list('active')).toEqual([]);
      expect((await list('cleared')).map((x) => [x.id, x.lifecycle])).toEqual([[a.id, 'closed']]);
      expect(await t.redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({});

      const j = (await api.get(`/api/alarms/${a.id}/journal`, tok.viewer).expect(200)).body as {
        type: string;
        userEmail: string | null;
      }[];
      expect(j.map((e) => e.type)).toEqual(['activate', 'ack', 'rtn', 'close']);
      expect(j[0].userEmail).toBeNull();
      expect(j[1].userEmail).toBe('operator@campo.test');
    });

    it('normalizada sin reconocer (rtn_unacked) sigue en la lista hasta que alguien la reconoce', async () => {
      const ws = await openWs();
      await hh();
      await level(95);
      await level(60);
      await until(() => ws.length >= 2);
      expect(ws[1]).toMatchObject({
        state: 'cleared',
        lifecycle: 'rtn_unacked',
        acknowledged: false,
      });
      const [a] = await list('active');
      expect(a).toMatchObject({ state: 'cleared', lifecycle: 'rtn_unacked' });
      expect(await list('cleared')).toEqual([]);

      const acked = await api.post(`/api/alarms/${a.id}/ack`, tok.operator).expect(200);
      expect(acked.body).toMatchObject({
        lifecycle: 'closed',
        state: 'cleared',
        acknowledged: true,
      });
      await until(() => ws.length >= 3);
      expect(ws[2]).toMatchObject({ state: 'cleared', lifecycle: 'closed' });
      expect(await list('active')).toEqual([]);
      expect(await list('cleared')).toHaveLength(1);
    });
  });

  describe('postergar (shelving)', () => {
    async function activeAlarm() {
      await createRule({ hysteresis: 5 });
      await level(95);
      return (await list('active'))[0];
    }
    const engine = () => t.app.get(AlarmEngine);

    it('roles: engineer, admin y platform_admin sí; operator y viewer no', async () => {
      const a = await activeAlarm();
      const body = { minutes: 30, reason: 'mantenimiento programado' };
      await api.post(`/api/alarms/${a.id}/shelve`, tok.viewer, body).expect(403);
      await api.post(`/api/alarms/${a.id}/shelve`, tok.operator, body).expect(403);
      await api.post(`/api/alarms/${a.id}/unshelve`, tok.operator).expect(403);
      await api.post(`/api/alarms/${a.id}/shelve`, tok.engineer, body).expect(200);
      await api.post(`/api/alarms/${a.id}/unshelve`, tok.admin).expect(200);
      await api.post(`/api/alarms/${a.id}/shelve`, tok.platform_admin, body).expect(200);
    });

    it.each([
      ['minutes 0', { minutes: 0, reason: 'abc' }],
      ['minutes 481', { minutes: 481, reason: 'abc' }],
      ['minutes decimal', { minutes: 1.5, reason: 'abc' }],
      ['motivo corto', { minutes: 5, reason: 'ab' }],
      ['sin motivo', { minutes: 5 }],
      ['campo extra', { minutes: 5, reason: 'abc', x: 1 }],
    ])('valida el cuerpo (400): %s', async (_n, body) => {
      const a = await activeAlarm();
      await api.post(`/api/alarms/${a.id}/shelve`, tok.engineer, body).expect(400);
      await api
        .post('/api/alarms/no-es-uuid/shelve', tok.engineer, { minutes: 5, reason: 'abc' })
        .expect(400);
      await api
        .post('/api/alarms/00000000-0000-4000-8000-0000000000bb/shelve', tok.engineer, {
          minutes: 5,
          reason: 'abc',
        })
        .expect(404);
    });

    it('desaparece de las activas, se difunde como shelved y vuelve al vencer (reanuncio)', async () => {
      const ws = await openWs();
      const a = await activeAlarm();
      await until(() => ws.length >= 1);
      const res = await api
        .post(`/api/alarms/${a.id}/shelve`, tok.engineer, {
          minutes: 15,
          reason: 'bomba en mantenimiento',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        lifecycle: 'shelved',
        state: 'active',
        shelvedReason: 'bomba en mantenimiento',
      });
      expect(res.body.shelvedUntil).toBeGreaterThan(Date.now() + 14 * 60_000);
      await until(() => ws.length >= 2);
      expect(ws[1]).toMatchObject({
        id: a.id,
        lifecycle: 'shelved',
        shelvedReason: 'bomba en mantenimiento',
      });
      expect(typeof ws[1].shelvedUntil).toBe('number');

      expect(await list('active')).toEqual([]);
      expect((await list('shelved')).map((x) => x.id)).toEqual([a.id]);
      expect(await list('cleared')).toEqual([]);
      expect(await t.redis.hgetall(redisKeys.activeAlarms('demo'))).toEqual({});
      expect((await api.get('/api/plants/demo/alarm-kpis', tok.viewer)).body.shelved).toBe(1);

      // mientras sigue la condición no se genera otra alarma ni se difunde nada nuevo
      await level(99);
      expect(ws).toHaveLength(2);
      expect(t.alarms.alarms.size).toBe(1);

      // llega el vencimiento (reloj adelantado): la alarma se reanuncia sin reconocer
      expect(await engine().expireDue(Date.now() + 16 * 60_000)).toBe(1);
      await until(() => ws.length >= 3);
      expect(ws[2]).toMatchObject({ id: a.id, lifecycle: 'unacked', acknowledged: false });
      expect(ws[2]).not.toHaveProperty('shelvedUntil');
      expect((await list('active')).map((x) => x.lifecycle)).toEqual(['unacked']);
      expect(await list('shelved')).toEqual([]);
      expect(Object.keys(await t.redis.hgetall(redisKeys.activeAlarms('demo')))).toHaveLength(1);

      const j = (await api.get(`/api/alarms/${a.id}/journal`, tok.viewer)).body as {
        type: string;
        note: string | null;
      }[];
      expect(j.map((e) => e.type)).toEqual(['activate', 'shelve', 'unshelve']);
      expect(j[1].note).toBe('15 min: bomba en mantenimiento');
      expect(j[2].note).toBe('vencimiento');
    });

    it('conflictos (409): postergar dos veces, levantar una no postergada, reconocer una postergada', async () => {
      const a = await activeAlarm();
      const body = { minutes: 5, reason: 'abc' };
      await api.post(`/api/alarms/${a.id}/unshelve`, tok.engineer).expect(409);
      await api.post(`/api/alarms/${a.id}/shelve`, tok.engineer, body).expect(200);
      await api.post(`/api/alarms/${a.id}/shelve`, tok.engineer, body).expect(409);
      await api.post(`/api/alarms/${a.id}/ack`, tok.operator).expect(409);
      await api.post(`/api/alarms/${a.id}/unshelve`, tok.engineer).expect(200);
      await level(60); // normaliza sin reconocer -> rtn_unacked: ya no se puede postergar
      await api.post(`/api/alarms/${a.id}/shelve`, tok.engineer, body).expect(409);
    });

    it('queda auditado (alarm.shelve / alarm.unshelve) sin el motivo', async () => {
      const a = await activeAlarm();
      await api
        .post(`/api/alarms/${a.id}/shelve`, tok.engineer, {
          minutes: 5,
          reason: 'secreto operativo',
        })
        .expect(200);
      await api.post(`/api/alarms/${a.id}/unshelve`, tok.engineer).expect(200);
      const entries = (await api.get('/api/audit?limit=50', tok.admin)).body as {
        action: string;
        detail: object;
      }[];
      const mine = entries.filter((e) => e.action.startsWith('alarm.'));
      expect(mine.map((e) => e.action).sort()).toEqual(['alarm.shelve', 'alarm.unshelve']);
      expect(JSON.stringify(mine)).not.toContain('secreto');
    });
  });

  describe('supresión por estado', () => {
    it('con la bomba parada no hay alarma, queda entrada en el diario y se cuenta; al arrancar, alarma', async () => {
      const r = await createRule({
        suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 },
      });
      await telemetry('pump-01', { rpm: 0 });
      await level(95);
      await level(96);
      expect(await list('active')).toEqual([]);
      expect(t.alarms.alarms.size).toBe(0);
      const sup = t.journal.entries.filter((e) => e.type === 'suppress');
      expect(sup).toHaveLength(1);
      expect(sup[0]).toMatchObject({
        alarmId: null,
        plant: 'demo',
        ruleId: r.id,
        asset: 'tk-01',
        metric: 'level',
        value: 95,
      });
      expect(
        (await api.get('/api/plants/demo/alarm-kpis?window=24h', tok.viewer)).body.suppressed,
      ).toBe(1);

      await telemetry('pump-01', { rpm: 1450 });
      await level(97);
      const [a] = await list('active');
      expect(a).toMatchObject({ ruleId: r.id, lifecycle: 'unacked' });
    });
  });

  describe('DEV y ROC por la ruta real', () => {
    it('DEV con SP del catálogo y con SP de la telemetría (manda la telemetría)', async () => {
      await api
        .patch('/api/plants/demo/assets/tk-01', tok.engineer, {
          metadata: { setpoints: { level: 60 } },
        })
        .expect(200);
      await createRule({ kind: 'DEV', threshold: 25, severity: 'warning', hysteresis: 2 });
      await level(80);
      expect(await list('active')).toEqual([]);
      await telemetry('tk-01', { level: 90 });
      const [a] = await list('active');
      expect(a).toMatchObject({ kind: 'DEV', value: 30, threshold: 25 });
      await telemetry('tk-01', { level: 60, level_sp: 20 }); // SP 20: desviación 40, sigue activa
      expect((await list('active'))[0].lifecycle).toBe('unacked');
    });

    it('ROC: la tasa se calcula sobre la ventana (muestras con marca de tiempo del motor)', async () => {
      await createRule({ kind: 'ROC', threshold: 8, severity: 'warning', rocWindowSeconds: 10 });
      const eng = t.app.get(AlarmEngine);
      const base = Date.now();
      const sample = (v: number, dt: number) =>
        eng.onTelemetry(
          {
            type: 'telemetry',
            plant: 'demo',
            asset: 'tk-01',
            ts: base + dt,
            quality: 'good',
            values: { level: v },
          },
          base + dt,
        );
      for (let s = 0; s <= 10; s += 2) sample(50 + s * 0.4, s * 1000); // 24/min
      await eng.idle();
      const [a] = await list('active');
      expect(a).toMatchObject({ kind: 'ROC' });
      expect(a.value).toBeGreaterThan(20);
    });
  });

  describe('política y KPIs', () => {
    it('política: lectura para cualquier rol con acceso; escritura sólo admin y platform_admin', async () => {
      for (const role of ['viewer', 'operator', 'engineer', 'admin', 'platform_admin'] as const) {
        const r = await api.get('/api/plants/demo/alarm-policy', tok[role]).expect(200);
        expect(r.body).toEqual({ ratePerDay: 150, peak10min: 10, staleHours: 24 });
      }
      const next = { ratePerDay: 100, peak10min: 8, staleHours: 12 };
      for (const role of ['viewer', 'operator', 'engineer'] as const) {
        await api.put('/api/plants/demo/alarm-policy', tok[role], next).expect(403);
      }
      const saved = await api.put('/api/plants/demo/alarm-policy', tok.admin, next).expect(200);
      expect(saved.body).toEqual(next);
      expect((await api.get('/api/plants/demo/alarm-policy', tok.viewer)).body).toEqual(next);
      await api
        .put('/api/plants/demo/alarm-policy', tok.platform_admin, { ...next, ratePerDay: 90 })
        .expect(200);
      const audit = (await api.get('/api/audit?action=plant.alarm_policy', tok.admin)).body as {
        detail: object;
      }[];
      expect(audit).toHaveLength(2);
      expect(audit[1].detail).toEqual(next);
    });

    it.each([
      { ratePerDay: 0, peak10min: 10, staleHours: 24 },
      { ratePerDay: 150, peak10min: 10 },
      { ratePerDay: 150, peak10min: 10, staleHours: 721 },
      { ratePerDay: 'x', peak10min: 10, staleHours: 24 },
      { ratePerDay: 150, peak10min: 10, staleHours: 24, extra: true },
    ])('política inválida -> 400: %j', async (body) => {
      await api.put('/api/plants/demo/alarm-policy', tok.admin, body).expect(400);
    });

    it('KPIs con 200 activaciones concentradas: números exactos y forma exacta de AlarmKpis', async () => {
      const now = Date.now();
      const T0 = now - 3 * 3_600_000;
      for (let i = 0; i < 200; i++) {
        const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
        t.alarms.alarms.set(id, {
          type: 'alarm',
          id,
          ruleId: 'r-a',
          plant: 'demo',
          asset: 'tk-01',
          metric: 'level',
          severity: i % 4 === 0 ? 'warning' : 'critical',
          state: 'cleared',
          value: 99,
          threshold: 90,
          ts: T0 + i * 2_000,
          message: 'm',
          acknowledged: true,
          lifecycle: 'closed',
          kind: 'HH',
        });
      }
      const res = await api.get('/api/plants/demo/alarm-kpis?window=24h', tok.viewer).expect(200);
      const k = res.body as AlarmKpis;
      expect(Object.keys(k).sort()).toEqual(
        [
          'window',
          'from',
          'to',
          'policy',
          'total',
          'perDay',
          'perHour',
          'peak10min',
          'byPriority',
          'top',
          'chattering',
          'stale',
          'shelved',
          'suppressed',
          'outOfService',
          'status',
        ].sort(),
      );
      expect(k).toMatchObject({
        window: '24h',
        total: 200,
        perDay: 200,
        perHour: 200 / 24,
        peak10min: { count: 200, at: T0 },
        byPriority: { critical: 150, warning: 50 },
        top: [{ ruleId: 'r-a', asset: 'tk-01', metric: 'level', kind: 'HH', count: 200 }],
        chattering: [{ ruleId: 'r-a', asset: 'tk-01', metric: 'level', activations10min: 200 }],
        stale: [],
        shelved: 0,
        suppressed: 0,
        outOfService: 0,
        status: 'critical',
        policy: { ratePerDay: 150, peak10min: 10, staleHours: 24 },
      });
      expect(k.to - k.from).toBe(86_400_000);
      const k7 = (await api.get('/api/plants/demo/alarm-kpis?window=7d', tok.viewer))
        .body as AlarmKpis;
      expect(k7).toMatchObject({ window: '7d', total: 200, perDay: 200 / 7, perHour: 200 / 168 });
      expect((await api.get('/api/plants/demo/alarm-kpis', tok.viewer)).body.window).toBe('24h');
      await api.get('/api/plants/demo/alarm-kpis?window=1h', tok.viewer).expect(400);
      await api.get('/api/plants/demo/alarm-kpis', undefined as unknown as string).expect(401);
    });
  });

  describe('lista de alarmas: semántica de ?state', () => {
    it('active = unacked|acked|rtn_unacked; cleared = closed; shelved = postergadas', async () => {
      await createRule({ asset: 'tk-*' });
      await createRule({ asset: 'tk-*', metric: 'temp', threshold: 30, severity: 'warning' });
      const mk = (
        id: string,
        lifecycle: AlarmRecord['lifecycle'],
        state: 'active' | 'cleared',
        n: number,
      ) =>
        t.alarms.alarms.set(id, {
          type: 'alarm',
          id,
          ruleId: 'r',
          plant: 'demo',
          asset: 'tk-01',
          metric: 'level',
          severity: 'critical',
          state,
          value: 1,
          threshold: 1,
          ts: n,
          message: id,
          acknowledged: lifecycle === 'acked' || lifecycle === 'closed',
          lifecycle,
        });
      mk('00000000-0000-4000-8000-000000000001', 'unacked', 'active', 1);
      mk('00000000-0000-4000-8000-000000000002', 'acked', 'active', 2);
      mk('00000000-0000-4000-8000-000000000003', 'rtn_unacked', 'cleared', 3);
      mk('00000000-0000-4000-8000-000000000004', 'closed', 'cleared', 4);
      mk('00000000-0000-4000-8000-000000000005', 'shelved', 'active', 5);
      const ids = async (s: string) => (await list(s)).map((a) => a.id.slice(-1)).sort();
      expect(await ids('active')).toEqual(['1', '2', '3']);
      expect(await ids('cleared')).toEqual(['4']);
      expect(await ids('shelved')).toEqual(['5']);
      expect((await api.get('/api/alarms', tok.viewer).expect(200)).body).toHaveLength(5);
    });
  });
});
