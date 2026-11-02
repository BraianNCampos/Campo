import { Inject, Injectable } from '@nestjs/common';
import { ASSET_KINDS } from '@campo/shared';
import type { AssetDef, AssetType } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export type { AssetType };
/** El catálogo devuelve exactamente la forma `AssetDef` del contrato (camelCase: `model3dRef`). */
export type Asset = AssetDef;

/** Los 13 tipos del registro compartido (`ASSET_KINDS`); el CHECK de `assets.type` (080_tags_control.sql) los repite. */
export const ASSET_TYPES = Object.keys(ASSET_KINDS) as AssetType[];

/** Campos modificables (el `id` y la planta no cambian). `undefined` = no tocar. */
export interface AssetPatch {
  name?: string;
  type?: AssetType;
  model3dRef?: string | null;
  metadata?: Record<string, unknown>;
  /** `null` = quitar el tag. */
  tag?: string | null;
}

/** El tag ya lo usa otro activo de la planta (índice único `assets_plant_tag_uidx`, sin distinguir mayúsculas). */
export class AssetTagTakenError extends Error {
  constructor(readonly tag: string) {
    super(`El tag ${tag} ya está en uso en la planta`);
  }
}

const TAG_INDEX = 'assets_plant_tag_uidx';
const isTagConflict = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505' &&
  (err as { constraint?: string }).constraint === TAG_INDEX;

export abstract class AssetsRepository {
  abstract listByPlant(plant: string): Promise<Asset[]>;
  abstract get(plant: string, id: string): Promise<Asset | null>;
  /** Activo de la planta con ese tag (sin distinguir mayúsculas). */
  abstract findByTag(plant: string, tag: string): Promise<Asset | null>;
  /** Crea el activo; devuelve null si ya existe. Lanza `AssetTagTakenError` si el tag ya está en uso. */
  abstract create(asset: Asset): Promise<Asset | null>;
  /** Devuelve null si no existe. Lanza `AssetTagTakenError` si el tag ya está en uso. */
  abstract update(plant: string, id: string, patch: AssetPatch): Promise<Asset | null>;
  /** false si no existía. */
  abstract delete(plant: string, id: string): Promise<boolean>;
}

interface AssetRow {
  plant: string;
  id: string;
  name: string;
  type: AssetType;
  model3d_ref: string | null;
  metadata: Record<string, unknown>;
  tag: string | null;
}

const COLUMNS = 'plant, id, name, type, model3d_ref, metadata, tag';

const toAsset = (r: AssetRow): Asset => ({
  plant: r.plant,
  id: r.id,
  name: r.name,
  type: r.type,
  model3dRef: r.model3d_ref,
  metadata: r.metadata ?? {},
  tag: r.tag ?? null,
});

/** Campo de la API -> columna. Lista blanca: nada del cliente llega al SQL como identificador. */
const PATCH_COLUMNS: Record<keyof AssetPatch, string> = {
  name: 'name',
  type: 'type',
  model3dRef: 'model3d_ref',
  metadata: 'metadata',
  tag: 'tag',
};

@Injectable()
export class PgAssetsRepository extends AssetsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async listByPlant(plant: string): Promise<Asset[]> {
    const { rows } = await this.pool.query<AssetRow>(
      `SELECT ${COLUMNS} FROM assets WHERE plant = $1 ORDER BY id`,
      [plant],
    );
    return rows.map(toAsset);
  }

  async get(plant: string, id: string): Promise<Asset | null> {
    const { rows } = await this.pool.query<AssetRow>(
      `SELECT ${COLUMNS} FROM assets WHERE plant = $1 AND id = $2`,
      [plant, id],
    );
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async findByTag(plant: string, tag: string): Promise<Asset | null> {
    const { rows } = await this.pool.query<AssetRow>(
      `SELECT ${COLUMNS} FROM assets WHERE plant = $1 AND lower(tag) = lower($2)`,
      [plant, tag],
    );
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async create(a: Asset): Promise<Asset | null> {
    try {
      const { rows } = await this.pool.query<AssetRow>(
        `INSERT INTO assets (plant, id, name, type, model3d_ref, metadata, tag)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (plant, id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [a.plant, a.id, a.name, a.type, a.model3dRef, JSON.stringify(a.metadata), a.tag ?? null],
      );
      return rows[0] ? toAsset(rows[0]) : null;
    } catch (err) {
      if (isTagConflict(err)) throw new AssetTagTakenError(a.tag ?? '');
      throw err;
    }
  }

  async update(plant: string, id: string, patch: AssetPatch): Promise<Asset | null> {
    const sets: string[] = [];
    const values: unknown[] = [plant, id];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof AssetPatch)[]) {
      const v = patch[key];
      if (v === undefined) continue;
      values.push(key === 'metadata' ? JSON.stringify(v) : v);
      sets.push(`${PATCH_COLUMNS[key]} = $${values.length}${key === 'metadata' ? '::jsonb' : ''}`);
    }
    if (sets.length === 0) return this.get(plant, id);
    try {
      const { rows } = await this.pool.query<AssetRow>(
        `UPDATE assets SET ${sets.join(', ')} WHERE plant = $1 AND id = $2 RETURNING ${COLUMNS}`,
        values,
      );
      return rows[0] ? toAsset(rows[0]) : null;
    } catch (err) {
      if (isTagConflict(err)) throw new AssetTagTakenError(patch.tag ?? '');
      throw err;
    }
  }

  async delete(plant: string, id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM assets WHERE plant = $1 AND id = $2', [
      plant,
      id,
    ]);
    return (res.rowCount ?? 0) > 0;
  }
}
