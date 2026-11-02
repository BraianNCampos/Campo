import { randomUUID } from 'node:crypto';
import type { OrderStatus } from '@campo/shared';
import { Subject } from 'rxjs';
import { AckMessage, CommandBus, CommandBusError } from '../../src/control/command-bus';
import { ControlClock } from '../../src/control/control-support';
import { OPEN_STATUSES } from '../../src/control/control.types';
import {
  ListOrdersFilter,
  NewOrder,
  OrderRecord,
  OrdersRepository,
  TransitionPatch,
} from '../../src/control/orders.repository';

const TERMINAL: OrderStatus[] = ['done', 'failed', 'rejected', 'timeout', 'cancelled'];

/** Tabla `orders` en memoria: misma semántica que `PgOrdersRepository` (una sola orden en curso por activo). */
export class MemoryOrdersRepository extends OrdersRepository {
  readonly orders = new Map<string, OrderRecord>();

  create(
    o: NewOrder,
    supersede: { reason: string } | null,
  ): Promise<{ order: OrderRecord; superseded: OrderRecord[] } | null> {
    const open = this.openOf(o.plant, o.asset);
    if (open.length > 0 && !supersede) return Promise.resolve(null);
    const superseded: OrderRecord[] = [];
    for (const s of open) {
      Object.assign(s, {
        status: 'cancelled' as const,
        reason: supersede?.reason,
        completedAt: o.now,
        updatedAt: o.now,
      });
      superseded.push({ ...s });
    }
    const order: OrderRecord = {
      id: o.id,
      orgId: o.orgId,
      plant: o.plant,
      asset: o.asset,
      tag: o.tag,
      command: o.command,
      ...(o.target !== undefined ? { target: o.target } : {}),
      status: 'pending',
      requestedBy: o.requestedBy,
      requestedAt: o.now,
      updatedAt: o.now,
      maxDurationMinutes: o.maxDurationMinutes,
    };
    this.orders.set(order.id, order);
    return Promise.resolve({ order: { ...order }, superseded });
  }

  private openOf(plant: string, asset: string): OrderRecord[] {
    return [...this.orders.values()].filter(
      (x) => x.plant === plant && x.asset === asset && OPEN_STATUSES.includes(x.status),
    );
  }

  findById(id: string): Promise<OrderRecord | null> {
    const o = this.orders.get(id);
    return Promise.resolve(o ? { ...o } : null);
  }

  list(f: ListOrdersFilter): Promise<OrderRecord[]> {
    return Promise.resolve(
      [...this.orders.values()]
        .filter(
          (o) =>
            o.plant === f.plant &&
            o.orgId === f.orgId &&
            (!f.asset || o.asset === f.asset) &&
            (!f.status || o.status === f.status) &&
            (f.before === undefined || o.requestedAt < f.before),
        )
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .slice(0, f.limit)
        .map((o) => ({ ...o })),
    );
  }

  findOpen(): Promise<OrderRecord[]> {
    return Promise.resolve(
      [...this.orders.values()]
        .filter((o) => OPEN_STATUSES.includes(o.status))
        .map((o) => ({ ...o })),
    );
  }

  findOpenByAsset(plant: string, asset: string): Promise<OrderRecord[]> {
    return Promise.resolve(this.openOf(plant, asset).map((o) => ({ ...o })));
  }

  transition(
    id: string,
    from: readonly OrderStatus[],
    to: OrderStatus,
    p: TransitionPatch,
  ): Promise<OrderRecord | null> {
    const o = this.orders.get(id);
    if (!o || !from.includes(o.status)) return Promise.resolve(null);
    o.status = to;
    o.updatedAt = p.now;
    if (p.reason) o.reason = p.reason.slice(0, 300);
    if (to === 'accepted') o.acceptedAt = p.now;
    if (to === 'running') o.runningAt = p.now;
    if (TERMINAL.includes(to)) o.completedAt = p.now;
    return Promise.resolve({ ...o });
  }
}

/** Broker MQTT simulado: guarda lo publicado y permite inyectar acks. */
export class FakeCommandBus extends CommandBus {
  private readonly subject = new Subject<AckMessage>();
  readonly acks$ = this.subject.asObservable();
  readonly published: { topic: string; payload: Record<string, unknown> }[] = [];
  isConfigured = true;
  /** Si es true, `publish` falla como un broker caído. */
  down = false;

  configured(): boolean {
    return this.isConfigured;
  }

  publish(topic: string, payload: string): Promise<void> {
    if (this.down) return Promise.reject(new CommandBusError('broker caído'));
    this.published.push({ topic, payload: JSON.parse(payload) as Record<string, unknown> });
    return Promise.resolve();
  }

  /** Simula la respuesta del equipo en `campo/v1/{planta}/{activo}/cmd/ack`. */
  ack(plant: string, asset: string, body: Record<string, unknown>): void {
    this.subject.next({
      topic: `campo/v1/${plant}/${asset}/cmd/ack`,
      payload: JSON.stringify({ ts: Date.now(), ...body }),
    });
  }

  last(): { topic: string; payload: Record<string, unknown> } {
    return this.published[this.published.length - 1];
  }
}

/** Reloj controlable. */
export class FakeClock extends ControlClock {
  constructor(public t = 1_700_000_000_000) {
    super();
  }
  override now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const newId = (): string => randomUUID();
