import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@campo/shared';
import { MockAlarmsApi } from './alarm-api';
import { AlarmEngine, registerDemoEngine, unregisterDemoEngine, type DemoRule } from './alarm-lifecycle';

const rule: DemoRule = {
  id: 'tk-01:level:HH', asset: 'tk-01', metric: 'level', kind: 'HH', severity: 'critical', operator: 'gt', threshold: 90, deadband: 2,
  onDelayS: 0, offDelayS: 0, rationale: { description: 'd', consequence: 'c', response: 'r' },
};

function setup(role: Role) {
  const engine = new AlarmEngine({ plant: 'demo', rules: [rule] });
  registerDemoEngine(engine);
  engine.ingest('tk-01', { level: 95 });
  engine.step(1000);
  const id = engine.list('active')[0]!.id;
  const api = new MockAlarmsApi({ role: () => role, actor: () => 'yo@campo.demo', now: () => 2000 });
  return { engine, api, id };
}

describe('MockAlarmsApi (demo): permisos por rol y errores en voseo', () => {
  let engine: AlarmEngine | undefined;
  afterEach(() => engine && unregisterDemoEngine(engine));

  it('operator reconoce pero no posterga; viewer no reconoce', async () => {
    const op = setup('operator');
    engine = op.engine;
    await expect(op.api.shelve(op.id, { minutes: 15, reason: 'prueba' })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/ingeniería y administración/) });
    expect((await op.api.ack(op.id))?.lifecycle).toBe('acked');
    expect((await op.api.journal(op.id)).at(-1)).toMatchObject({ event: 'acknowledged', actor: 'yo@campo.demo' });

    const viewer = new MockAlarmsApi({ role: () => 'viewer', actor: () => 'v', now: () => 2000 });
    await expect(viewer.ack(op.id)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Tu rol no permite reconocer/) });
  });

  it('engineer posterga con validación (400) y ve la alarma postergada; luego la reactiva', async () => {
    const { engine: e, api, id } = setup('engineer');
    engine = e;
    await expect(api.shelve(id, { minutes: 999, reason: 'a' })).rejects.toMatchObject({ status: 400 });
    const sh = await api.shelve(id, { minutes: 60, reason: 'mantenimiento' });
    expect(sh).toMatchObject({ lifecycle: 'shelved', shelvedReason: 'mantenimiento' });
    expect(await api.listAlarms({ state: 'shelved', plant: 'demo' })).toHaveLength(1);
    expect(await api.listAlarms({ state: 'active', plant: 'demo' })).toHaveLength(0);
    await api.unshelve(id);
    await expect(api.unshelve(id)).rejects.toMatchObject({ status: 409 });
  });

  it('política: sólo admin edita; el resto la lee; se valida', async () => {
    const { engine: e, id: _id } = setup('admin');
    engine = e;
    void _id;
    const admin = new MockAlarmsApi({ role: () => 'admin', actor: () => 'a' });
    const eng = new MockAlarmsApi({ role: () => 'engineer', actor: () => 'e' });
    expect((await eng.getPolicy('demo')).ratePerDay).toBe(150);
    await expect(eng.setPolicy('demo', { ratePerDay: 100, peak10min: 10, staleHours: 24 })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/sólo para administración/) });
    await expect(admin.setPolicy('demo', { ratePerDay: 0, peak10min: 10, staleHours: 24 })).rejects.toMatchObject({ status: 400 });
    expect((await admin.setPolicy('demo', { ratePerDay: 100, peak10min: 8, staleHours: 12 })).peak10min).toBe(8);
    expect((await eng.kpis('demo', '24h')).policy.ratePerDay).toBe(100);
  });

  it('alarma inexistente → 404 en voseo', async () => {
    const { engine: e, api } = setup('admin');
    engine = e;
    await expect(api.ack('nope')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/No encontramos esa alarma/) });
  });
});
