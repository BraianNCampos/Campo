import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@campo/shared';
import { LiveClient, type WsLike } from './ws-client';

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  sent: unknown[] = [];
  close() {
    this.closed = true;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() { this.onopen?.({}); }
  serve(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}

const snapshot = { type: 'snapshot', plant: 'demo', assets: { a: { ts: 1, values: { v: 1 }, quality: 'good' } } };

function make(over: Partial<ConstructorParameters<typeof LiveClient>[0]> = {}) {
  const statuses: [string, number][] = [];
  const messages: ServerMessage[] = [];
  const client = new LiveClient({
    buildUrl: () => 'ws://test/ws?plant=demo&token=t',
    onMessage: (m) => messages.push(m),
    onStatus: (s, a) => statuses.push([s, a]),
    createSocket: (url) => new FakeWs(url),
    backoff: { baseMs: 1000, maxMs: 8000, factor: 2, jitter: 0 },
    rng: () => 0,
    ...over,
  });
  return { client, statuses, messages };
}

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('LiveClient', () => {
  it('conecta, valida mensajes y descarta basura', () => {
    const { client, messages, statuses } = make();
    client.start();
    const ws = FakeWs.all[0]!;
    expect(ws.url).toContain('token=t');
    ws.open();
    ws.serve(snapshot);
    ws.onmessage?.({ data: 'no-json' });
    ws.serve({ type: 'desconocido' });
    expect(messages).toHaveLength(1);
    expect(statuses.map((s) => s[0])).toEqual(['connecting', 'open']);
  });

  it('reconecta con backoff exponencial y reinicia al recibir un snapshot', () => {
    const { client, statuses } = make();
    client.start();
    FakeWs.all[0]!.drop();
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2); // 1er reintento tras 1000 ms

    FakeWs.all[1]!.drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWs.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(3); // 2º tras 2000 ms

    FakeWs.all[2]!.open();
    FakeWs.all[2]!.serve(snapshot); // conexión sana → attempt=0
    FakeWs.all[2]!.drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all).toHaveLength(4); // vuelve a 1000 ms
    expect(statuses.some(([s]) => s === 'reconnecting')).toBe(true);
  });

  it('el retardo se acota en maxMs', () => {
    const { client } = make();
    client.start();
    for (let i = 0; i < 6; i++) {
      FakeWs.all.at(-1)!.drop();
      vi.advanceTimersByTime(8000);
    }
    const before = FakeWs.all.length;
    FakeWs.all.at(-1)!.drop();
    vi.advanceTimersByTime(7999);
    expect(FakeWs.all).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(before + 1);
  });

  it('stop() cancela reintentos y cierra el socket', () => {
    const { client, statuses } = make();
    client.start();
    const ws = FakeWs.all[0]!;
    client.stop();
    expect(ws.closed).toBe(true);
    ws.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(statuses.at(-1)).toEqual(['idle', 0]);
  });

  it('código de cierre de autenticación → unauthorized y sin reintentos', () => {
    const { client, statuses } = make();
    client.start();
    FakeWs.all[0]!.drop(4401);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(statuses.at(-1)).toEqual(['unauthorized', 0]);
  });

  it('sin token (buildUrl=null) no abre socket', () => {
    const { client, statuses } = make({ buildUrl: () => null });
    client.start();
    expect(FakeWs.all).toHaveLength(0);
    expect(statuses.at(-1)).toEqual(['unauthorized', 0]);
  });

  it('retryNow salta la espera pendiente', () => {
    const { client } = make();
    client.start();
    FakeWs.all[0]!.drop();
    client.retryNow();
    expect(FakeWs.all).toHaveLength(2);
  });

  describe('sincronización de reloj (§13)', () => {
    const sink = () => {
      const calls = { sync: [] as number[][], ingest: [] as [string, number][], resets: 0 };
      return {
        calls,
        latency: {
          addSync: (a: number, b: number, c: number) => calls.sync.push([a, b, c]),
          noteIngest: (asset: string, ts: number) => calls.ingest.push([asset, ts]),
          reset: () => calls.resets++,
        },
      };
    };

    it('envía {type:time,t0} al conectar y cada 10 s', () => {
      const { latency } = sink();
      let clock = 1000;
      const { client } = make({ latency, now: () => clock });
      client.start();
      const ws = FakeWs.all[0]!;
      ws.open();
      expect(ws.sent).toEqual([{ type: 'time', t0: 1000 }]);
      clock = 11_000;
      vi.advanceTimersByTime(10_000);
      expect(ws.sent).toEqual([{ type: 'time', t0: 1000 }, { type: 'time', t0: 11_000 }]);
      client.stop();
      vi.advanceTimersByTime(30_000);
      expect(ws.sent).toHaveLength(2); // parado: no sigue enviando
    });

    it('la respuesta se procesa internamente (no llega a onMessage) con t2 = reloj local', () => {
      const { latency, calls } = sink();
      let clock = 1000;
      const { client, messages } = make({ latency, now: () => clock });
      client.start();
      const ws = FakeWs.all[0]!;
      ws.open();
      clock = 1100;
      ws.serve({ type: 'time', t0: 1000, t1: 5050 });
      expect(messages).toHaveLength(0);
      expect(calls.sync).toEqual([[1000, 5050, 1100]]);
    });

    it('anota el ingestTs de la telemetría pero la entrega sin modificar', () => {
      const { latency, calls } = sink();
      const { client, messages } = make({ latency });
      client.start();
      const ws = FakeWs.all[0]!;
      ws.open();
      ws.serve({ type: 'telemetry', plant: 'demo', asset: 'tk-01', ts: 5, quality: 'good', values: { level: 50 }, ingestTs: 1234 });
      ws.serve({ type: 'telemetry', plant: 'demo', asset: 'tk-02', ts: 6, quality: 'good', values: { level: 40 } });
      expect(messages).toHaveLength(2);
      expect(calls.ingest).toEqual([['tk-01', 1234]]);
    });

    it('ignora respuestas de tiempo mal formadas', () => {
      const { latency, calls } = sink();
      const { client, messages } = make({ latency });
      client.start();
      const ws = FakeWs.all[0]!;
      ws.open();
      ws.serve({ type: 'time', t0: 'x' });
      ws.serve({ type: 'time', t0: 1 });
      expect(calls.sync).toHaveLength(0);
      expect(messages).toHaveLength(0);
    });
  });
});
