import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export type AssetType = 'tank' | 'pump' | 'valve' | 'sensor';

export interface Asset {
  plant: string;
  id: string;
  name: string;
  type: AssetType;
  model3dRef: string | null;
  metadata: Record<string, unknown>;
}

export abstract class AssetsRepository {
  abstract listByPlant(plant: string): Promise<Asset[]>;
}

interface AssetRow {
  plant: string;
  id: string;
  name: string;
  type: AssetType;
  model3d_ref: string | null;
  metadata: Record<string, unknown>;
}

@Injectable()
export class PgAssetsRepository extends AssetsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async listByPlant(plant: string): Promise<Asset[]> {
    const { rows } = await this.pool.query<AssetRow>(
      'SELECT plant, id, name, type, model3d_ref, metadata FROM assets WHERE plant = $1 ORDER BY id',
      [plant],
    );
    return rows.map((r) => ({
      plant: r.plant,
      id: r.id,
      name: r.name,
      type: r.type,
      model3dRef: r.model3d_ref,
      metadata: r.metadata ?? {},
    }));
  }
}
