import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from './tokens';

/** Canal Redis: los clientes refrescan el catálogo de la planta. Payload: `{"plant":"..."}`. */
export const CATALOG_CHANGED_CHANNEL = 'campo:catalog:changed';

/**
 * Avisa de que el catálogo de una planta cambió (activos, modelos 3D, la propia planta). `RealtimeBus` lo
 * recibe (también en otras réplicas) y el gateway lo reenvía por WebSocket a los clientes de esa planta.
 * Best effort: si Redis falla sólo se registra; los clientes refrescan al reconectar.
 */
@Injectable()
export class CatalogNotifier {
  private readonly log = new Logger(CatalogNotifier.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async changed(plant: string): Promise<void> {
    try {
      await this.redis.publish(CATALOG_CHANGED_CHANNEL, JSON.stringify({ plant }));
    } catch (err) {
      this.log.warn({
        msg: 'no se pudo publicar catalog:changed',
        plant,
        error: (err as Error).message,
      });
    }
  }
}
