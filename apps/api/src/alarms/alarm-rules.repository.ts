import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import type { AlarmRule, AlarmRuleInput } from './alarm.types';

export abstract class AlarmRulesRepository {
  /** `plants` restringe a esas plantas (undefined = sin restricción; [] = ninguna). */
  abstract list(plant?: string, plants?: string[]): Promise<AlarmRule[]>;
  abstract get(id: string): Promise<AlarmRule | null>;
  abstract create(input: AlarmRuleInput): Promise<AlarmRule>;
  abstract update(id: string, patch: Partial<AlarmRuleInput>): Promise<AlarmRule | null>;
  abstract delete(id: string): Promise<boolean>;
}

interface RuleRow {
  id: string;
  plant: string;
  asset: string;
  metric: string;
  operator: AlarmRule['operator'];
  threshold: number;
  severity: AlarmRule['severity'];
  for_seconds: number;
  hysteresis: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis, enabled, created_at, updated_at';

/** Campo de la API -> columna. Lista blanca: nada del cliente llega al SQL como identificador. */
const PATCH_COLUMNS: Record<keyof AlarmRuleInput, string> = {
  plant: 'plant',
  asset: 'asset',
  metric: 'metric',
  operator: 'operator',
  threshold: 'threshold',
  severity: 'severity',
  forSeconds: 'for_seconds',
  hysteresis: 'hysteresis',
  enabled: 'enabled',
};

const toRule = (r: RuleRow): AlarmRule => ({
  id: r.id,
  plant: r.plant,
  asset: r.asset,
  metric: r.metric,
  operator: r.operator,
  threshold: Number(r.threshold),
  severity: r.severity,
  forSeconds: r.for_seconds,
  hysteresis: Number(r.hysteresis),
  enabled: r.enabled,
  createdAt: r.created_at.getTime(),
  updatedAt: r.updated_at.getTime(),
});

@Injectable()
export class PgAlarmRulesRepository extends AlarmRulesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async list(plant?: string, plants?: string[]): Promise<AlarmRule[]> {
    const { rows } = await this.pool.query<RuleRow>(
      `SELECT ${COLUMNS} FROM alarm_rules
        WHERE ($1::text IS NULL OR plant = $1) AND ($2::text[] IS NULL OR plant = ANY($2))
        ORDER BY plant, asset, metric, created_at`,
      [plant ?? null, plants ?? null],
    );
    return rows.map(toRule);
  }

  async get(id: string): Promise<AlarmRule | null> {
    const { rows } = await this.pool.query<RuleRow>(
      `SELECT ${COLUMNS} FROM alarm_rules WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  async create(i: AlarmRuleInput): Promise<AlarmRule> {
    const { rows } = await this.pool.query<RuleRow>(
      `INSERT INTO alarm_rules (plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [
        i.plant,
        i.asset,
        i.metric,
        i.operator,
        i.threshold,
        i.severity,
        i.forSeconds,
        i.hysteresis,
        i.enabled,
      ],
    );
    return toRule(rows[0]);
  }

  async update(id: string, patch: Partial<AlarmRuleInput>): Promise<AlarmRule | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof AlarmRuleInput)[]) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      sets.push(`${PATCH_COLUMNS[key]} = $${values.length}`);
    }
    if (sets.length === 0) return this.get(id);
    const { rows } = await this.pool.query<RuleRow>(
      `UPDATE alarm_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM alarm_rules WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
