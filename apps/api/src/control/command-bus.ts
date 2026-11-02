import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import mqtt, { MqttClient } from 'mqtt';
import { Observable, Subject } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { CMD_ACK_FILTER } from './control.types';

/** Un mensaje recibido en `campo/v1/+/+/cmd/ack`. */
export interface AckMessage {
  topic: string;
  payload: string;
}

/** No se pudo entregar la orden al broker (sin conexión o fallo al publicar). */
export class CommandBusError extends Error {}

/**
 * Canal hacia los equipos (MQTT, §14.4), detrás de una interfaz para poder sustituirlo en las pruebas.
 * Sólo escribe en `campo/v1/{planta}/{activo}/cmd` y lee `campo/v1/+/+/cmd/ack`.
 */
export abstract class CommandBus {
  /** ¿Está configurado el control (hay `MQTT_URL`)? Sin él la API responde 503 `control_unavailable`. */
  abstract configured(): boolean;
  /** Publica con QoS 1 y sin retención. Lanza `CommandBusError` si no hay conexión. */
  abstract publish(topic: string, payload: string): Promise<void>;
  /** Acks de los equipos. */
  abstract readonly acks$: Observable<AckMessage>;
}

/** Cliente MQTT real (paquete `mqtt`). Sin `MQTT_URL` no se conecta y `configured()` es false. */
@Injectable()
export class MqttCommandBus extends CommandBus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MqttCommandBus.name);
  private readonly subject = new Subject<AckMessage>();
  readonly acks$ = this.subject.asObservable();
  private client?: MqttClient;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    super();
  }

  configured(): boolean {
    return Boolean(this.cfg.mqttUrl);
  }

  onModuleInit(): void {
    if (!this.cfg.mqttUrl) {
      this.log.log({ msg: 'MQTT_URL sin definir: el control de equipos queda desactivado' });
      return;
    }
    const client = mqtt.connect(this.cfg.mqttUrl, {
      username: this.cfg.mqttUsername,
      password: this.cfg.mqttPassword,
      ca: this.cfg.mqttCaFile ? readFileSync(this.cfg.mqttCaFile) : undefined,
      clientId: `campo-api-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 2000,
      connectTimeout: 10_000,
      clean: true,
    });
    this.client = client;
    // Con sesión limpia hay que volver a suscribirse en cada (re)conexión.
    client.on('connect', () => {
      client.subscribe(CMD_ACK_FILTER, { qos: 1 }, (err) => {
        if (err) this.log.error({ msg: 'no se pudo suscribir a los acks', error: err.message });
        else this.log.log({ msg: 'mqtt conectado', url: this.cfg.mqttUrl });
      });
    });
    client.on('message', (topic, payload) => {
      this.subject.next({ topic, payload: payload.toString('utf8') });
    });
    client.on('error', (err) => this.log.error({ msg: 'mqtt error', error: err.message }));
    client.on('offline', () => this.log.warn({ msg: 'mqtt sin conexión' }));
  }

  async onModuleDestroy(): Promise<void> {
    this.subject.complete();
    const client = this.client;
    if (!client) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref();
      client.end(true, {}, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  publish(topic: string, payload: string): Promise<void> {
    const client = this.client;
    if (!client?.connected) {
      return Promise.reject(new CommandBusError('Sin conexión con el broker MQTT'));
    }
    return new Promise<void>((resolve, reject) => {
      client.publish(topic, payload, { qos: 1, retain: false }, (err) =>
        err ? reject(new CommandBusError(err.message)) : resolve(),
      );
    });
  }
}
