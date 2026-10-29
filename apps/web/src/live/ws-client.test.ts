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
  close() {
    this.closed = true;
  }
  open() { this.onopen?.({}); }
  send(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
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
    ws.send(snapshot);
    ws.onmessage?.({ data: 'no-json' });
    ws.send({ type: 'desconocido' });
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
    FakeWs.all[2]!.send(snapshot); // conexión sana → attempt=0
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
});
