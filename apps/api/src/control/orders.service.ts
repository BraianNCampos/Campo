import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { redisKeys } from '@campo/shared';
import type {
  AssetState,
  InterlockItem,
  Order,
  OrderCommand,
  OrderEvent,
  OrderPreview,
  OrderStatus,
} from '@campo/shared';
import type Redis from 'ioredis';
import { Subscription } from 'rxjs';
import { AlarmRulesRepository } from '../alarms/alarm-rules.repository';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PlantAccessDenied, isPlatform, orgIdOf } from '../auth/plant-access';
import { TenantScope } from '../auth/tenant-scope';
import { OrgsRepository } from '../orgs/orgs.repository';
import { Asset, AssetsRepository } from '../plants/assets.repository';
import { resolveLimits } from '../plants/limits';
import { REDIS } from '../redis/tokens';
import { CommandBus, CommandBusError } from './command-bus';
import { ConfirmStore, ControlClock, RateLimiter } from './control-support';
import {
  CMD_ACK_TOPIC,
  CONTROL_LIMITS,
  OPEN_STATUSES,
  cmdTopic,
  isOpen,
  ordersChannel,
} from './control.types';
import type { InterlocksQuery, ListOrdersQuery, OrderPreviewDto } from './dto';
import {
  InterlockInput,
  blockCode,
  commandError,
  controlConfigOf,
  evaluateInterlocks,
  firstBlock,
  highLevelLimit,
} from './interlocks';
import { OrderRecord, OrdersRepository, toOrder } from './orders.repository';

/** Estados desde los que se acepta cada estado informado por el equipo (§14.3 punto 5). */
const ACK_FROM: Record<string, readonly OrderStatus[]> = {
  accepted: ['pending'],
  running: ['pending', 'accepted'],
  done: ['pending', 'accepted', 'running'],
  failed: ['pending', 'accepted', 'running'],
  rejected: ['pending', 'accepted'],
};
const ACK_MAX_BYTES = 2048;

const VERB: Record<OrderCommand, string> = {
  fill: 'Llenar',
  drain: 'Vaciar',
  stop: 'Detener',
  start: 'Arrancar',
  open: 'Abrir',
  close: 'Cerrar',
  set_position: 'Llevar',
};

const err = (status: number, error: string, message: string, extra: object = {}): HttpException =>
  new HttpException({ statusCode: status, error, message, ...extra }, status);

/**
 * Órdenes de control de llenado (docs/architecture.md §14.3). El acceso a la planta, el rol (operator+) y la
 * pertenencia al cliente los resuelven el controlador (guards); aquí viven los enclavamientos, el flujo de
 * confirmación en dos pasos, el límite de frecuencia, el envío por MQTT y el ciclo de vida de la orden.
 */
@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OrdersService.name);
  private sub?: Subscription;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly repo: OrdersRepository,
    private readonly assets: AssetsRepository,
    private readonly orgs: OrgsRepository,
    private readonly rules: AlarmRulesRepository,
    private readonly audit: AuditService,
    private readonly bus: CommandBus,
    private readonly confirms: ConfirmStore,
    private readonly limiter: RateLimiter,
    private readonly clock: ControlClock,
    private readonly tenant: TenantScope,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.sub = this.bus.acks$.subscribe((m) => {
      this.handleAck(m.topic, m.payload).catch((e: Error) =>
        this.log.error({ msg: 'error al procesar un ack', error: e.message }),
      );
    });
    this.sweeper = setInterval(() => {
      this.sweep().catch((e: Error) =>
        this.log.error({ msg: 'error al barrer plazos de órdenes', error: e.message }),
      );
    }, CONTROL_LIMITS.sweepIntervalMs);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.sweeper) clearInterval(this.sweeper);
  }

  // ---- Lectura -----------------------------------------------------------------------------------------------

  async list(plant: string, orgId: string | null, q: ListOrdersQuery): Promise<Order[]> {
    if (!orgId) return []; // planta sin cliente: no puede tener órdenes
    const rows = await this.repo.list({
      plant,
      orgId,
      asset: q.asset,
      status: q.status,
      limit: q.limit ?? 50,
      before: q.before,
    });
    return rows.map(toOrder);
  }

  /** Permisos de enclavamiento del activo (nivel 4). Sin `command`, sólo los que no dependen de la orden. */
  async interlocks(
    plant: string,
    orgId: string | null,
    assetId: string,
    q: InterlocksQuery,
  ): Promise<InterlockItem[]> {
    const asset = await this.requireAsset(plant, assetId);
    if (q.command) this.checkCommand(asset, q.command, q.target);
    const items = await this.evaluate(
      plant,
      orgId,
      asset,
      q.command,
      q.command ? q.target : undefined,
    );
    return [
      {
        id: 'broker',
        label: 'Canal de órdenes disponible',
        ok: this.bus.configured(),
        ...(this.bus.configured() ? {} : { reason: 'El control de equipos no está configurado' }),
      },
      ...items,
    ];
  }

  // ---- Órdenes -----------------------------------------------------------------------------------------------

  async preview(
    user: AuthUser,
    plant: string,
    orgId: string | null,
    assetId: string,
    dto: OrderPreviewDto,
  ): Promise<OrderPreview> {
    await this.assertModule(orgId);
    this.assertAvailable();
    const asset = await this.requireAsset(plant, assetId);
    this.checkCommand(asset, dto.command, dto.target);
    const items = await this.evaluate(plant, orgId, asset, dto.command, dto.target);
    const block = firstBlock(items, dto.command);
    const now = this.clock.now();
    const warnings = this.warnings(asset, dto.command, items);
    const summary = this.summary(asset, dto.command, dto.target);
    if (block) {
      return {
        confirmId: '',
        expiresAt: now,
        summary,
        warnings,
        blocked: block.reason ?? block.label,
      };
    }
    const { id, expiresAt } = await this.confirms.issue({
      userId: user.id,
      plant,
      asset: assetId,
      command: dto.command,
      target: dto.target,
    });
    return { confirmId: id, expiresAt, summary, warnings, blocked: null };
  }

  async execute(
    user: AuthUser,
    plant: string,
    orgId: string | null,
    assetId: string,
    confirmId: string,
  ): Promise<Order> {
    await this.assertModule(orgId);
    this.assertAvailable();
    const asset = await this.requireAsset(plant, assetId);
    const confirm = await this.confirms.consume(confirmId, {
      userId: user.id,
      plant,
      asset: assetId,
    });
    if (!confirm) {
      throw err(
        409,
        'invalid_confirm',
        'La confirmación no es válida (ya se usó, venció o es de otra orden): pedí una vista previa nueva',
      );
    }
    // El tipo del activo pudo cambiar entre la vista previa y la confirmación.
    this.checkCommand(asset, confirm.command, confirm.target);
    await this.rateLimit(user, confirm.command);
    const items = await this.evaluate(plant, orgId, asset, confirm.command, confirm.target);
    const block = firstBlock(items, confirm.command);
    if (block) {
      throw err(409, blockCode(block.id), block.reason ?? block.label, { interlock: block.id });
    }
    return this.dispatch(user, orgId as string, asset, confirm.command, confirm.target, {
      supersede: confirm.command === 'stop' ? 'Reemplazada por una orden de detención' : null,
    });
  }

  /** Cancela una orden en curso enviando un `stop` al equipo (la orden original queda `cancelled`). */
  async cancel(user: AuthUser, id: string): Promise<Order> {
    const order = await this.repo.findById(id);
    if (!order) {
      if (isPlatform(user)) throw new NotFoundException('Orden no encontrada');
      throw new PlantAccessDenied('');
    }
    const allowed =
      (isPlatform(user) || orgIdOf(user) === order.orgId) &&
      (await this.tenant.canAccessPlant(user, order.plant));
    if (!allowed) throw new PlantAccessDenied(order.plant);
    this.assertAvailable();
    if (!isOpen(order.status)) {
      throw err(409, 'order_not_cancellable', `La orden ya terminó (${order.status})`);
    }
    await this.rateLimit(user, 'stop');
    const asset = await this.assets.get(order.plant, order.asset);
    const target =
      asset ??
      ({
        plant: order.plant,
        id: order.asset,
        name: order.asset,
        type: 'tank',
        model3dRef: null,
        metadata: {},
        tag: order.tag,
      } satisfies Asset);
    await this.dispatch(user, order.orgId, target, 'stop', undefined, {
      supersede: `Cancelada por ${user.email}`,
      cancelOf: order.id,
    });
    return toOrder((await this.repo.findById(id)) ?? order);
  }

  // ---- Respuestas de los equipos y plazos ------------------------------------------------------------------------

  /** Procesa un mensaje de `campo/v1/{planta}/{activo}/cmd/ack`. Mensajes inválidos o ajenos se descartan. */
  async handleAck(topic: string, raw: string): Promise<void> {
    const m = CMD_ACK_TOPIC.exec(topic);
    if (!m || raw.length > ACK_MAX_BYTES) return;
    let data: { id?: unknown; status?: unknown; reason?: unknown };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return;
    }
    if (typeof data?.id !== 'string' || typeof data.status !== 'string') return;
    const from = ACK_FROM[data.status];
    if (!from) return;
    const order = await this.repo.findById(data.id);
    // El ack debe venir del tópico de la planta y el activo de la orden (un equipo no responde por otro).
    if (!order || order.plant !== m[1] || order.asset !== m[2]) {
      this.log.warn({ msg: 'ack descartado: orden desconocida o de otro activo', topic });
      return;
    }
    const reason =
      typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : undefined;
    await this.applyStatus(order, from, data.status as OrderStatus, reason, null);
  }

  /** Aplica los plazos: sin `accepted` en 10 s, o `accepted|running` sin `done` pasada la duración máxima. */
  async sweep(): Promise<void> {
    const now = this.clock.now();
    for (const o of await this.repo.findOpen()) {
      if (o.status === 'pending') {
        if (now - o.requestedAt > CONTROL_LIMITS.acceptTimeoutMs) {
          await this.applyStatus(
            o,
            ['pending'],
            'timeout',
            `El equipo no respondió (sin aceptar en ${CONTROL_LIMITS.acceptTimeoutMs / 1000} s)`,
            null,
          );
        }
        continue;
      }
      const since = o.runningAt ?? o.acceptedAt ?? o.requestedAt;
      if (now - since > o.maxDurationMinutes * 60_000) {
        await this.applyStatus(
          o,
          [o.status],
          'timeout',
          `Superó la duración máxima (${o.maxDurationMinutes} min) sin terminar`,
          null,
        );
      }
    }
  }

  // ---- Internos --------------------------------------------------------------------------------------------------

  /** Crea la orden, la registra/audita/difunde y la publica por MQTT. */
  private async dispatch(
    user: AuthUser,
    orgId: string,
    asset: Asset,
    command: OrderCommand,
    target: number | undefined,
    opts: { supersede: string | null; cancelOf?: string },
  ): Promise<Order> {
    const now = this.clock.now();
    const cfg = controlConfigOf(asset);
    const created = await this.repo.create(
      {
        id: randomUUID(),
        orgId,
        plant: asset.plant,
        asset: asset.id,
        tag: asset.tag ?? null,
        command,
        ...(target !== undefined ? { target } : {}),
        requestedBy: { id: user.id, email: user.email },
        maxDurationMinutes: cfg.maxDurationMinutes,
        now,
      },
      opts.supersede ? { reason: opts.supersede } : null,
    );
    if (!created) {
      throw err(409, 'order_in_progress', 'Hay una orden en curso para este equipo', {
        interlock: 'idle',
      });
    }
    const { order, superseded } = created;
    for (const s of superseded) await this.announce(s, user);
    await this.audit.record(user, 'order.create', `order:${order.id}`, orgId, {
      plant: order.plant,
      asset: order.asset,
      command,
      target,
      cancelOf: opts.cancelOf,
    });
    await this.emit(order);

    try {
      await this.bus.publish(
        cmdTopic(order.plant, order.asset),
        JSON.stringify({
          id: order.id,
          command,
          ...(target !== undefined ? { target } : {}),
          ts: now,
          by: user.email,
        }),
      );
    } catch (e) {
      this.log.error({
        msg: 'no se pudo publicar la orden',
        orderId: order.id,
        error: (e as Error).message,
      });
      await this.applyStatus(
        order,
        ['pending'],
        'failed',
        e instanceof CommandBusError
          ? 'No se pudo entregar la orden al broker MQTT'
          : 'Error al enviar la orden',
        user,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'control_unavailable',
        message: 'No se pudo enviar la orden: el canal de control no está disponible',
        orderId: order.id,
      });
    }
    return toOrder(order);
  }

  /** Una orden desplazada por un `stop` (ya `cancelled` en la base): se audita su cierre y se difunde. */
  private async announce(rec: OrderRecord, actor: AuthUser): Promise<void> {
    await this.audit.record(actor, 'order.status', `order:${rec.id}`, rec.orgId, {
      plant: rec.plant,
      asset: rec.asset,
      command: rec.command,
      status: rec.status,
      reason: rec.reason,
    });
    await this.emit(rec);
  }

  private async applyStatus(
    order: OrderRecord,
    from: readonly OrderStatus[],
    to: OrderStatus,
    reason: string | undefined,
    actor: AuthUser | null,
  ): Promise<void> {
    const updated = await this.repo.transition(order.id, from, to, {
      now: this.clock.now(),
      reason,
    });
    if (!updated) return; // otra transición se adelantó: la orden ya está en otro estado
    await this.audit.record(actor, 'order.status', `order:${updated.id}`, updated.orgId, {
      plant: updated.plant,
      asset: updated.asset,
      command: updated.command,
      status: to,
      previous: order.status,
      reason,
    });
    await this.emit(updated);
  }

  /** Difunde `{type:"order"}` por Redis; el gateway WS lo reparte sólo a los clientes de esa planta. */
  private async emit(rec: OrderRecord): Promise<void> {
    const ev: OrderEvent = { type: 'order', order: toOrder(rec) };
    try {
      await this.redis.publish(ordersChannel(rec.plant), JSON.stringify(ev));
    } catch (e) {
      this.log.warn({
        msg: 'no se pudo difundir la orden',
        orderId: rec.id,
        error: (e as Error).message,
      });
    }
  }

  private async rateLimit(user: AuthUser, command: OrderCommand): Promise<void> {
    const isStop = command === 'stop';
    const ok = await this.limiter.hit(
      isStop ? 'stop' : 'order',
      user.id,
      isStop ? CONTROL_LIMITS.stopPerMinute : CONTROL_LIMITS.ordersPerMinute,
    );
    if (!ok) {
      throw err(
        429,
        'rate_limited',
        `Demasiadas órdenes: el máximo es ${isStop ? CONTROL_LIMITS.stopPerMinute : CONTROL_LIMITS.ordersPerMinute} por minuto`,
      );
    }
  }

  /** El cliente propietario de la planta debe tener contratado `control` (403 `module_disabled`). */
  private async assertModule(orgId: string | null): Promise<void> {
    const org = orgId ? await this.orgs.findById(orgId) : null;
    if (!org)
      throw new NotFoundException('Planta no registrada: créela primero (POST /api/plants)');
    if (!org.modules.includes('control')) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'module_disabled',
        module: 'control',
        message: 'El módulo "control" no está contratado por el cliente',
      });
    }
  }

  private assertAvailable(): void {
    if (!this.bus.configured()) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'control_unavailable',
        message: 'El control de equipos no está disponible (la API no tiene MQTT_URL)',
      });
    }
  }

  private async requireAsset(plant: string, id: string): Promise<Asset> {
    const asset = await this.assets.get(plant, id);
    if (!asset) throw new NotFoundException('Activo no encontrado');
    return asset;
  }

  private checkCommand(asset: Asset, command: OrderCommand, target?: number): void {
    const e = commandError(asset.type, command, target);
    if (e) throw new BadRequestException(e);
  }

  /** Reúne el contexto (módulo, telemetría, órdenes en curso, límites, alarmas) y evalúa los enclavamientos. */
  private async evaluate(
    plant: string,
    orgId: string | null,
    asset: Asset,
    command?: OrderCommand,
    target?: number,
  ): Promise<InterlockItem[]> {
    const moduleActive = Boolean(
      orgId && (await this.orgs.findById(orgId))?.modules.includes('control'),
    );
    const [state, open, rules, hh] = await Promise.all([
      this.stateOf(plant, asset.id),
      this.repo.findOpenByAsset(plant, asset.id),
      this.rules.list(plant),
      this.hhActive(plant, asset.id),
    ]);
    const input: InterlockInput = {
      moduleActive,
      asset,
      state,
      now: this.clock.now(),
      open: open.filter((o) => OPEN_STATUSES.includes(o.status)),
      highLimit: highLevelLimit(resolveLimits(rules, [asset.id]), asset.id),
      hhActive: hh,
      command,
      target,
    };
    return evaluateInterlocks(input);
  }

  private async stateOf(plant: string, asset: string): Promise<AssetState | null> {
    const raw = await this.redis.hget(redisKeys.state(plant), asset);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as AssetState;
      return s && typeof s.ts === 'number' && s.values ? s : null;
    } catch {
      return null;
    }
  }

  private async hhActive(plant: string, asset: string): Promise<boolean> {
    const all = await this.redis.hgetall(redisKeys.activeAlarms(plant));
    for (const json of Object.values(all)) {
      try {
        const a = JSON.parse(json) as {
          asset?: string;
          metric?: string;
          kind?: string;
          state?: string;
        };
        if (a.asset === asset && a.metric === 'level' && a.kind === 'HH' && a.state === 'active')
          return true;
      } catch {
        /* entrada inválida: se ignora */
      }
    }
    return false;
  }

  private label(asset: Asset): string {
    return asset.tag ? `${asset.tag} (${asset.name})` : asset.name;
  }

  private summary(asset: Asset, command: OrderCommand, target?: number): string {
    const l = this.label(asset);
    switch (command) {
      case 'fill':
      case 'drain':
        return `${VERB[command]} ${l} hasta ${target} %`;
      case 'set_position':
        return `Llevar ${l} a ${target} % de apertura`;
      default:
        return `${VERB[command]} ${l}`;
    }
  }

  private warnings(asset: Asset, command: OrderCommand, items: InterlockItem[]): string[] {
    const out: string[] = [];
    const cfg = controlConfigOf(asset);
    if (command === 'fill' || command === 'drain') {
      out.push(`Si no termina en ${cfg.maxDurationMinutes} min se marcará como vencida.`);
    }
    if (command === 'stop') {
      const offline = items.find((i) => i.id === 'online' && !i.ok);
      if (offline)
        out.push('El equipo no informa datos recientes: la orden de detención podría no llegar.');
      const busy = items.find((i) => i.id === 'idle' && !i.ok);
      if (busy) out.push('Se cancelará la orden en curso de este equipo.');
    }
    return out;
  }
}
