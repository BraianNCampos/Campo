import { Inject, Injectable } from '@nestjs/common';
import type { ModelInfo } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export interface NewModel {
  plant: string;
  name: string;
  sha256: string;
  data: Buffer;
  createdBy: string | null;
}

/** Acceso a `asset_models`. Los listados nunca leen la columna `data` (hasta 10 MB por fila). */
export abstract class ModelsRepository {
  /** Inserta; si la planta ya tiene ese sha256 devuelve el existente con `created: false`. */
  abstract insert(m: NewModel): Promise<{ model: ModelInfo; created: boolean }>;
  abstract list(plant: string): Promise<ModelInfo[]>;
  abstract getInfo(id: string): Promise<ModelInfo | null>;
  abstract getData(id: string): Promise<Buffer | null>;
  abstract exists(plant: string, id: string): Promise<boolean>;
  /** Ids de los activos de la planta cuyo `model3dRef` apunta a este modelo. */
  abstract assetsUsing(plant: string, id: string): Promise<string[]>;
  /** Devuelve el modelo borrado, o null si no existía en esa planta. */
  abstract delete(plant: string, id: string): Promise<ModelInfo | null>;
  /** Borra todos los modelos de la planta (al eliminarla). Devuelve cuántos. */
  abstract deleteByPlant(plant: string): Promise<number>;
}

interface ModelRow {
  id: string;
  plant: string;
  name: string;
  size: number;
  sha256: string;
  created_at: Date;
}

const COLUMNS = 'id, plant, name, size, sha256, created_at';

const toInfo = (r: ModelRow): ModelInfo => ({
  id: r.id,
  plant: r.plant,
  name: r.name,
  size: r.size,
  sha256: r.sha256,
  createdAt: r.created_at.getTime(),
});

@Injectable()
export class PgModelsRepository extends ModelsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async insert(m: NewModel): Promise<{ model: ModelInfo; created: boolean }> {
    // Dos subidas simultáneas del mismo contenido: una inserta y la otra ve el conflicto y lee la existente.
    for (let attempt = 0; attempt < 3; attempt++) {
      const ins = await this.pool.query<ModelRow>(
        `INSERT INTO asset_models (plant, name, size, sha256, data, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (plant, sha256) DO NOTHING
         RETURNING ${COLUMNS}`,
        [m.plant, m.name, m.data.length, m.sha256, m.data, m.createdBy],
      );
      if (ins.rows[0]) return { model: toInfo(ins.rows[0]), created: true };
      const found = await this.pool.query<ModelRow>(
        `SELECT ${COLUMNS} FROM asset_models WHERE plant = $1 AND sha256 = $2`,
        [m.plant, m.sha256],
      );
      if (found.rows[0]) return { model: toInfo(found.rows[0]), created: false };
      // borrado entre medias: se reintenta la inserción
    }
    throw new Error('no se pudo guardar el modelo (conflicto repetido)');
  }

  async list(plant: string): Promise<ModelInfo[]> {
    const { rows } = await this.pool.query<ModelRow>(
      `SELECT ${COLUMNS} FROM asset_models WHERE plant = $1 ORDER BY created_at DESC, id`,
      [plant],
    );
    return rows.map(toInfo);
  }

  async getInfo(id: string): Promise<ModelInfo | null> {
    const { rows } = await this.pool.query<ModelRow>(
      `SELECT ${COLUMNS} FROM asset_models WHERE id = $1`,
      [id],
    );
    return rows[0] ? toInfo(rows[0]) : null;
  }

  async getData(id: string): Promise<Buffer | null> {
    const { rows } = await this.pool.query<{ data: Buffer }>(
      'SELECT data FROM asset_models WHERE id = $1',
      [id],
    );
    return rows[0]?.data ?? null;
  }

  async exists(plant: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM asset_models WHERE plant = $1 AND id = $2',
      [plant, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async assetsUsing(plant: string, id: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM assets WHERE plant = $1 AND model3d_ref = $2 ORDER BY id',
      [plant, `model:${id}`],
    );
    return rows.map((r) => r.id);
  }

  async delete(plant: string, id: string): Promise<ModelInfo | null> {
    const { rows } = await this.pool.query<ModelRow>(
      `DELETE FROM asset_models WHERE plant = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [plant, id],
    );
    return rows[0] ? toInfo(rows[0]) : null;
  }

  async deleteByPlant(plant: string): Promise<number> {
    const res = await this.pool.query('DELETE FROM asset_models WHERE plant = $1', [plant]);
    return res.rowCount ?? 0;
  }
}
