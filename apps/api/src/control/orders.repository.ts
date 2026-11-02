import { Inject, Injectable } from '@nestjs/common';
import type { Order, OrderCommand, OrderStatus } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import { OPEN_STATUSES } from './control.types';

/** Orden tal como se guarda: el `Order` del contrato más lo que sólo usa el servidor. */
export interface OrderRecord extends Order {
  orgId: string;
  /** Copia de `metadata.control.maxDurationMinutes` al crearla (plazo de una orden `running`). */
  maxDurationMinutes: number;
  acceptedAt?: number;
  runningAt?: number;
}

/** Lo que ve el cliente (REST y WebSocket): sin datos internos. */
export const toOrder = (r: OrderRecord): Order => ({
  id: r.id,
  plant: r.plant,
  asset: r.asset,
  tag: r.tag ?? null,
  command: r.command,
  ...(r.target !== undefined ? { target: r.target } : {}),
  status: r.status,
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  updatedAt: r.updatedAt,
  ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
  ...(r.reason ? { reason: r.reason } : {}),
});

export interface NewOrder {
  id: string;
  orgId: string;
  plant: string;
  asset: string;
  tag: string | null;
  command: OrderCommand;
  target?: number;
  requestedBy: { id: string; email: string };
  maxDurationMinutes: number;
  now: number;
}

export interface ListOrdersFilter {
  plant: string;
  /** Cliente propietario de la planta HOY: una planta borrada y recreada por otro cliente no hereda órdenes ajenas. */
  orgId: string;
  asset?: string;
  status?: OrderStatus;
  limit: number;
  /** Sólo órdenes pedidas antes de este instante (epoch ms): paginación hacia atrás. */
  before?: number;
}

export interface TransitionPatch {
  now: number;
  reason?: string;
}

export abstract class OrdersRepository {
  /**
   * Inserta la orden. Si el activo ya tiene una en curso: con `supersede` (un `stop`) esas pasan a `cancelled`
   * con `supersedeReason` y se devuelven en `superseded`; sin él devuelve null (`order_in_progress`).
   * Es atómico: la base garantiza una sola orden en curso por activo.
   */
  abstract create(
    order: NewOrder,
    supersede: { reason: string } | null,
  ): Promise<{ order: OrderRecord; superseded: OrderRecord[] } | null>;
  abstract findById(id: string): Promise<OrderRecord | null>;
  abstract list(f: ListOrdersFilter): Promise<OrderRecord[]>;
  /** Órdenes en curso (pending|accepted|running) de todas las plantas. */
  abstract findOpen(): Promise<OrderRecord[]>;
  abstract findOpenByAsset(plant: string, asset: string): Promise<OrderRecord[]>;
  /**
   * Cambia el estado sólo si la orden está ahora en uno de `from` (evita pisar una transición concurrente).
   * Devuelve la orden actualizada o null si no existe o ya no estaba en `from`.
   */
  abstract transition(
    id: string,
    from: readonly OrderStatus[],
    to: OrderStatus,
    patch: TransitionPatch,
  ): Promise<OrderRecord | null>;
}

interface OrderRow {
  id: string;
  org_id: string;
  plant: string;
  asset: string;
  tag: string | null;
  command: OrderCommand;
  target: number | null;
  status: OrderStatus;
  reason: string | null;
  requested_by: string | null;
  requested_email: string;
  max_duration_minutes: number;
  created_at: Date;
  accepted_at: Date | null;
  running_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

const COLUMNS = `id, org_id, plant, asset, tag, command, target, status, reason, requested_by, requested_email,
  max_duration_minutes, created_at, accepted_at, running_at, finished_at, updated_at`;

const TERMINAL = ['done', 'failed', 'rejected', 'timeout', 'cancelled'];

export const rowToRecord = (r: OrderRow): OrderRecord => ({
  id: r.id,
  orgId: r.org_id,
  plant: r.plant,
  asset: r.asset,
  tag: r.tag,
  command: r.command,
  ...(r.target !== null ? { target: Number(r.target) } : {}),
  status: r.status,
  requestedBy: { id: r.requested_by ?? '', email: r.requested_email },
  requestedAt: r.created_at.getTime(),
  updatedAt: r.updated_at.getTime(),
  ...(r.finished_at ? { completedAt: r.finished_at.getTime() } : {}),
  ...(r.reason ? { reason: r.reason } : {}),
  maxDurationMinutes: r.max_duration_minutes,
  ...(r.accepted_at ? { acceptedAt: r.accepted_at.getTime() } : {}),
  ...(r.running_at ? { runningAt: r.running_at.getTime() } : {}),
});

const ts = (ms: number) => new Date(ms);

@Injectable()
export class PgOrdersRepository extends OrdersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async create(
    o: NewOrder,
    supersede: { reason: string } | null,
  ): Promise<{ order: OrderRecord; superseded: OrderRecord[] } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let superseded: OrderRecord[] = [];
      if (supersede) {
        const upd = await client.query<OrderRow>(
          `UPDATE orders SET status = 'cancelled', reason = $3, finished_at = $4, updated_at = $4
            WHERE plant = $1 AND asset = $2 AND status = ANY($5::text[])
            RETURNING ${COLUMNS}`,
          [o.plant, o.asset, supersede.reason, ts(o.now), OPEN_STATUSES],
        );
        superseded = upd.rows.map(rowToRecord);
      }
      try {
        const ins = await client.query<OrderRow>(
          `INSERT INTO orders (id, org_id, plant, asset, tag, command, target, requested_by, requested_email,
                               max_duration_minutes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           RETURNING ${COLUMNS}`,
          [
            o.id,
            o.orgId,
            o.plant,
            o.asset,
            o.tag,
            o.command,
            o.target ?? null,
            o.requestedBy.id,
            o.requestedBy.email,
            o.maxDurationMinutes,
            ts(o.now),
          ],
        );
        await client.query('COMMIT');
        return { order: rowToRecord(ins.rows[0]), superseded };
      } catch (err) {
        // 23505 en orders_one_open_uidx: otra orden en curso (carrera entre dos peticiones).
        if ((err as { code?: string }).code === '23505') {
          await client.query('ROLLBACK');
          return null;
        }
        throw err;
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<OrderRecord | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async list(f: ListOrdersFilter): Promise<OrderRecord[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders
        WHERE plant = $1 AND ($2::text IS NULL OR asset = $2) AND ($3::text IS NULL OR status = $3)
          AND ($4::timestamptz IS NULL OR created_at < $4)
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [
        f.plant,
        f.asset ?? null,
        f.status ?? null,
        f.before !== undefined ? ts(f.before) : null,
        f.limit,
      ],
    );
    return rows.map(rowToRecord);
  }

  async findOpen(): Promise<OrderRecord[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders WHERE status = ANY($1::text[]) ORDER BY created_at`,
      [OPEN_STATUSES],
    );
    return rows.map(rowToRecord);
  }

  async findOpenByAsset(plant: string, asset: string): Promise<OrderRecord[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders WHERE plant = $1 AND asset = $2 AND status = ANY($3::text[])`,
      [plant, asset, OPEN_STATUSES],
    );
    return rows.map(rowToRecord);
  }

  async transition(
    id: string,
    from: readonly OrderStatus[],
    to: OrderStatus,
    p: TransitionPatch,
  ): Promise<OrderRecord | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
          SET status = $3, updated_at = $4,
              reason = COALESCE($5, reason),
              accepted_at = CASE WHEN $3 = 'accepted' THEN $4 ELSE accepted_at END,
              running_at = CASE WHEN $3 = 'running' THEN $4 ELSE running_at END,
              finished_at = CASE WHEN $3 = ANY($6::text[]) THEN $4 ELSE finished_at END
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING ${COLUMNS}`,
      [id, from, to, ts(p.now), p.reason?.slice(0, 300) ?? null, TERMINAL],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }
}
