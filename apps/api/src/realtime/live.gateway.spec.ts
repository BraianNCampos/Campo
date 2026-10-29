import type { AlarmEvent, AssetState, SnapshotMessage, TelemetryEvent } from '@campo/shared';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Subject } from 'rxjs';
import type { WebSocket } from 'ws';
import type { AuthService } from '../auth/auth.service';
import { parseEnv } from '../config/app-config';
import type { StateService } from '../plants/state.service';
import type { BusMessage, RealtimeBus } from '../redis/realtime-bus';
import { LiveGateway, WS_CLOSE } from './live.gateway';

class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closedWith?: [number, string];
  pings = 0;
  terminated = false;

  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    cb?.();
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
    this.readyState = 3;
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  types() {
    return this.sent.map((m) => m.type as string);
  }
}

const cfg = parseEnv({
  JWT_SECRET: 'x'.repeat(32),
  NODE_ENV: 'test',
  WS_COALESCE_MS: '100',
  WS_MAX_BUFFERED_BYTES: '1024',
});

const req = (url: string): IncomingMessage => ({ url, headers: {} }) as unknown as IncomingMessage;

const tel = (asset: string, values: Record<string, number>, plant = 'demo'): TelemetryEvent => ({
  type: 'telemetry',
  plant,
  asset,
  ts: Date.now(),
  quality: 'good',
  values,
});

const alarm = (plant = 'demo'): AlarmEvent => ({
  type: 'alarm',
  id: 'a1',
  ruleId: 'r1',
  plant,
  asset: 'tk-01',
  metric: 'level',
  severity: 'critical',
  state: 'active',
  value: 95,
  threshold: 90,
  ts: 1,
  message: 'm',
});

describe('LiveGateway', () => {
  let bus: Subject<BusMessage>;
  let gw: LiveGateway;
  const state: AssetState = { ts: 1, values: { level: 40 }, quality: 'good' };

  const connect = async (url = '/ws?plant=demo&token=good') => {
    const s = new FakeSocket();
    await gw.handleConnection(s as unknown as WebSocket, req(url));
    return s;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    bus = new Subject<BusMessage>();
    const auth = {
      verifyToken: jest.fn((t: string) =>
        Promise.resolve(t === 'good' ? { id: 'u1', email: 'e', role: 'viewer' as const } : null),
      ),
    } as unknown as AuthService;
    const stateSvc = {
      getSnapshot: jest.fn((plant: string): Promise<SnapshotMessage> =>
        Promise.resolve({ type: 'snapshot', plant, assets: { 'tk-01': state } }),
      ),
    } as unknown as StateService;
    gw = new LiveGateway(
      { messages$: bus.asObservable() } as unknown as RealtimeBus,
      auth,
      stateSvc,
      cfg,
    );
    gw.onModuleInit();
  });

  afterEach(() => {
    gw.onModuleDestroy();
    jest.useRealTimers();
  });

  const telemetry = (e: TelemetryEvent): BusMessage => ({
    kind: 'telemetry',
    plant: e.plant,
    event: e,
  });

  describe('conexión', () => {
    it('rechaza sin token o con token inválido', async () => {
      const a = await connect('/ws?plant=demo');
      const b = await connect('/ws?plant=demo&token=bad');
      expect(a.closedWith?.[0]).toBe(WS_CLOSE.unauthorized);
      expect(b.closedWith?.[0]).toBe(WS_CLOSE.unauthorized);
      expect(gw.clientCount()).toBe(0);
    });

    it('rechaza una planta inválida', async () => {
      const s = await connect('/ws?plant=../etc&token=good');
      expect(s.closedWith?.[0]).toBe(WS_CLOSE.badRequest);
    });

    it('envía el snapshot inicial al conectar', async () => {
      const s = await connect();
      expect(s.sent).toEqual([{ type: 'snapshot', plant: 'demo', assets: { 'tk-01': state } }]);
      expect(gw.clientCount()).toBe(1);
    });

    it('acepta el token por cabecera Authorization', async () => {
      const s = new FakeSocket();
      await gw.handleConnection(
        s as unknown as WebSocket,
        {
          url: '/ws?plant=demo',
          headers: { authorization: 'Bearer good' },
        } as unknown as IncomingMessage,
      );
      expect(s.types()).toEqual(['snapshot']);
    });

    it('limpia al cliente al desconectar', async () => {
      const s = await connect();
      gw.handleDisconnect(s as unknown as WebSocket);
      expect(gw.clientCount()).toBe(0);
      bus.next(telemetry(tel('tk-01', { level: 1 })));
      jest.advanceTimersByTime(200);
      expect(s.sent).toHaveLength(1); // sólo el snapshot
    });
  });

  describe('telemetría (coalescing)', () => {
    it('agrupa en ventanas de 100 ms y envía sólo el último valor por activo', async () => {
      const s = await connect();
      for (let i = 1; i <= 5; i++) bus.next(telemetry(tel('tk-01', { level: i })));
      bus.next(telemetry(tel('tk-02', { level: 70 })));
      jest.advanceTimersByTime(99);
      expect(s.types()).toEqual(['snapshot']);
      jest.advanceTimersByTime(1);

      const telem = s.sent.filter((m) => m.type === 'telemetry');
      expect(telem).toHaveLength(2);
      expect(telem.find((m) => m.asset === 'tk-01')).toMatchObject({ values: { level: 5 } });
      expect(telem.find((m) => m.asset === 'tk-02')).toMatchObject({ values: { level: 70 } });
    });

    it('sólo reenvía a los clientes de la planta del evento', async () => {
      const demo = await connect('/ws?plant=demo&token=good');
      const other = await connect('/ws?plant=otra&token=good');
      bus.next(telemetry(tel('tk-01', { level: 1 })));
      bus.next(telemetry(tel('tk-01', { level: 2 }, 'otra')));
      jest.advanceTimersByTime(100);
      expect(demo.sent.filter((m) => m.type === 'telemetry')).toHaveLength(1);
      expect(other.sent.filter((m) => m.type === 'telemetry')).toHaveLength(1);
      expect(demo.sent.at(-1)).toMatchObject({ plant: 'demo', values: { level: 1 } });
      expect(other.sent.at(-1)).toMatchObject({ plant: 'otra', values: { level: 2 } });
    });

    it('ignora telemetría de plantas sin clientes (no acumula)', () => {
      bus.next(telemetry(tel('tk-01', { level: 1 }, 'nadie')));
      jest.advanceTimersByTime(200);
      expect(gw.stats.telemetrySent).toBe(0);
    });
  });

  describe('backpressure', () => {
    it('salta la telemetría de un cliente lento pero sigue sirviendo a los demás', async () => {
      const slow = await connect();
      const fast = await connect();
      slow.bufferedAmount = 5000; // > WS_MAX_BUFFERED_BYTES (1024)
      bus.next(telemetry(tel('tk-01', { level: 1 })));
      jest.advanceTimersByTime(100);
      expect(slow.sent.filter((m) => m.type === 'telemetry')).toHaveLength(0);
      expect(fast.sent.filter((m) => m.type === 'telemetry')).toHaveLength(1);
      expect(gw.stats.telemetrySkipped).toBe(1);

      // al drenar vuelve a recibir
      slow.bufferedAmount = 0;
      bus.next(telemetry(tel('tk-01', { level: 2 })));
      jest.advanceTimersByTime(100);
      expect(slow.sent.at(-1)).toMatchObject({ type: 'telemetry', values: { level: 2 } });
    });

    it('no descarta alarmas por backpressure moderado, pero corta a un cliente atascado', async () => {
      const slow = await connect();
      const stuck = await connect();
      slow.bufferedAmount = 5000;
      stuck.bufferedAmount = 1024 * 8 + 1;
      bus.next({ kind: 'alarm', plant: 'demo', event: alarm() });
      expect(slow.sent.at(-1)).toMatchObject({ type: 'alarm', id: 'a1' });
      expect(stuck.terminated).toBe(true);
    });
  });

  describe('alarmas', () => {
    it('se reenvían de inmediato (sin esperar a la ventana)', async () => {
      const s = await connect();
      bus.next({ kind: 'alarm', plant: 'demo', event: alarm() });
      expect(s.sent.at(-1)).toMatchObject({ type: 'alarm', state: 'active' });
    });
  });

  describe('ping/pong', () => {
    it('hace ping a los clientes y termina a los que no responden', async () => {
      const alive = await connect();
      const dead = await connect();

      jest.advanceTimersByTime(cfg.wsPingIntervalMs);
      expect(alive.pings).toBe(1);
      expect(dead.pings).toBe(1);
      alive.emit('pong');

      jest.advanceTimersByTime(cfg.wsPingIntervalMs);
      expect(dead.terminated).toBe(true);
      expect(alive.terminated).toBe(false);
      expect(alive.pings).toBe(2);
    });

    it('usa 25 s por defecto', () => {
      expect(parseEnv({ JWT_SECRET: 'x'.repeat(32) }).wsPingIntervalMs).toBe(25_000);
    });
  });
});
