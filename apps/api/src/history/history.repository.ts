import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import { HistoryPlan } from './history.planner';

export interface HistoryPoint {
  /** Inicio del bucket, epoch ms. */
  t: number;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

export abstract class HistoryRepository {
  abstract query(
    plant: string,
    asset: string,
    metric: string,
    plan: HistoryPlan,
  ): Promise<HistoryPoint[]>;
}

// Todas las consultas son parametrizadas; los nombres de tabla son literales fijos (no vienen del cliente).
const RAW_SQL = `
  SELECT (extract(epoch FROM time_bucket(make_interval(secs => $5::double precision), "time")) * 1000)::double precision AS t,
         avg(value) AS avg, min(value) AS min, max(value) AS max, count(*)::int AS samples
    FROM telemetry
   WHERE plant = $1 AND asset = $2 AND metric = $3 AND "time" >= $4 AND "time" < $6
   GROUP BY 1
   ORDER BY 1
   LIMIT $7`;

// Re-agrega los buckets de 1 min; la media se pondera por nº de muestras.
const AGG_SQL = `
  SELECT (extract(epoch FROM time_bucket(make_interval(secs => $5::double precision), bucket)) * 1000)::double precision AS t,
         (sum(avg * samples) / NULLIF(sum(samples), 0)) AS avg, min("min") AS min, max("max") AS max,
         sum(samples)::int AS samples
    FROM telemetry_1m
   WHERE plant = $1 AND asset = $2 AND metric = $3 AND bucket >= $4 AND bucket < $6
   GROUP BY 1
   ORDER BY 1
   LIMIT $7`;

@Injectable()
export class PgHistoryRepository extends HistoryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async query(
    plant: string,
    asset: string,
    metric: string,
    plan: HistoryPlan,
  ): Promise<HistoryPoint[]> {
    const sql = plan.source === 'raw' ? RAW_SQL : AGG_SQL;
    const { rows } = await this.pool.query<Record<string, unknown>>(sql, [
      plant,
      asset,
      metric,
      plan.from,
      plan.bucketSeconds,
      plan.to,
      plan.limit,
    ]);
    return rows.map((r) => ({
      t: Number(r.t),
      avg: Number(r.avg),
      min: Number(r.min),
      max: Number(r.max),
      samples: Number(r.samples),
    }));
  }
}
