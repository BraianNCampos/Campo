import { Inject, Injectable } from '@nestjs/common';
import { redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';
import { REDIS } from '../redis/tokens';

/** Registro de plantas: a qué cliente pertenece cada una y si existe. */
export abstract class PlantCatalog {
  /** Cliente propietario de la planta registrada (`plants.org_id`); `null` si no está registrada. */
  abstract orgOf(plant: string): Promise<string | null>;
  /** ¿Tiene estado vivo en Redis? (una planta puede emitir telemetría sin estar registrada). */
  abstract isLive(plant: string): Promise<boolean>;
  /** Registrada o con estado vivo. Sólo se usa para dar 404 a un platform_admin. */
  async exists(plant: string): Promise<boolean> {
    return (await this.orgOf(plant)) !== null || (await this.isLive(plant));
  }
}

@Injectable()
export class PgPlantCatalog extends PlantCatalog {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async orgOf(plant: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ org_id: string }>(
      'SELECT org_id FROM plants WHERE id = $1',
      [plant],
    );
    return rows[0]?.org_id ?? null;
  }

  async isLive(plant: string): Promise<boolean> {
    return (await this.redis.exists(redisKeys.state(plant))) > 0;
  }
}
