import { Inject, Injectable, Logger } from '@nestjs/common';
import { AssetState, SnapshotMessage, redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import { REDIS } from '../redis/tokens';

@Injectable()
export class StateService {
  private readonly log = new Logger(StateService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Lee el hash campo:state:{plant}; descarta entradas con JSON inválido. */
  async getSnapshot(plant: string): Promise<SnapshotMessage> {
    const raw = await this.redis.hgetall(redisKeys.state(plant));
    const assets: Record<string, AssetState> = {};
    for (const [asset, json] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(json) as AssetState;
        if (parsed && typeof parsed === 'object' && parsed.values) assets[asset] = parsed;
      } catch {
        this.log.warn({ msg: 'estado inválido ignorado', plant, asset });
      }
    }
    return { type: 'snapshot', plant, assets };
  }
}
