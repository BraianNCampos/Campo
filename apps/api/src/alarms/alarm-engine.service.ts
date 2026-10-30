import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AlarmEvent, redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import { Subscription, filter } from 'rxjs';
import { PlantCatalog } from '../auth/plant-catalog';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { RealtimeBus } from '../redis/realtime-bus';
import { REDIS } from '../redis/tokens';
import { AlarmEvaluator } from './alarm-evaluator';
import { AlarmRecord, activeField } from './alarm.types';
import { AlarmRulesRepository } from './alarm-rules.repository';
import { AlarmsRepository } from './alarms.repository';

/**
 * Motor de alarmas: escucha telemetría (bus compartido), evalúa reglas en memoria y mantiene
 * el ciclo de vida (Redis activo + pub/sub + persistencia en Postgres).
 * Las transiciones se aplican en serie (cola de promesas) para conservar el orden.
 */
@Injectable()
export class AlarmEngine implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AlarmEngine.name);
  private readonly evaluator = new AlarmEvaluator();
  private queue: Promise<void> = Promise.resolve();
  private sub?: Subscription;
  private timer?: NodeJS.Timeout;
  private restored = false;
  private rulesLoaded = false;

  constructor(
    private readonly rules: AlarmRulesRepository,
    private readonly alarms: AlarmsRepository,
    private readonly bus: RealtimeBus,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly catalog: PlantCatalog,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.alarmEngineEnabled) {
      this.log.log('motor de alarmas deshabilitado (ALARM_ENGINE_ENABLED=false)');
      return;
    }
    this.sub = this.bus.messages$
      .pipe(filter((m) => m.kind === 'telemetry'))
      .subscribe((m) => this.onTelemetry(m.event));
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.alarmRulesRefreshMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
  }

  /** Recarga la caché de reglas (se llama al cambiar una regla y de forma periódica). */
  async refresh(): Promise<void> {
    try {
      const rules = await this.rules.list();
      const orphans = this.evaluator.setRules(rules, Date.now());
      this.rulesLoaded = true;
      this.enqueue(orphans);
      if (!this.restored) await this.restoreActive();
    } catch (err) {
      this.log.error({ msg: 'no se pudieron recargar las reglas', error: (err as Error).message });
    }
  }

  /** Espera a que se apliquen las transiciones pendientes (tests / apagado ordenado). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Visible para tests. */
  onTelemetry(ev: Parameters<AlarmEvaluator['evaluate']>[0], now = Date.now()): void {
    if (!this.rulesLoaded) return;
    this.enqueue(this.evaluator.evaluate(ev, now));
  }

  /** Mantiene sincronizado el estado en memoria cuando alguien reconoce una alarma. */
  markAcknowledged(id: string): void {
    this.evaluator.markAcknowledged(id);
  }

  /**
   * Al arrancar restaura las alarmas activas de la base. Una alarma de una planta que ya no está registrada
   * (sin cliente propietario) se cierra en vez de restaurarse: ni se republica ni queda "activa" para nadie.
   */
  private async restoreActive(): Promise<void> {
    const persisted: AlarmRecord[] = [];
    const owned = new Map<string, boolean>();
    let unowned = 0;
    for (const a of await this.alarms.findActive()) {
      if (!owned.has(a.plant)) owned.set(a.plant, (await this.catalog.orgOf(a.plant)) !== null);
      if (owned.get(a.plant)) persisted.push(a);
      else {
        unowned++;
        await this.safe('cerrar alarma sin planta', () => this.alarms.markCleared(a.id, Date.now()));
      }
    }
    if (unowned > 0) this.log.warn({ msg: 'alarmas de plantas sin cliente cerradas', count: unowned });
    const orphans = this.evaluator.restore(persisted, Date.now());
    this.restored = true;
    for (const a of persisted) {
      if (orphans.some((o) => o.id === a.id)) continue;
      await this.redis.hset(redisKeys.activeAlarms(a.plant), activeField(a), JSON.stringify(a));
    }
    this.enqueue(orphans);
    if (persisted.length > 0) {
      this.log.log({ msg: 'alarmas activas restauradas', count: persisted.length });
    }
  }

  private enqueue(events: AlarmEvent[]): void {
    if (events.length === 0) return;
    this.queue = this.queue.then(async () => {
      for (const ev of events) {
        try {
          await this.apply(ev);
        } catch (err) {
          this.log.error({
            msg: 'fallo aplicando transición',
            alarmId: ev.id,
            error: (err as Error).message,
          });
        }
      }
    });
  }

  private async apply(ev: AlarmEvent): Promise<void> {
    let out = ev;
    if (ev.state === 'active') {
      await this.safe('persistir alarma', () => this.alarms.insert(ev));
    } else {
      const row = await this.safe('cerrar alarma', () => this.alarms.markCleared(ev.id, ev.ts));
      out = { ...ev, acknowledged: row?.acknowledged ?? ev.acknowledged ?? false };
    }
    const json = JSON.stringify(out);
    const hashKey = redisKeys.activeAlarms(ev.plant);
    if (ev.state === 'active') await this.redis.hset(hashKey, activeField(ev), json);
    else await this.redis.hdel(hashKey, activeField(ev));
    await this.redis.publish(redisKeys.alarms(ev.plant), json);
    this.log.log({
      msg: `alarma ${ev.state}`,
      alarmId: ev.id,
      plant: ev.plant,
      asset: ev.asset,
      metric: ev.metric,
      severity: ev.severity,
      value: ev.value,
    });
  }

  /** Un fallo de base de datos no debe impedir publicar en Redis (ruta caliente). */
  private async safe<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.log.error({ msg: `error al ${what}`, error: (err as Error).message });
      return null;
    }
  }
}
