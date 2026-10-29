import { Inject, Injectable } from '@nestjs/common';
import type { AlarmEvent } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import type { AlarmRecord } from './alarm.types';

export interface ListAlarmsFilter {
  state?: 'active' | 'cleared';
  plant?: string;
  limit: number;
}

export abstract class AlarmsRepository {
  /** Persiste una alarma recién activada. */
  abstract insert(alarm: AlarmEvent): Promise<void>;
  /** Marca como cleared; devuelve la fila resultante (o null si no existe). */
  abstract markCleared(id: string, clearedAt: number): Promise<AlarmRecord | null>;
  /** Reconoce la alarma (sólo la primera vez). `changed` indica si se modificó algo. */
  abstract ack(
    id: string,
    userId: string,
    at: number,
  ): Promise<{ record: AlarmRecord; changed: boolean } | null>;
  abstract list(filter: ListAlarmsFilter): Promise<AlarmRecord[]>;
  abstract findActive(): Promise<AlarmRecord[]>;
}

interface AlarmRow {
  id: string;
  rule_id: string;
  plant: string;
  asset: string;
  metric: string;
  severity: AlarmRecord['severity'];
  state: AlarmRecord['state'];
  value: number;
  threshold: number;
  message: string;
  triggered_at: Date;
  cleared_at: Date | null;
  acked_by: string | null;
  acked_at: Date | null;
}

const COLUMNS =
  'id, rule_id, plant, asset, metric, severity, state, value, threshold, message, triggered_at, cleared_at, acked_by, acked_at';

export const toRecord = (r: AlarmRow): AlarmRecord => ({
  type: 'alarm',
  id: r.id,
  ruleId: r.rule_id,
  plant: r.plant,
  asset: r.asset,
  metric: r.metric,
  severity: r.severity,
  state: r.state,
  value: Number(r.value),
  threshold: Number(r.threshold),
  ts: r.triggered_at.getTime(),
  message: r.message,
  acknowledged: r.acked_at !== null,
  ...(r.cleared_at ? { clearedAt: r.cleared_at.getTime() } : {}),
  ...(r.acked_by ? { acknowledgedBy: r.acked_by } : {}),
  ...(r.acked_at ? { acknowledgedAt: r.acked_at.getTime() } : {}),
});

@Injectable()
export class PgAlarmsRepository extends AlarmsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async insert(a: AlarmEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO alarms (id, rule_id, plant, asset, metric, severity, state, value, threshold, message, triggered_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, to_timestamp($10::double precision / 1000))
       ON CONFLICT (id) DO NOTHING`,
      [a.id, a.ruleId, a.plant, a.asset, a.metric, a.severity, a.value, a.threshold, a.message, a.ts],
    );
  }

  async markCleared(id: string, clearedAt: number): Promise<AlarmRecord | null> {
    const { rows } = await this.pool.query<AlarmRow>(
      `UPDATE alarms SET state = 'cleared', cleared_at = to_timestamp($2::double precision / 1000)
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, clearedAt],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async ack(
    id: string,
    userId: string,
    at: number,
  ): Promise<{ record: AlarmRecord; changed: boolean } | null> {
    const upd = await this.pool.query<AlarmRow>(
      `UPDATE alarms SET acked_by = $2, acked_at = to_timestamp($3::double precision / 1000)
        WHERE id = $1 AND acked_at IS NULL RETURNING ${COLUMNS}`,
      [id, userId, at],
    );
    if (upd.rows[0]) return { record: toRecord(upd.rows[0]), changed: true };
    const sel = await this.pool.query<AlarmRow>(`SELECT ${COLUMNS} FROM alarms WHERE id = $1`, [id]);
    return sel.rows[0] ? { record: toRecord(sel.rows[0]), changed: false } : null;
  }

  async list(f: ListAlarmsFilter): Promise<AlarmRecord[]> {
    const { rows } = await this.pool.query<AlarmRow>(
      `SELECT ${COLUMNS} FROM alarms
        WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR plant = $2)
        ORDER BY triggered_at DESC LIMIT $3`,
      [f.state ?? null, f.plant ?? null, f.limit],
    );
    return rows.map(toRecord);
  }

  async findActive(): Promise<AlarmRecord[]> {
    const { rows } = await this.pool.query<AlarmRow>(
      `SELECT ${COLUMNS} FROM alarms WHERE state = 'active' ORDER BY triggered_at`,
    );
    return rows.map(toRecord);
  }
}
