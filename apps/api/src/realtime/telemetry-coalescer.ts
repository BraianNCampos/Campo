import type { TelemetryEvent } from '@campo/shared';

/**
 * Agrupa telemetría en ventanas de `windowMs` por (planta, activo): de cada activo sólo sale
 * el último valor de cada métrica. Los eventos de un mismo activo se fusionan por métrica para
 * no perder métricas que llegan en mensajes distintos dentro de la misma ventana.
 */
export class TelemetryCoalescer {
  private pending = new Map<string, Map<string, TelemetryEvent>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: (plant: string, events: TelemetryEvent[]) => void,
  ) {}

  push(ev: TelemetryEvent): void {
    let assets = this.pending.get(ev.plant);
    if (!assets) {
      assets = new Map();
      this.pending.set(ev.plant, assets);
    }
    const prev = assets.get(ev.asset);
    assets.set(ev.asset, prev ? { ...ev, values: { ...prev.values, ...ev.values } } : ev);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = new Map();
    for (const [plant, assets] of batch) {
      this.onFlush(plant, [...assets.values()]);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
