import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_ALARM_POLICY } from '@campo/shared';
import type { AlarmKind, AlarmPolicy } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import { CHATTER_MIN, HealthData, LIST_CAP, TEN_MIN_MS, TOP_N } from './alarm-kpis';

export abstract class AlarmHealthRepository {
  /** Política de la planta (por defecto `DEFAULT_ALARM_POLICY`). */
  abstract getPolicy(plant: string): Promise<AlarmPolicy>;
  /** false si la planta no está registrada. */
  abstract setPolicy(plant: string, policy: AlarmPolicy): Promise<boolean>;
  /** Datos de la ventana [from, to] (epoch ms); `staleBefore` = activas desde antes de este instante. */
  abstract data(plant: string, from: number, to: number, staleBefore: number): Promise<HealthData>;
}

/** Política guardada -> política válida (campo a campo; lo que falte o sea inválido toma el valor por defecto). */
export function sanitizePolicy(raw: unknown): AlarmPolicy {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof AlarmPolicy): number =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) && o[k] > 0 ? o[k] : DEFAULT_ALARM_POLICY[k];
  return {
    ratePerDay: pick('ratePerDay'),
    peak10min: pick('peak10min'),
    staleHours: pick('staleHours'),
  };
}

const WINDOW = `${(TEN_MIN_MS - 1) / 1000} seconds`; // [t, t + 10 min) con precisión de ms

@Injectable()
export class PgAlarmHealthRepository extends AlarmHealthRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async getPolicy(plant: string): Promise<AlarmPolicy> {
    const { rows } = await this.pool.query<{ alarm_policy: unknown }>(
      'SELECT alarm_policy FROM plants WHERE id = $1',
      [plant],
    );
    return sanitizePolicy(rows[0]?.alarm_policy);
  }

  async setPolicy(plant: string, policy: AlarmPolicy): Promise<boolean> {
    const res = await this.pool.query('UPDATE plants SET alarm_policy = $2::jsonb WHERE id = $1', [
      plant,
      JSON.stringify(policy),
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async data(plant: string, from: number, to: number, staleBefore: number): Promise<HealthData> {
    const range = [plant, from, to];
    const inWindow = `plant = $1 AND triggered_at >= to_timestamp($2::double precision / 1000)
                      AND triggered_at <= to_timestamp($3::double precision / 1000)`;
    const [totals, top, peak, chatter, stale, shelved, suppressed, oos] = await Promise.all([
      this.pool.query<{ total: number; critical: number; warning: number }>(
        `SELECT count(*)::int AS total,
                (count(*) FILTER (WHERE severity = 'critical'))::int AS critical,
                (count(*) FILTER (WHERE severity = 'warning'))::int AS warning
           FROM alarms WHERE ${inWindow}`,
        range,
      ),
      this.pool.query<{
        rule_id: string;
        asset: string;
        metric: string;
        kind: AlarmKind;
        n: number;
      }>(
        `SELECT rule_id, asset, min(metric) AS metric, COALESCE(min(kind), 'HI') AS kind, count(*)::int AS n
           FROM alarms WHERE ${inWindow}
          GROUP BY rule_id, asset ORDER BY n DESC, asset, rule_id LIMIT ${TOP_N}`,
        range,
      ),
      this.pool.query<{ n: number; at: Date }>(
        `SELECT n::int, at FROM (
            SELECT triggered_at AS at,
                   count(*) OVER (ORDER BY triggered_at
                                  RANGE BETWEEN CURRENT ROW AND INTERVAL '${WINDOW}' FOLLOWING) AS n
              FROM alarms WHERE ${inWindow}) w
          ORDER BY n DESC, at LIMIT 1`,
        range,
      ),
      this.pool.query<{ rule_id: string; asset: string; metric: string; n: number }>(
        `SELECT rule_id, asset, min(metric) AS metric, max(n)::int AS n FROM (
            SELECT rule_id, asset, metric,
                   count(*) OVER (PARTITION BY rule_id, asset ORDER BY triggered_at
                                  RANGE BETWEEN CURRENT ROW AND INTERVAL '${WINDOW}' FOLLOWING) AS n
              FROM alarms WHERE ${inWindow}) w
          GROUP BY rule_id, asset HAVING max(n) >= ${CHATTER_MIN}
          ORDER BY n DESC, asset, rule_id LIMIT ${LIST_CAP}`,
        range,
      ),
      this.pool.query<{ id: string; asset: string; metric: string; at: Date }>(
        `SELECT id, asset, metric, triggered_at AS at FROM alarms
          WHERE plant = $1 AND state = 'active' AND lifecycle <> 'shelved'
            AND triggered_at < to_timestamp($2::double precision / 1000)
          ORDER BY triggered_at, id LIMIT ${LIST_CAP}`,
        [plant, staleBefore],
      ),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM alarms WHERE plant = $1 AND lifecycle = 'shelved'`,
        [plant],
      ),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM alarm_events
          WHERE plant = $1 AND type = 'suppress'
            AND ts >= to_timestamp($2::double precision / 1000) AND ts <= to_timestamp($3::double precision / 1000)`,
        range,
      ),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM alarm_rules WHERE plant = $1 AND NOT enabled`,
        [plant],
      ),
    ]);
    const t = totals.rows[0];
    return {
      total: t.total,
      byPriority: { critical: t.critical, warning: t.warning },
      peak10min: peak.rows[0]
        ? { count: peak.rows[0].n, at: peak.rows[0].at.getTime() }
        : { count: 0, at: null },
      top: top.rows.map((r) => ({
        ruleId: r.rule_id,
        asset: r.asset,
        metric: r.metric,
        kind: r.kind,
        count: r.n,
      })),
      chattering: chatter.rows.map((r) => ({
        ruleId: r.rule_id,
        asset: r.asset,
        metric: r.metric,
        activations10min: r.n,
      })),
      stale: stale.rows.map((r) => ({
        id: r.id,
        asset: r.asset,
        metric: r.metric,
        since: r.at.getTime(),
      })),
      shelved: shelved.rows[0].n,
      suppressed: suppressed.rows[0].n,
      outOfService: oos.rows[0].n,
    };
  }
}
