import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import {
  AlarmEvent,
  CatalogMessage,
  ID_PATTERN,
  ServerMessage,
  TelemetryEvent,
} from '@campo/shared';
import type { IncomingMessage } from 'node:http';
import { Subscription } from 'rxjs';
import { WebSocket } from 'ws';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import { TenantScope } from '../auth/tenant-scope';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { StateService } from '../plants/state.service';
import { BusMessage, RealtimeBus } from '../redis/realtime-bus';
import { CatalogCoalescer } from './catalog-coalescer';
import { TelemetryCoalescer } from './telemetry-coalescer';

interface Client {
  socket: WebSocket;
  userId: string;
  /** Versión de sesión del token con el que conectó: si cambia (revocación) se cierra con 4401. */
  tv: number;
  plant: string;
  alive: boolean;
  /** true cuando ya se envió el snapshot inicial. */
  ready: boolean;
}

/** Un socket con más de HARD_FACTOR x el límite de buffer se considera lento/muerto y se corta. */
const HARD_FACTOR = 8;

/** Códigos de cierre de aplicación (4000-4999). */
export const WS_CLOSE = { badRequest: 4400, unauthorized: 4401, forbidden: 4403 } as const;

@WebSocketGateway({ path: '/ws', maxPayload: 1024 })
export class LiveGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(LiveGateway.name);
  private readonly clients = new Map<WebSocket, Client>();
  private readonly byPlant = new Map<string, Set<Client>>();
  private readonly coalescer: TelemetryCoalescer;
  private readonly catalogCoalescer: CatalogCoalescer;
  private sub?: Subscription;
  private invalidationSub?: Subscription;
  private orgInvalidationSub?: Subscription;
  private revalidation?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  readonly stats = { telemetrySent: 0, telemetrySkipped: 0, alarmsSent: 0 };

  constructor(
    private readonly bus: RealtimeBus,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly tenant: TenantScope,
    private readonly state: StateService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.coalescer = new TelemetryCoalescer(cfg.wsCoalesceMs, (plant, events) =>
      this.broadcastTelemetry(plant, events),
    );
    this.catalogCoalescer = new CatalogCoalescer(cfg.wsCatalogCoalesceMs, (plant) =>
      this.broadcastCatalog(plant),
    );
  }

  onModuleInit(): void {
    // Un único suscriptor por proceso: el bus reparte en memoria a todos los clientes.
    this.sub = this.bus.messages$.subscribe((m) => this.onBus(m));
    this.heartbeat = setInterval(() => this.sweep(), this.cfg.wsPingIntervalMs);
    this.heartbeat.unref();
    // Revocación en vivo: un cambio hecho en este proceso cierra al instante; los hechos en otras réplicas
    // (o si se pierde el aviso) se detectan en la revalidación periódica (<= TTL de la caché).
    this.invalidationSub = this.access.invalidations$.subscribe((id) => void this.revalidate([id]));
    // Un cambio de cliente (desactivado, módulos...) afecta a todos sus usuarios: se revalidan todos los sockets.
    this.orgInvalidationSub = this.access.orgInvalidations$.subscribe(() => void this.revalidate());
    this.revalidation = setInterval(
      () => void this.revalidate(undefined, true),
      this.cfg.wsRevalidateMs,
    );
    this.revalidation.unref();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    this.invalidationSub?.unsubscribe();
    this.orgInvalidationSub?.unsubscribe();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.revalidation) clearInterval(this.revalidation);
    this.coalescer.dispose();
    this.catalogCoalescer.dispose();
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
      const claims = token ? await this.auth.verifyToken(token) : null;
      if (!claims) return this.deny(socket, WS_CLOSE.unauthorized, 'unauthorized', plant);
      // Rol, cliente (activo), estado y plantas vigentes de la base (no los del token).
      const user = await this.access.getAccess(claims.id, { tv: claims.tv });
      if (!user) return this.deny(socket, WS_CLOSE.unauthorized, 'unauthorized', plant, claims.id);
      if (!(await this.tenant.canAccessPlant(user, plant))) {
        return this.deny(socket, WS_CLOSE.forbidden, 'forbidden', plant, user.id);
      }
      if (socket.readyState !== WebSocket.OPEN) return;

      const client: Client = {
        socket,
        userId: user.id,
        tv: claims.tv,
        plant,
        alive: true,
        ready: false,
      };
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

  /**
   * Comprueba contra la base (usuario activo y acceso a la planta) los sockets abiertos de `userIds`
   * (o de todos) y cierra los que ya no corresponden: 4401 (inactivo/inexistente, cliente desactivado o token revocado: su
   * `tv` ya no es el vigente) o 4403 (sin acceso). `fresh` salta la caché para acotar la revocación al
   * intervalo de revalidación (sólo en la primera lectura de cada usuario). Visible para tests.
   */
  async revalidate(userIds?: string[], fresh = false): Promise<void> {
    const ids = new Set(userIds ?? [...this.clients.values()].map((c) => c.userId));
    const orgs = new Map<string, string | null>(); // cliente de cada planta, consultado una vez por pasada
    for (const userId of ids) {
      try {
        let refresh = fresh;
        for (const client of [...this.clients.values()]) {
          if (client.userId !== userId) continue;
          const user = await this.access.getAccess(userId, { fresh: refresh, tv: client.tv });
          refresh = false; // las lecturas siguientes del mismo usuario salen de la caché recién refrescada
          if (!user) this.revoke(client, WS_CLOSE.unauthorized, 'unauthorized');
          else if (!(await this.tenant.canAccessPlant(user, client.plant, orgs))) {
            this.revoke(client, WS_CLOSE.forbidden, 'forbidden');
          }
        }
      } catch (err) {
        // Fallo transitorio de la base: se mantienen los sockets y se reintenta en el siguiente ciclo.
        this.log.warn({ msg: 'revalidación ws fallida', userId, error: (err as Error).message });
      }
    }
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

  private deny(
    socket: WebSocket,
    code: number,
    reason: string,
    plant: string,
    userId?: string,
  ): void {
    this.log.warn({
      msg: 'acceso denegado',
      transport: 'ws',
      status: code,
      userId,
      path: '/ws',
      plant,
    });
    socket.close(code, reason);
  }

  /** Deja de enviarle datos al instante y cierra el socket. */
  private revoke(client: Client, code: number, reason: string): void {
    this.deny(client.socket, code, reason, client.plant, client.userId);
    client.ready = false;
    this.handleDisconnect(client.socket);
  }

  private onBus(m: BusMessage): void {
    if (!this.byPlant.has(m.plant)) return;
    if (m.kind === 'telemetry') this.coalescer.push(m.event);
    else if (m.kind === 'alarm') this.broadcastAlarm(m.plant, m.event);
    else this.catalogCoalescer.push(m.plant);
  }

  /** `{type:"catalog"}` sólo a los clientes de esa planta; el cliente vuelve a pedir el catálogo por HTTP. */
  private broadcastCatalog(plant: string): void {
    const msg: CatalogMessage = { type: 'catalog', plant };
    const payload = JSON.stringify(msg);
    for (const c of this.byPlant.get(plant) ?? []) {
      if (!c.ready || c.socket.readyState !== WebSocket.OPEN) continue;
      this.sendRaw(c, payload);
    }
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
