import { describe, expect, it, vi } from 'vitest';
import { AdminApiError } from './errors';
import { HttpAlarmsApi, parseJournal, toAlarm, validatePolicy, validateShelve } from './alarms-api';

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function setup(respond: (c: Call) => Response | Error) {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fakeFetch = (async (url: string, init: Call['init']) => {
    const c = { url, init };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { api: new HttpAlarmsApi({ baseUrl: 'https://api.test', getToken: () => 'tok', onUnauthorized, fetch: fakeFetch }), calls, onUnauthorized };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rec = { id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 5, message: 'm', kind: 'HH', lifecycle: 'unacked', rationale: { description: 'd', consequence: 'c', response: 'r' } };

describe('HttpAlarmsApi', () => {
  it('lista por estado con Bearer y convierte los registros (con rationale y kind)', async () => {
    const { api, calls } = setup(() => json([rec, { id: 'sin-campos' }]));
    const list = await api.listAlarms({ state: 'shelved', plant: 'demo' });
    expect(calls[0]!.url).toBe('https://api.test/api/alarms?state=shelved&plant=demo');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer tok');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'alarm', kind: 'HH', lifecycle: 'unacked', rationale: { consequence: 'c' } });
  });

  it('ack, shelve y unshelve usan las rutas del contrato', async () => {
    const { api, calls } = setup(() => json({ ...rec, lifecycle: 'shelved', shelvedUntil: 99, shelvedReason: 'x' }));
    await api.ack('a/1');
    const s = await api.shelve('a1', { minutes: 30, reason: 'sensor' });
    await api.unshelve('a1');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.test', '')}`)).toEqual(['POST /api/alarms/a%2F1/ack', 'POST /api/alarms/a1/shelve', 'POST /api/alarms/a1/unshelve']);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ minutes: 30, reason: 'sensor' });
    expect(s).toMatchObject({ lifecycle: 'shelved', shelvedUntil: 99, shelvedReason: 'x' });
  });

  it('política, KPIs y diario', async () => {
    const policy = { ratePerDay: 150, peak10min: 10, staleHours: 24 };
    const { api, calls } = setup((c) =>
      c.url.includes('alarm-kpis')
        ? json({ window: '7d', from: 1, to: 2, policy, total: 3, perDay: 0.4, perHour: 0.02, peak10min: { count: 2, at: null }, byPriority: { critical: 1, warning: 2 }, top: [{ ruleId: 'r', asset: 'a', metric: 'm', kind: 'HI', count: 3 }], chattering: [], stale: [], shelved: 1, suppressed: 0, outOfService: 2, status: 'warning' })
        : c.url.includes('journal')
          ? json([{ at: 20, type: 'ack', actorEmail: 'a@b.c' }, { ts: 10, event: 'activation' }, { junk: true }])
          : json(policy),
    );
    expect(await api.getPolicy('demo')).toEqual(policy);
    await api.setPolicy('demo', { ...policy, ratePerDay: 100 });
    expect(calls[1]!.init.method).toBe('PUT');
    expect(calls[1]!.url).toBe('https://api.test/api/plants/demo/alarm-policy');
    const k = await api.kpis('demo', '7d');
    expect(calls[2]!.url).toBe('https://api.test/api/plants/demo/alarm-kpis?window=7d');
    expect(k).toMatchObject({ window: '7d', total: 3, status: 'warning', outOfService: 2, top: [{ count: 3 }] });
    expect(await api.journal('a1')).toEqual([
      { ts: 10, event: 'activated', actor: null },
      { ts: 20, event: 'acknowledged', actor: 'a@b.c' },
    ]);
  });

  it('errores en voseo: 403 por acción, 409, 400 con lista, red y 401', async () => {
    const forbidden = setup(() => json({ message: 'Forbidden resource' }, 403));
    await expect(forbidden.api.ack('a1')).rejects.toThrow(/Tu rol no permite reconocer/);
    await expect(forbidden.api.shelve('a1', { minutes: 5, reason: 'abc' })).rejects.toThrow(/ingeniería y administración/);
    await expect(forbidden.api.setPolicy('demo', { ratePerDay: 1, peak10min: 1, staleHours: 1 })).rejects.toThrow(/sólo para administración/);

    const conflict = setup(() => json({ message: 'Conflict' }, 409));
    await expect(conflict.api.ack('a1')).rejects.toMatchObject({ status: 409, kind: 'conflict', message: expect.stringMatching(/cambió de estado/) });

    const bad = setup(() => json({ message: ['minutes must not be greater than 480', 'reason must be longer than or equal to 3 characters'] }, 400));
    const err = await bad.api.shelve('a1', { minutes: 999, reason: 'a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).details).toHaveLength(2);

    const net = setup(() => new Error('boom'));
    await expect(net.api.listAlarms({ state: 'active' })).rejects.toMatchObject({ kind: 'network' });

    const unauth = setup(() => json({}, 401));
    await expect(unauth.api.listAlarms({ state: 'active' })).rejects.toBeInstanceOf(AdminApiError);
    expect(unauth.onUnauthorized).toHaveBeenCalledOnce();
  });

  it('HTML de un proxy en una respuesta 200 es una respuesta inesperada', async () => {
    const { api } = setup(() => new Response('<html>', { status: 200 }));
    await expect(api.listAlarms({ state: 'active' })).rejects.toMatchObject({ status: 502 });
  });
});

describe('validación y parseo', () => {
  it('validateShelve: minutos 1–480 enteros, motivo ≥ 3', () => {
    expect(validateShelve('30', ' sensor ').value).toEqual({ minutes: 30, reason: 'sensor' });
    expect(validateShelve(0, 'abc').errors.minutes).toBeDefined();
    expect(validateShelve(481, 'abc').errors.minutes).toBeDefined();
    expect(validateShelve('1.5', 'abc').errors.minutes).toBeDefined();
    expect(validateShelve('', 'abc').errors.minutes).toBeDefined();
    expect(validateShelve(480, 'ab').errors.reason).toBeDefined();
    expect(validateShelve(480, '  a ').errors.reason).toBeDefined();
  });
  it('validatePolicy: rangos', () => {
    expect(validatePolicy({ ratePerDay: '150', peak10min: '10', staleHours: '24' }).value).toEqual({ ratePerDay: 150, peak10min: 10, staleHours: 24 });
    expect(validatePolicy({ ratePerDay: '150.5', peak10min: '10', staleHours: '24' }).errors.ratePerDay).toBeDefined(); // la API pide enteros
    const e = validatePolicy({ ratePerDay: '0', peak10min: 'x', staleHours: '' }).errors;
    expect(Object.keys(e)).toEqual(['ratePerDay', 'peak10min', 'staleHours']);
  });
  it('toAlarm descarta registros incompletos y valores inválidos', () => {
    expect(toAlarm({ ...rec, severity: 'nope' })).toBeNull();
    expect(toAlarm({ ...rec, kind: 'XX', lifecycle: 'raro' })).toMatchObject({ id: 'a1' });
    expect(toAlarm({ ...rec, kind: 'XX' })?.kind).toBeUndefined();
    expect(toAlarm(null)).toBeNull();
    expect(toAlarm({ ...rec, state: 'cleared', clearedAt: 77 })).toMatchObject({ clearedAt: 77 });
  });
  it('parseJournal con la forma real de la API (type/userEmail/note)', () => {
    expect(
      parseJournal([
        { id: '2', ts: 20, type: 'rtn', userId: null, userEmail: null, note: null, value: 88.5 },
        { id: '1', ts: 10, type: 'shelve', userId: 'u', userEmail: 'ing@campo.demo', note: '30 min · sensor', value: null },
        { id: '3', ts: 30, type: 'close', userEmail: 'op@campo.demo' },
      ]),
    ).toEqual([
      { ts: 10, event: 'shelved', actor: 'ing@campo.demo', detail: '30 min · sensor' },
      { ts: 20, event: 'cleared', actor: null, value: 88.5 },
      { ts: 30, event: 'closed', actor: 'op@campo.demo' },
    ]);
  });
  it('parseJournal acepta {events:[…]}', () => {
    expect(parseJournal({ events: [{ ts: 1, event: 'shelved', reason: 'por mantenimiento', by: 'x@y.z' }] })).toEqual([{ ts: 1, event: 'shelved', actor: 'x@y.z', detail: 'por mantenimiento' }]);
  });
});
