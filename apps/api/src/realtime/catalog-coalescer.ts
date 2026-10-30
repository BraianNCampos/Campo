/**
 * Agrupa avisos de "catálogo cambiado" por planta: tras el primero abre una ventana de `windowMs` y, al
 * cerrarla, emite UN aviso para esa planta (una ráfaga de altas no inunda a los clientes). Cada planta
 * tiene su propia ventana, así que una planta ocupada no retrasa a otra.
 */
export class CatalogCoalescer {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: (plant: string) => void,
  ) {}

  push(plant: string): void {
    if (this.timers.has(plant)) return;
    const timer = setTimeout(() => {
      this.timers.delete(plant);
      this.onFlush(plant);
    }, this.windowMs);
    timer.unref();
    this.timers.set(plant, timer);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
