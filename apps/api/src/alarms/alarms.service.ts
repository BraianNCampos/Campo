import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import type { AuthUser } from '../auth/auth.types';
import { REDIS } from '../redis/tokens';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmRecord, activeField, toEvent } from './alarm.types';
import { AlarmsRepository } from './alarms.repository';
import { ListAlarmsQuery } from './dto';

@Injectable()
export class AlarmsService {
  constructor(
    private readonly repo: AlarmsRepository,
    private readonly engine: AlarmEngine,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  list(q: ListAlarmsQuery): Promise<AlarmRecord[]> {
    return this.repo.list({ state: q.state, plant: q.plant, limit: q.limit ?? 100 });
  }

  /** Reconoce una alarma (idempotente). Si cambió, actualiza Redis y avisa por pub/sub. */
  async ack(id: string, user: AuthUser, now = Date.now()): Promise<AlarmRecord> {
    const res = await this.repo.ack(id, user.id, now);
    if (!res) throw new NotFoundException('Alarma no encontrada');
    if (res.changed) {
      this.engine.markAcknowledged(id);
      const json = JSON.stringify(toEvent(res.record));
      if (res.record.state === 'active') {
        await this.redis.hset(
          redisKeys.activeAlarms(res.record.plant),
          activeField(res.record),
          json,
        );
      }
      await this.redis.publish(redisKeys.alarms(res.record.plant), json);
    }
    return res.record;
  }
}
