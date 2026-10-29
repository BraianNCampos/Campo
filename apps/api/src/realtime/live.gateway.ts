import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { AlarmEvent, ID_PATTERN, ServerMessage, TelemetryEvent } from '@campo/shared';
import type { IncomingMessage } from 'node:http';
import { Subscription } from 'rxjs';
import { WebSocket } from 'ws';
import { AuthService } from '../auth/auth.service';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { StateService } from '../plants/state.service';
import { BusMessage, RealtimeBus } from '../redis/realtime-bus';
import { TelemetryCoalescer } from './telemetry-coalescer';

interface Client {
  socket: WebSocket;
  plant: string;
  alive: boolean;
  /** true cuando ya se envió el snapshot inicial. */
  ready: boolean;
}

/** Un socket con más de HARD_FACTOR x el límite de buffer se considera lento/muerto y se corta. */
const HARD_FACTOR = 8;

/** Códigos de cierre de aplicación (4000-4999). */
export const WS_CLOSE = { badRequest: 4400, unauthorized: 4401 } as const;

@WebSocketGateway({ path: '/ws', maxPayload: 1024 })
export class LiveGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(LiveGateway.name);
  private readonly clients = new Map<WebSocket, Client>();
  private readonly byPlant = new Map<string, Set<Client>>();
  private readonly coalescer: TelemetryCoalescer;
  private sub?: Subscription;
  private heartbeat?: NodeJS.Timeout;
  readonly stats = { telemetrySent: 0, telemetrySkipped: 0, alarmsSent: 0 };

  constructor(
    private readonly bus: RealtimeBus,
    private readonly auth: AuthService,
    private readonly state: StateService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.coalescer = new TelemetryCoalescer(cfg.wsCoalesceMs, (plant, events) =>
      this.broadcastTelemetry(plant, events),
    );
  }

  onModuleInit(): void {
    // Un único suscriptor por proceso: el bus reparte en memoria a todos los clientes.
    this.sub = this.bus.messages$.subscribe((m) => this.onBus(m));
    this.heartbeat = setInterval(() => this.sweep(), this.cfg.wsPingIntervalMs);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.coalescer.dispose();
    for (const c of this.clients.values()) c.socket.terminate();
    this.clients.clear();
    this.byPlant.clear();
  }

  async handleConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'ws://localhost');
      const plant = url.searchParams.get('plant') ?? '';
      const header = req.headers.authorization;
      const bearer = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header)?.[1] : undefined;
      const token = url.searchParams.get('token') ?? bearer ?? '';

      if (!ID_PATTERN.test(plant)) return socket.close(WS_CLOSE.badRequest, 'invalid plant');
      const user = token ? await this.auth.verifyToken(token) : null;
      if (!user) return socket.close(WS_CLOSE.unauthorized, 'unauthorized');
      if (socket.readyState !== WebSocket.OPEN) return;

      const client: Client = { socket, plant, alive: true, ready: false };
      this.clients.set(socket, client);
      let set = this.byPlant.get(plant);
      if (!set) this.byPlant.set(plant, (set = new Set()));
      set.add(client);
      socket.on('pong', () => (client.alive = true));
      socket.on('error', () => socket.terminate());

      // Registrado antes de pedir el snapshot: lo que llegue mientras tanto se descarta
      // para este cliente (client.ready=false) y el snapshot ya lo corrige.
      const snapshot = await this.state.getSnapshot(plant);
      if (socket.readyState !== WebSocket.OPEN) return;
      this.send(client, snapshot);
      client.ready = true;
      this.log.log({ msg: 'ws conectado', plant, userId: user.id, clients: this.clients.size });
    } catch (err) {
      this.log.error({ msg: 'error en conexión ws', error: (err as Error).message });
      socket.close(1011, 'internal error');
    }
  }

  handleDisconnect(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;
    this.clients.delete(socket);
    const set = this.byPlant.get(client.plant);
    set?.delete(client);
    if (set?.size === 0) this.byPlant.delete(client.plant);
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Ping a todos; los que no respondieron al ping anterior se terminan. Visible para tests. */
  sweep(): void {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  private onBus(m: BusMessage): void {
    if (!this.byPlant.has(m.plant)) return;
    if (m.kind === 'telemetry') this.coalescer.push(m.event);
    else this.broadcastAlarm(m.plant, m.event);
  }

  private broadcastTelemetry(plant: string, events: TelemetryEvent[]): void {
    const clients = this.byPlant.get(plant);
    if (!clients) return;
    for (const ev of events) {
      const payload = JSON.stringify(ev);
      for (const c of clients) {
        if (!c.ready || c.socket.readyState !== WebSocket.OPEN) continue;
        // Backpressure: si el cliente no drena, se salta la telemetría (el siguiente valor la reemplaza).
        if (c.socket.bufferedAmount > this.cfg.wsMaxBufferedBytes) {
          this.stats.telemetrySkipped++;
          continue;
        }
        this.sendRaw(c, payload);
        this.stats.telemetrySent++;
      }
    }
  }

  private broadcastAlarm(plant: string, ev: AlarmEvent): void {
    const payload = JSON.stringify(ev);
    for (const c of this.byPlant.get(plant) ?? []) {
      if (!c.ready || c.socket.readyState !== WebSocket.OPEN) continue;
      // Las alarmas no se descartan salvo que el cliente esté claramente atascado.
      if (c.socket.bufferedAmount > this.cfg.wsMaxBufferedBytes * HARD_FACTOR) {
        c.socket.terminate();
        continue;
      }
      this.sendRaw(c, payload);
      this.stats.alarmsSent++;
    }
  }

  private send(client: Client, msg: ServerMessage): void {
    this.sendRaw(client, JSON.stringify(msg));
  }

  private sendRaw(client: Client, payload: string): void {
    client.socket.send(payload, (err) => {
      if (err) client.socket.terminate();
    });
  }
}
