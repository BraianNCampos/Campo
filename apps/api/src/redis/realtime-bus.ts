import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AlarmEvent, ID_PATTERN, TelemetryEvent } from '@campo/shared';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { REDIS_SUB } from './tokens';

export type BusMessage =
  | { kind: 'telemetry'; plant: string; event: TelemetryEvent }
  | { kind: 'alarm'; plant: string; event: AlarmEvent };

const EVENTS_PREFIX = 'campo:events:';
const ALARMS_PREFIX = 'campo:alarms:';

/**
 * Único suscriptor Redis por proceso. Hace PSUBSCRIBE a `campo:events:*` y `campo:alarms:*`
 * y reparte los mensajes ya parseados en memoria (motor de alarmas y gateway WS).
 * Nota: `campo:alarms:active:{plant}` es un hash, no un canal, así que no colisiona.
 */
@Injectable()
export class RealtimeBus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RealtimeBus.name);
  private readonly subject = new Subject<BusMessage>();
  readonly messages$: Observable<BusMessage> = this.subject.asObservable();

  constructor(@Inject(REDIS_SUB) private readonly sub: Redis) {}

  async onModuleInit(): Promise<void> {
    this.sub.on('pmessage', (_pattern: string, channel: string, raw: string) =>
      this.handle(channel, raw),
    );
    await this.sub.psubscribe('campo:events:*', 'campo:alarms:*');
  }

  async onModuleDestroy(): Promise<void> {
    this.subject.complete();
    try {
      await this.sub.punsubscribe();
    } catch {
      /* conexión ya cerrada */
    }
  }

  /** Visible para tests. */
  handle(channel: string, raw: string): void {
    let kind: BusMessage['kind'];
    let plant: string;
    if (channel.startsWith(EVENTS_PREFIX)) {
      kind = 'telemetry';
      plant = channel.slice(EVENTS_PREFIX.length);
    } else if (channel.startsWith(ALARMS_PREFIX)) {
      kind = 'alarm';
      plant = channel.slice(ALARMS_PREFIX.length);
    } else {
      return;
    }
    if (!ID_PATTERN.test(plant)) return;

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.log.warn({ msg: 'mensaje no JSON descartado', channel });
      return;
    }
    if (!data || typeof data !== 'object') return;
    const type = (data as { type?: unknown }).type;
    if (kind === 'telemetry' && type === 'telemetry') {
      const ev = data as TelemetryEvent;
      if (typeof ev.asset !== 'string' || !ev.values || typeof ev.values !== 'object') return;
      this.subject.next({ kind, plant, event: { ...ev, plant } });
    } else if (kind === 'alarm' && type === 'alarm') {
      this.subject.next({ kind, plant, event: { ...(data as AlarmEvent), plant } });
    }
  }
}
