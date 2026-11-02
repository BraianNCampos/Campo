import { Inject, Injectable } from '@nestjs/common';
import type { AlarmEvent, AlarmLifecycle } from '@campo/shared';
import type { Pool } from 'pg';
import type { PlantScope } from '../auth/plant-access';
import { PG_POOL } from '../database/tokens';
import { AlarmListState, AlarmRecord } from './alarm.types';

export interface ListAlarmsFilter {
  /** `active` = lista (unacked/acked/rtn_unacked), `cleared` = closed, `shelved` = postergadas (§12.2). */
  state?: AlarmListState;
  plant?: string;
  /** Autorización: cliente y/o plantas permitidas (`{}` = sin restricción, sólo platform_admin). */
  scope: PlantScope;
  limit: number;
}

export abstract class AlarmsRepository {
  /** Persiste una alarma recién activada (lifecycle `unacked`). */
  abstract insert(alarm: AlarmEvent): Promise<void>;
  /**
   * Marca como normalizada; devuelve la fila resultante (o null si no existe). Queda `closed` si ya estaba
   * reconocida o postergada, o si `forceClose` (regla eliminada/deshabilitada); si no, `rtn_unacked`.
   */
  abstract markCleared(
    id: string,
    clearedAt: number,
    forceClose?: boolean,
  ): Promise<AlarmRecord | null>;
  /**
   * Reconoce la alarma: unacked -> acked, rtn_unacked -> closed. Idempotente (`changed` indica si se modificó
   * algo; una postergada no se reconoce).
   */
  abstract ack(
    id: string,
    userId: string,
    at: number,
  ): Promise<{ record: AlarmRecord; changed: boolean } | null>;
  /** Posterga una alarma activa (unacked|acked). null si no existe o no se puede postergar. */
  abstract shelve(
    id: string,
    until: number,
    userId: string,
    reason: string,
  ): Promise<AlarmRecord | null>;
  /** Devuelve una postergada a `unacked` (se reanuncia). null si no existe o no estaba postergada. */
  abstract unshelve(id: string): Promise<AlarmRecord | null>;
  abstract findById(id: string): Promise<AlarmRecord | null>;
  abstract list(filter: ListAlarmsFilter): Promise<AlarmRecord[]>;
  /** Alarmas con la condición activa (state='active'), incluidas las postergadas (arranque del motor). */
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
  lifecycle: AlarmLifecycle;
  kind: AlarmRecord['kind'] | null;
  shelved_until: Date | null;
  shelved_by: string | null;
  shelved_reason: string | null;
  r_description?: string | null;
  r_consequence?: string | null;
  r_response?: string | null;
}

/** La racionalización se lee de la regla vigente (LEFT JOIN: la alarma sobrevive a su regla). */
const COLUMNS = `a.id, a.rule_id, a.plant, a.asset, a.metric, a.severity, a.state, a.value, a.threshold, a.message,
  a.triggered_at, a.cleared_at, a.acked_by, a.acked_at, a.lifecycle, a.kind, a.shelved_until, a.shelved_by,
  a.shelved_reason, r.description AS r_description, r.consequence AS r_consequence, r.response AS r_response`;
const FROM = 'alarms a LEFT JOIN alarm_rules r ON r.id = a.rule_id';

export const toRecord = (r: AlarmRow): AlarmRecord => {
  const rationale = {
    ...(r.r_description ? { description: r.r_description } : {}),
    ...(r.r_consequence ? { consequence: r.r_consequence } : {}),
    ...(r.r_response ? { response: r.r_response } : {}),
  };
  return {
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
    lifecycle: r.lifecycle,
    ...(r.kind ? { kind: r.kind } : {}),
    ...(Object.keys(rationale).length > 0 ? { rationale } : {}),
    ...(r.shelved_until ? { shelvedUntil: r.shelved_until.getTime() } : {}),
    ...(r.shelved_reason ? { shelvedReason: r.shelved_reason } : {}),
    ...(r.shelved_by ? { shelvedBy: r.shelved_by } : {}),
    ...(r.cleared_at ? { clearedAt: r.cleared_at.getTime() } : {}),
    ...(r.acked_by ? { acknowledgedBy: r.acked_by } : {}),
    ...(r.acked_at ? { acknowledgedAt: r.acked_at.getTime() } : {}),
  };
};

const LIST_LIFECYCLES_SQL: Record<AlarmListState, string[]> = {
  active: ['unacked', 'acked', 'rtn_unacked'],
  cleared: ['closed'],
  shelved: ['shelved'],
};

@Injectable()
export class PgAlarmsRepository extends AlarmsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async insert(a: AlarmEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO alarms (id, rule_id, plant, asset, metric, severity, state, value, threshold, message, triggered_at,
                           kind, lifecycle)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, to_timestamp($10::double precision / 1000), $11, 'unacked')
       ON CONFLICT (id) DO NOTHING`,
      [
        a.id,
        a.ruleId,
        a.plant,
        a.asset,
        a.metric,
        a.severity,
        a.value,
        a.threshold,
        a.message,
        a.ts,
        a.kind ?? null,
      ],
    );
  }

  /** Ejecuta un UPDATE ... RETURNING a.id y devuelve el registro completo (con la regla) o null. */
  private async updated(sql: string, params: unknown[]): Promise<AlarmRecord | null> {
    const upd = await this.pool.query<{ id: string }>(`${sql} RETURNING id`, params);
    return upd.rows[0] ? this.findById(upd.rows[0].id) : null;
  }

  async markCleared(
    id: string,
    clearedAt: number,
    forceClose = false,
  ): Promise<AlarmRecord | null> {
    const rec = await this.updated(
      `UPDATE alarms
          SET state = 'cleared', cleared_at = to_timestamp($2::double precision / 1000),
              rtn_at = to_timestamp($2::double precision / 1000),
              lifecycle = CASE WHEN $3::boolean OR acked_at IS NOT NULL OR lifecycle = 'shelved'
                               THEN 'closed' ELSE 'rtn_unacked' END,
              shelved_until = NULL, shelved_by = NULL, shelved_reason = NULL
        WHERE id = $1 AND state = 'active'`,
      [id, clearedAt, forceClose],
    );
    return rec ?? this.findById(id);
  }

  async ack(
    id: string,
    userId: string,
    at: number,
  ): Promise<{ record: AlarmRecord; changed: boolean } | null> {
    const rec = await this.updated(
      `UPDATE alarms
          SET acked_by = $2, acked_at = to_timestamp($3::double precision / 1000),
              lifecycle = CASE WHEN state = 'cleared' THEN 'closed' ELSE 'acked' END
        WHERE id = $1 AND acked_at IS NULL AND lifecycle IN ('unacked', 'rtn_unacked')`,
      [id, userId, at],
    );
    if (rec) return { record: rec, changed: true };
    const cur = await this.findById(id);
    return cur ? { record: cur, changed: false } : null;
  }

  shelve(id: string, until: number, userId: string, reason: string): Promise<AlarmRecord | null> {
    return this.updated(
      `UPDATE alarms
          SET lifecycle = 'shelved', shelved_until = to_timestamp($2::double precision / 1000),
              shelved_by = $3, shelved_reason = $4
        WHERE id = $1 AND state = 'active' AND lifecycle IN ('unacked', 'acked')`,
      [id, until, userId, reason],
    );
  }

  unshelve(id: string): Promise<AlarmRecord | null> {
    return this.updated(
      `UPDATE alarms
          SET lifecycle = 'unacked', acked_by = NULL, acked_at = NULL,
              shelved_until = NULL, shelved_by = NULL, shelved_reason = NULL
        WHERE id = $1 AND state = 'active' AND lifecycle = 'shelved'`,
      [id],
    );
  }

  async findById(id: string): Promise<AlarmRecord | null> {
    const { rows } = await this.pool.query<AlarmRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE a.id = $1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(f: ListAlarmsFilter): Promise<AlarmRecord[]> {
    const { rows } = await this.pool.query<AlarmRow>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE ($1::text[] IS NULL OR a.lifecycle = ANY($1)) AND ($2::text IS NULL OR a.plant = $2)
          AND ($4::text[] IS NULL OR a.plant = ANY($4))
          AND ($5::text IS NULL OR a.plant IN (SELECT id FROM plants WHERE org_id = $5))
        ORDER BY a.triggered_at DESC LIMIT $3`,
      [
        f.state ? LIST_LIFECYCLES_SQL[f.state] : null,
        f.plant ?? null,
        f.limit,
        f.scope.plants ?? null,
        f.scope.orgId ?? null,
      ],
    );
    return rows.map(toRecord);
  }

  async findActive(): Promise<AlarmRecord[]> {
    const { rows } = await this.pool.query<AlarmRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE a.state = 'active' ORDER BY a.triggered_at`,
    );
    return rows.map(toRecord);
  }
}
