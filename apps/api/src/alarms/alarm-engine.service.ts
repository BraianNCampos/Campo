import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AlarmEvent, AssetState, redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import { Subscription } from 'rxjs';
import { PlantCatalog } from '../auth/plant-catalog';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AssetsRepository } from '../plants/assets.repository';
import { RealtimeBus } from '../redis/realtime-bus';
import { REDIS } from '../redis/tokens';
import { AlarmEvaluator, Suppression } from './alarm-evaluator';
import { AlarmJournalRepository, JournalEntry } from './alarm-journal.repository';
import { publishAlarm } from './alarm-publisher';
import { AlarmRecord, activeField, toEvent } from './alarm.types';
import { AlarmRulesRepository } from './alarm-rules.repository';
import { AlarmsRepository } from './alarms.repository';

/** setTimeout no admite más de 2^31-1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Motor de alarmas: escucha telemetría (bus compartido), evalúa reglas en memoria y mantiene el ciclo de
 * vida (Redis activo + pub/sub + persistencia en Postgres + diario). Las transiciones se aplican en serie
 * (cola de promesas) para conservar el orden; la evaluación en sí es síncrona y nunca espera a la E/S.
 * También posee los vencimientos de las alarmas postergadas.
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
  /** Plantas con reglas DEV activas (sólo ellas necesitan los setpoints del catálogo). */
  private devPlants = new Set<string>();
  /** Postergadas pendientes de vencer: id -> epoch ms. */
  private readonly shelfUntil = new Map<string, number>();
  private shelfTimer?: NodeJS.Timeout;

  constructor(
    private readonly rules: AlarmRulesRepository,
    private readonly alarms: AlarmsRepository,
    private readonly bus: RealtimeBus,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly catalog: PlantCatalog,
    private readonly journal: AlarmJournalRepository,
    private readonly assets: AssetsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.alarmEngineEnabled) {
      this.log.log('motor de alarmas deshabilitado (ALARM_ENGINE_ENABLED=false)');
      return;
    }
    this.sub = this.bus.messages$.subscribe((m) => {
      if (m.kind === 'telemetry') this.onTelemetry(m.event);
      // El catálogo cambió: los setpoints de `metadata.setpoints` pueden haber cambiado.
      else if (m.kind === 'catalog' && this.devPlants.has(m.plant)) {
        void this.refreshSetpoints([m.plant]);
      }
    });
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.alarmRulesRefreshMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    if (this.shelfTimer) clearTimeout(this.shelfTimer);
  }

  /** Recarga la caché de reglas (se llama al cambiar una regla y de forma periódica). */
  async refresh(): Promise<void> {
    try {
      const rules = await this.rules.list();
      this.devPlants = new Set(
        rules.filter((r) => r.enabled && r.kind === 'DEV').map((r) => r.plant),
      );
      await this.refreshSetpoints([...this.devPlants]);
      await this.seedSuppressionState(rules);
      const orphans = this.evaluator.setRules(rules, Date.now());
      this.rulesLoaded = true;
      this.enqueue(orphans, true);
      if (!this.restored) await this.restoreActive();
    } catch (err) {
      this.log.error({ msg: 'no se pudieron recargar las reglas', error: (err as Error).message });
    }
  }

  /** Setpoints de `metadata.setpoints` de los activos de cada planta (una consulta por planta). */
  async refreshSetpoints(plants: string[]): Promise<void> {
    for (const plant of plants) {
      try {
        const byAsset = new Map<string, Record<string, number>>();
        for (const a of await this.assets.listByPlant(plant)) {
          const sp = a.metadata?.['setpoints'];
          if (typeof sp !== 'object' || sp === null || Array.isArray(sp)) continue;
          const clean: Record<string, number> = {};
          for (const [metric, v] of Object.entries(sp)) {
            if (typeof v === 'number' && Number.isFinite(v)) clean[metric] = v;
          }
          if (Object.keys(clean).length > 0) byAsset.set(a.id, clean);
        }
        this.evaluator.setSetpoints(plant, byAsset);
      } catch (err) {
        this.log.error({
          msg: 'no se pudieron leer los setpoints',
          plant,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Último dato (Redis) de los activos que citan las condiciones de supresión, si el motor aún no lo vio. */
  private async seedSuppressionState(rules: Awaited<ReturnType<AlarmRulesRepository['list']>>) {
    const wanted = new Set<string>();
    for (const r of rules) {
      const s = r.enabled ? r.suppressWhen : null;
      if (s && !s.asset.includes('*')) wanted.add(`${r.plant}\u0000${s.asset}`);
    }
    for (const key of wanted) {
      const [plant, asset] = key.split('\u0000');
      try {
        const raw = await this.redis.hget(redisKeys.state(plant), asset);
        const state = raw ? (JSON.parse(raw) as AssetState) : null;
        if (state?.values) this.evaluator.seedState(plant, asset, state.values);
      } catch {
        /* sin dato en Redis: la supresión se evalúa cuando llegue telemetría */
      }
    }
  }

  /** Setpoint recibido por telemetría para una regla DEV y un activo (para el estado de la regla). */
  liveSetpoint(ruleId: string, asset: string): number | undefined {
    return this.evaluator.liveSetpoint(ruleId, asset);
  }

  /** Espera a que se apliquen las transiciones pendientes (tests / apagado ordenado). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Visible para tests. Síncrono: la E/S de las transiciones va a la cola. */
  onTelemetry(ev: Parameters<AlarmEvaluator['evaluate']>[0], now = Date.now()): void {
    if (!this.rulesLoaded) return;
    const out = this.evaluator.evaluate(ev, now);
    if (out.length > 0) this.enqueue(out);
    const suppressed = this.evaluator.takeSuppressions();
    if (suppressed.length > 0) this.enqueueSuppressions(suppressed);
  }

  // ---- Transiciones disparadas por personas (las llama AlarmsService tras actualizar la base) ----

  /** Una alarma reconocida: memoria, diario y difusión. */
  onAcked(record: AlarmRecord, userId: string): Promise<void> {
    return this.serial(async () => {
      this.evaluator.markAcknowledged(record.id);
      const entries: JournalEntry[] = [this.entry(record, 'ack', record.acknowledgedAt, userId)];
      if (record.lifecycle === 'closed')
        entries.push(this.entry(record, 'close', record.acknowledgedAt, userId));
      await this.safe('anotar diario', () => this.journal.add(entries));
      await publishAlarm(this.redis, toEvent(record));
    });
  }

  /** Una alarma postergada: se oculta de la lista y se programa su vencimiento. */
  onShelved(record: AlarmRecord, userId: string, minutes: number): Promise<void> {
    return this.serial(async () => {
      this.evaluator.patchActive(record.id, {
        lifecycle: 'shelved',
        shelvedUntil: record.shelvedUntil,
        shelvedReason: record.shelvedReason,
      });
      if (record.shelvedUntil) this.scheduleExpiry(record.id, record.shelvedUntil);
      const note = `${minutes} min: ${record.shelvedReason ?? ''}`.slice(0, 300);
      await this.safe('anotar diario', () =>
        this.journal.add([{ ...this.entry(record, 'shelve', Date.now(), userId), note }]),
      );
      await publishAlarm(this.redis, toEvent(record));
    });
  }

  /**
   * Devuelve una postergada a la lista (reanuncia: vuelve a `unacked`). `userId` null = vencimiento.
   * null si no estaba postergada.
   */
  unshelve(id: string, userId: string | null, now = Date.now()): Promise<AlarmRecord | null> {
    return this.serial(async () => {
      this.shelfUntil.delete(id);
      this.rearm();
      const record = await this.alarms.unshelve(id);
      if (!record) return null;
      this.evaluator.patchActive(id, {
        lifecycle: 'unacked',
        acknowledged: false,
        shelvedUntil: undefined,
        shelvedReason: undefined,
      });
      await this.safe('anotar diario', () =>
        this.journal.add([
          {
            ...this.entry(record, 'unshelve', now, userId),
            ...(userId ? {} : { note: 'vencimiento' }),
          },
        ]),
      );
      await publishAlarm(this.redis, toEvent(record));
      return record;
    });
  }

  /** Reanuncia las postergadas vencidas a `now`. Visible para tests (reloj falso). */
  async expireDue(now = Date.now()): Promise<number> {
    const due = [...this.shelfUntil].filter(([, until]) => until <= now).map(([id]) => id);
    let n = 0;
    for (const id of due) {
      try {
        if (await this.unshelve(id, null, now)) n++;
      } catch (err) {
        this.log.error({
          msg: 'fallo al vencer postergación',
          alarmId: id,
          error: (err as Error).message,
        });
      }
    }
    return n;
  }

  /** Postergadas con vencimiento programado. Visible para tests. */
  pendingShelved(): string[] {
    return [...this.shelfUntil.keys()];
  }

  private scheduleExpiry(id: string, until: number): void {
    this.shelfUntil.set(id, until);
    this.rearm();
  }

  /** Un único temporizador, para el vencimiento más próximo. */
  private rearm(): void {
    if (this.shelfTimer) clearTimeout(this.shelfTimer);
    this.shelfTimer = undefined;
    if (this.shelfUntil.size === 0) return;
    const next = Math.min(...this.shelfUntil.values());
    const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS);
    this.shelfTimer = setTimeout(() => {
      this.shelfTimer = undefined;
      void this.expireDue().then(() => this.rearm());
    }, delay);
    this.shelfTimer.unref();
  }

  /**
   * Al arrancar restaura las alarmas activas de la base (también las postergadas, cuyo vencimiento se
   * reprograma). Una alarma de una planta que ya no está registrada (sin cliente propietario) se cierra en
   * vez de restaurarse: ni se republica ni queda "activa" para nadie.
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
        await this.safe('cerrar alarma sin planta', () =>
          this.alarms.markCleared(a.id, Date.now(), true),
        );
      }
    }
    if (unowned > 0)
      this.log.warn({ msg: 'alarmas de plantas sin cliente cerradas', count: unowned });
    const orphans = this.evaluator.restore(persisted.map(toEvent), Date.now());
    this.restored = true;
    let shelved = 0;
    for (const a of persisted) {
      if (orphans.some((o) => o.id === a.id)) continue;
      if (a.lifecycle === 'shelved' && a.shelvedUntil) {
        this.shelfUntil.set(a.id, a.shelvedUntil);
        shelved++;
      }
      await publishAlarmSilently(this.redis, toEvent(a));
    }
    this.rearm();
    this.enqueue(orphans, true);
    if (persisted.length > 0) {
      this.log.log({ msg: 'alarmas activas restauradas', count: persisted.length, shelved });
    }
  }

  private entry(
    r: Pick<AlarmRecord, 'id' | 'plant' | 'ruleId' | 'asset' | 'metric' | 'value'>,
    type: JournalEntry['type'],
    ts: number | undefined,
    userId: string | null,
  ): JournalEntry {
    return {
      alarmId: r.id,
      plant: r.plant,
      ruleId: r.ruleId,
      asset: r.asset,
      metric: r.metric,
      ts: ts ?? Date.now(),
      type,
      userId,
      value: r.value,
    };
  }

  /** Encadena `task` en la cola: las transiciones se aplican de una en una y en orden. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const p = this.queue.then(task);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** `close`: las alarmas de una regla eliminada o deshabilitada se cierran sin esperar reconocimiento. */
  private enqueue(events: AlarmEvent[], close = false): void {
    if (events.length === 0) return;
    void this.serial(async () => {
      for (const ev of events) {
        try {
          await this.apply(ev, close);
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

  private enqueueSuppressions(list: Suppression[]): void {
    void this.serial(async () => {
      await this.safe('anotar supresiones', () =>
        this.journal.add(
          list.map((s) => ({
            alarmId: null,
            plant: s.plant,
            ruleId: s.ruleId,
            asset: s.asset,
            metric: s.metric,
            ts: s.ts,
            type: 'suppress' as const,
            value: s.value,
          })),
        ),
      );
    });
  }

  private async apply(ev: AlarmEvent, close: boolean): Promise<void> {
    let out = ev;
    const entries: JournalEntry[] = [];
    if (ev.state === 'active') {
      await this.safe('persistir alarma', () => this.alarms.insert(ev));
      entries.push({ ...this.entry(ev, 'activate', ev.ts, null) });
    } else {
      this.shelfUntil.delete(ev.id);
      const row = await this.safe('cerrar alarma', () =>
        this.alarms.markCleared(ev.id, ev.ts, close),
      );
      out = {
        ...ev,
        acknowledged: row?.acknowledged ?? ev.acknowledged ?? false,
        lifecycle: row?.lifecycle ?? ev.lifecycle,
      };
      if (close) {
        entries.push({
          ...this.entry(ev, 'close', ev.ts, null),
          note: 'regla eliminada o deshabilitada',
        });
      } else {
        entries.push(this.entry(ev, 'rtn', ev.ts, null));
        if (out.lifecycle === 'closed') entries.push(this.entry(ev, 'close', ev.ts, null));
      }
    }
    await this.safe('anotar diario', () => this.journal.add(entries));
    await publishAlarm(this.redis, out);
    this.log.log({
      msg: `alarma ${ev.state}`,
      alarmId: ev.id,
      plant: ev.plant,
      asset: ev.asset,
      metric: ev.metric,
      severity: ev.severity,
      kind: ev.kind,
      lifecycle: out.lifecycle,
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

/** Reescribe el hash de activas al restaurar sin difundir (los clientes se conectan con snapshot + REST). */
async function publishAlarmSilently(redis: Redis, ev: AlarmEvent): Promise<void> {
  if (ev.state !== 'active') return;
  const field = activeField(ev);
  const key = redisKeys.activeAlarms(ev.plant);
  if (ev.lifecycle === 'shelved') await redis.hdel(key, field);
  else await redis.hset(key, field, JSON.stringify(ev));
}
