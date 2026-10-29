import { Inject, Injectable } from '@nestjs/common';
import { redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import { REDIS } from '../redis/tokens';

/** ¿Existe la planta? Sólo se usa para dar 404 (en vez de 403) a un admin. */
export abstract class PlantCatalog {
  abstract exists(plant: string): Promise<boolean>;
}

/** Existe si tiene estado vivo en Redis o activos en el catálogo. */
@Injectable()
export class PgPlantCatalog extends PlantCatalog {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async exists(plant: string): Promise<boolean> {
    if ((await this.redis.exists(redisKeys.state(plant))) > 0) return true;
    const { rowCount } = await this.pool.query('SELECT 1 FROM assets WHERE plant = $1 LIMIT 1', [
      plant,
    ]);
    return (rowCount ?? 0) > 0;
  }
}
