import { Inject, Injectable } from '@nestjs/common';
import type { Plant } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export type RemoveResult =
  | { status: 'ok'; unassignedUserIds: string[] }
  | { status: 'has_assets' }
  | { status: 'not_found' };

/**
 * Plantas "registradas": las de la tabla `plants` más las que sólo aparecen en `assets`
 * (nombre = id). Las plantas conocidas sólo por Redis las añade PlantsService.
 */
export abstract class PlantsRepository {
  /** `ids` restringe a esas plantas (undefined = todas). Ordenadas por id. */
  abstract list(ids?: string[]): Promise<Plant[]>;
  /** ¿Está en `plants` o tiene activos? */
  abstract isRegistered(id: string): Promise<boolean>;
  /** Crea la planta; false si ya estaba registrada (en `plants` o por tener activos). */
  abstract create(id: string, name: string): Promise<boolean>;
  /** Cambia el nombre (la crea si sólo se conocía por activos). */
  abstract rename(id: string, name: string): Promise<Plant>;
  /**
   * Borra la planta y sus asignaciones de usuario, atómicamente. `has_assets` si aún tiene activos;
   * `not_found` si no estaba registrada.
   */
  abstract remove(id: string): Promise<RemoveResult>;
}

interface PlantRow {
  id: string;
  name: string;
  assets: number;
}

const KNOWN = `SELECT COALESCE(p.id, a.plant) AS id, COALESCE(p.name, a.plant) AS name,
                      COALESCE(a.n, 0)::int AS assets
                 FROM plants p
                 FULL OUTER JOIN (SELECT plant, count(*) AS n FROM assets GROUP BY plant) a
                   ON a.plant = p.id`;

@Injectable()
export class PgPlantsRepository extends PlantsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async list(ids?: string[]): Promise<Plant[]> {
    const { rows } = await this.pool.query<PlantRow>(
      `SELECT * FROM (${KNOWN}) k WHERE $1::text[] IS NULL OR k.id = ANY($1) ORDER BY k.id`,
      [ids ?? null],
    );
    return rows;
  }

  async isRegistered(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM plants WHERE id = $1 UNION ALL SELECT 1 FROM assets WHERE plant = $1 LIMIT 1',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async create(id: string, name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO plants (id, name)
       SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM assets WHERE plant = $1)
       ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
    return (rowCount ?? 0) > 0;
  }

  async rename(id: string, name: string): Promise<Plant> {
    await this.pool.query(
      'INSERT INTO plants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name',
      [id, name],
    );
    const [plant] = await this.list([id]);
    return plant;
  }

  async remove(id: string): Promise<RemoveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const assets = await client.query('SELECT 1 FROM assets WHERE plant = $1 LIMIT 1', [id]);
      if ((assets.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { status: 'has_assets' };
      }
      const del = await client.query('DELETE FROM plants WHERE id = $1', [id]);
      const unassigned = await client.query<{ user_id: string }>(
        'DELETE FROM user_plants WHERE plant = $1 RETURNING user_id',
        [id],
      );
      if ((del.rowCount ?? 0) === 0 && unassigned.rows.length === 0) {
        await client.query('ROLLBACK');
        return { status: 'not_found' };
      }
      await client.query('COMMIT');
      return { status: 'ok', unassignedUserIds: unassigned.rows.map((r) => r.user_id) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
