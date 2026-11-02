import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { PlantScope } from '../auth/plant-access';
import { PG_POOL } from '../database/tokens';
import { AlarmRule, AlarmRuleInput, resolveRule } from './alarm.types';

export abstract class AlarmRulesRepository {
  /** `scope` restringe por cliente y/o plantas (ver PlantScope; `{}` = sin restricción, sólo uso interno y platform_admin). */
  abstract list(plant?: string, scope?: PlantScope): Promise<AlarmRule[]>;
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
  kind: AlarmRule['kind'];
  roc_window_seconds: number;
  roc_direction: AlarmRule['rocDirection'];
  off_delay_seconds: number;
  suppress_when: AlarmRule['suppressWhen'];
  description: string | null;
  consequence: string | null;
  response: string | null;
  out_of_service_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis, enabled, kind, roc_window_seconds, roc_direction, off_delay_seconds, suppress_when, description, consequence, response, out_of_service_reason, created_at, updated_at';

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
  kind: 'kind',
  rocWindowSeconds: 'roc_window_seconds',
  rocDirection: 'roc_direction',
  offDelaySeconds: 'off_delay_seconds',
  suppressWhen: 'suppress_when',
  description: 'description',
  consequence: 'consequence',
  response: 'response',
  outOfServiceReason: 'out_of_service_reason',
};

const toRule = (r: RuleRow): AlarmRule =>
  resolveRule({
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
    kind: r.kind,
    rocWindowSeconds: r.roc_window_seconds,
    rocDirection: r.roc_direction,
    offDelaySeconds: r.off_delay_seconds,
    suppressWhen: r.suppress_when,
    description: r.description,
    consequence: r.consequence,
    response: r.response,
    outOfServiceReason: r.out_of_service_reason,
    createdAt: r.created_at.getTime(),
    updatedAt: r.updated_at.getTime(),
  });

@Injectable()
export class PgAlarmRulesRepository extends AlarmRulesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async list(plant?: string, scope: PlantScope = {}): Promise<AlarmRule[]> {
    const { rows } = await this.pool.query<RuleRow>(
      `SELECT ${COLUMNS} FROM alarm_rules
        WHERE ($1::text IS NULL OR plant = $1) AND ($2::text[] IS NULL OR plant = ANY($2))
          AND ($3::text IS NULL OR plant IN (SELECT id FROM plants WHERE org_id = $3))
        ORDER BY plant, asset, metric, created_at`,
      [plant ?? null, scope.plants ?? null, scope.orgId ?? null],
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
    const r = resolveRule({ ...i, id: '', createdAt: 0, updatedAt: 0 });
    const { rows } = await this.pool.query<RuleRow>(
      `INSERT INTO alarm_rules (plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis, enabled,
                                kind, roc_window_seconds, roc_direction, off_delay_seconds, suppress_when,
                                description, consequence, response, out_of_service_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
       RETURNING ${COLUMNS}`,
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
        r.kind,
        r.rocWindowSeconds,
        r.rocDirection,
        r.offDelaySeconds,
        r.suppressWhen ? JSON.stringify(r.suppressWhen) : null,
        r.description,
        r.consequence,
        r.response,
        r.outOfServiceReason,
      ],
    );
    return toRule(rows[0]);
  }

  async update(id: string, patch: Partial<AlarmRuleInput>): Promise<AlarmRule | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof AlarmRuleInput)[]) {
      if (patch[key] === undefined) continue;
      const v = patch[key];
      if (key === 'suppressWhen') {
        values.push(v === null ? null : JSON.stringify(v));
        sets.push(`suppress_when = $${values.length}::jsonb`);
        continue;
      }
      values.push(v);
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
