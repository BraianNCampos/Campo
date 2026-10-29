import type { AddressInfo } from 'node:net';
import { redisKeys } from '@campo/shared';
import { WebSocket } from 'ws';
import { createTestApp, TestApp } from './support/test-app';

interface Msg {
  type: string;
  [k: string]: unknown;
}

function open(url: string): Promise<{ ws: WebSocket; messages: Msg[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Msg[] = [];
    ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString()) as Msg));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('error', reject);
    ws.on('unexpected-response', () => reject(new Error('unexpected-response')));
  });
}

const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('WebSocket /ws (e2e, ws nativo)', () => {
  let t: TestApp;
  let base: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    base = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('cierra con 4401 sin token válido', async () => {
    const { closed } = await open(`${base}?plant=demo&token=falso`);
    expect(await closed).toBe(4401);
  });

  it('envía snapshot y luego telemetría coalescida y alarmas de su planta', async () => {
    const token = await t.tokenFor('viewer');
    const state = { ts: 1, values: { level: 40 }, quality: 'good' };
    await t.redis.hset(redisKeys.state('demo'), 'tk-01', JSON.stringify(state));

    const { ws, messages } = await open(`${base}?plant=demo&token=${token}`);
    await until(() => messages.length >= 1);
    expect(messages[0]).toEqual({ type: 'snapshot', plant: 'demo', assets: { 'tk-01': state } });

    const publish = (plant: string, asset: string, level: number) =>
      t.redis.publish(
        redisKeys.events(plant),
        JSON.stringify({
          type: 'telemetry',
          plant,
          asset,
          ts: Date.now(),
          quality: 'good',
          values: { level },
        }),
      );
    for (let i = 1; i <= 10; i++) await publish('demo', 'tk-01', i);
    await publish('otra', 'tk-01', 99); // otra planta: no debe llegar
    await until(() => messages.some((m) => m.type === 'telemetry'));
    await new Promise((r) => setTimeout(r, 250));

    const telemetry = messages.filter((m) => m.type === 'telemetry');
    expect(telemetry.length).toBeLessThan(10);
    expect(telemetry.every((m) => m.plant === 'demo')).toBe(true);
    expect(telemetry.at(-1)).toMatchObject({ asset: 'tk-01', values: { level: 10 } });

    await t.redis.publish(
      redisKeys.alarms('demo'),
      JSON.stringify({ type: 'alarm', id: 'a1', plant: 'demo', asset: 'tk-01', state: 'active' }),
    );
    await until(() => messages.some((m) => m.type === 'alarm'));
    ws.close();
  });
});
