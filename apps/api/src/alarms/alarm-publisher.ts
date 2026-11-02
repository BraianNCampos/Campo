import { redisKeys } from '@campo/shared';
import type { AlarmEvent } from '@campo/shared';
import type Redis from 'ioredis';
import { activeField } from './alarm.types';

/**
 * Publica una alarma: mantiene el hash de activas (`campo:alarms:active:{plant}`: sólo las que tienen la
 * condición cumplida y NO están postergadas) y la difunde por pub/sub, de donde la toma el WebSocket.
 * Una postergada se difunde (lifecycle `shelved`) para que la web la saque de la lista, pero no cuenta como activa.
 */
export async function publishAlarm(redis: Redis, ev: AlarmEvent): Promise<void> {
  const hashKey = redisKeys.activeAlarms(ev.plant);
  const json = JSON.stringify(ev);
  if (ev.state === 'active' && ev.lifecycle !== 'shelved') {
    await redis.hset(hashKey, activeField(ev), json);
  } else {
    await redis.hdel(hashKey, activeField(ev));
  }
  await redis.publish(redisKeys.alarms(ev.plant), json);
}
