import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import type { AuthUser } from '../auth/auth.types';
import { assertPlantAccess, plantFilter } from '../auth/plant-access';
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

  /** Sólo alarmas de las plantas del usuario; `?plant=` pedido y no permitido -> 403. */
  list(q: ListAlarmsQuery, user: AuthUser): Promise<AlarmRecord[]> {
    if (q.plant) assertPlantAccess(user, q.plant);
    return this.repo.list({
      state: q.state,
      plant: q.plant,
      plants: plantFilter(user),
      limit: q.limit ?? 100,
    });
  }

  /** Reconoce una alarma (idempotente). Si cambió, actualiza Redis y avisa por pub/sub. */
  async ack(id: string, user: AuthUser, now = Date.now()): Promise<AlarmRecord> {
    // La planta de la alarma decide: 404 si no existe, 403 si el usuario no tiene esa planta.
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Alarma no encontrada');
    assertPlantAccess(user, existing.plant);
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
