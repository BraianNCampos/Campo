import type { InterlockItem, Order, OrderPreview } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { errorFromResponse } from '@/lib/admin/errors';
import { resolveScale } from '@/lib/modules/scale';
import { useLiveStore } from '@/store/live-store';
import type { DemoControlEngine, DemoUser } from './demo-engine';
import { controlErrorFromResponse } from './errors';
import { canEditSetpoint } from './interlocks';
import type { ControlApi, OrderQuery, PreviewRequest, SetpointResult } from './types';

export interface MockControlOptions {
  user: () => DemoUser;
  engine: (plant: string) => DemoControlEngine;
  /** demora simulada de la red (ms) */
  latencyMs?: number;
}

/** Cliente de control del modo demo: delega en el servidor simulado de la planta (`demo-engine.ts`). */
export class MockControlApi implements ControlApi {
  constructor(private readonly o: MockControlOptions) {}

  private run<T>(fn: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        try {
          resolve(fn());
        } catch (e) {
          reject(e);
        }
      };
      if (this.o.latencyMs) setTimeout(go, this.o.latencyMs);
      else go();
    });
  }

  preview(plant: string, asset: string, req: PreviewRequest): Promise<OrderPreview> {
    return this.run(() => this.o.engine(plant).preview(this.o.user(), asset, req));
  }
  execute(plant: string, asset: string, confirmId: string): Promise<Order> {
    return this.run(() => this.o.engine(plant).execute(this.o.user(), asset, confirmId));
  }
  listOrders(plant: string, q?: OrderQuery): Promise<Order[]> {
    return this.run(() => this.o.engine(plant).list(q));
  }
  cancelOrder(orderId: string): Promise<Order> {
    // el id lleva la planta: ord-<planta>-<n>
    return this.run(() => {
      const plant = /^ord-(.+)-\d+$/.exec(orderId)?.[1];
      if (!plant) throw controlErrorFromResponse(404, {});
      return this.o.engine(plant).cancel(this.o.user(), orderId);
    });
  }
  interlocks(plant: string, asset: string): Promise<InterlockItem[]> {
    return this.run(() => this.o.engine(plant).interlocksOf(this.o.user(), asset));
  }
  async setSetpoint(plant: string, asset: string, metric: string, value: number): Promise<SetpointResult> {
    await this.run(() => {
      if (!canEditSetpoint(this.o.user().role)) throw controlErrorFromResponse(403, {});
    });
    const def = useLiveStore.getState().catalog[asset];
    if (!def) throw controlErrorFromResponse(404, {});
    const scale = resolveScale(def, metric, useLiveStore.getState().limitsByAsset[asset]?.filter((l) => l.metric === metric));
    if (!Number.isFinite(value) || (scale && (value < scale.min || value > scale.max))) {
      throw errorFromResponse(400, { message: [scale ? `value: tiene que estar dentro de la escala de la métrica (${scale.min} a ${scale.max})` : 'value: tiene que ser un número'] });
    }
    const prev = (def.metadata as { setpoints?: Record<string, number> }).setpoints ?? {};
    await getAdminApi().updateAsset(plant, asset, { metadata: { ...def.metadata, setpoints: { ...prev, [metric]: value } } });
    return { metric, value };
  }
}
