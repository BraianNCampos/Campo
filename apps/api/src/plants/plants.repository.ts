import { Inject, Injectable } from '@nestjs/common';
import type { Plant } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export type RemoveResult =
  | { status: 'ok'; unassignedUserIds: string[] }
  | { status: 'has_assets' }
  | { status: 'not_found' };

export interface PlantFilter {
  /** Sólo estas plantas (undefined = todas). */
  ids?: string[];
  /** Sólo las de este cliente (undefined = todos). */
  orgId?: string;
}

/**
 * Plantas "registradas" (tabla `plants`; cada una pertenece a un cliente, `org_id` NOT NULL). Una planta
 * sólo conocida por Redis o por sus activos NO está registrada y no pertenece a nadie.
 */
export abstract class PlantsRepository {
  /** Ordenadas por id. */
  abstract list(filter?: PlantFilter): Promise<Plant[]>;
  /** ¿Está registrada o tiene activos huérfanos? (impide reutilizar el id). */
  abstract isRegistered(id: string): Promise<boolean>;
  /** Crea la planta en el cliente; false si el id ya está registrado (en cualquier cliente) o tiene activos. */
  abstract create(id: string, name: string, orgId: string): Promise<boolean>;
  /** Cambia el nombre (no el cliente). */
  abstract rename(id: string, name: string): Promise<Plant | null>;
  /**
   * Borra la planta junto con TODO lo que cuelga de ella (reglas, alarmas, modelos y asignaciones de usuario),
   * atómicamente: el id queda libre y nadie hereda datos del cliente anterior. `has_assets` si aún tiene
   * activos; `not_found` si no estaba registrada.
   */
  abstract remove(id: string): Promise<RemoveResult>;
}

const LIST_SQL = `SELECT p.id, p.name, p.org_id AS "orgId",
                         (SELECT count(*) FROM assets a WHERE a.plant = p.id)::int AS assets
                    FROM plants p
                   WHERE ($1::text[] IS NULL OR p.id = ANY($1)) AND ($2::text IS NULL OR p.org_id = $2)
                   ORDER BY p.id`;

@Injectable()
export class PgPlantsRepository extends PlantsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async list(filter: PlantFilter = {}): Promise<Plant[]> {
    const { rows } = await this.pool.query<Plant>(LIST_SQL, [
      filter.ids ?? null,
      filter.orgId ?? null,
    ]);
    return rows;
  }

  async isRegistered(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM plants WHERE id = $1 UNION ALL SELECT 1 FROM assets WHERE plant = $1 LIMIT 1',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async create(id: string, name: string, orgId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO plants (id, name, org_id)
       SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM assets WHERE plant = $1)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, orgId],
    );
    return (rowCount ?? 0) > 0;
  }

  async rename(id: string, name: string): Promise<Plant | null> {
    const { rowCount } = await this.pool.query('UPDATE plants SET name = $2 WHERE id = $1', [
      id,
      name,
    ]);
    if ((rowCount ?? 0) === 0) return null;
    return (await this.list({ ids: [id] }))[0] ?? null;
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
      if ((del.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { status: 'not_found' };
      }
      const unassigned = await client.query<{ user_id: string }>(
        'DELETE FROM user_plants WHERE plant = $1 RETURNING user_id',
        [id],
      );
      await client.query('DELETE FROM alarm_rules WHERE plant = $1', [id]);
      await client.query('DELETE FROM alarms WHERE plant = $1', [id]);
      await client.query('DELETE FROM asset_models WHERE plant = $1', [id]);
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
