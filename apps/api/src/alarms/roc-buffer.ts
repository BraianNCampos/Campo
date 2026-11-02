/**
 * Ventana deslizante para la tasa de cambio (ROC). Guarda (instante, valor) de la última ventana con una
 * separación mínima de window/200 entre muestras (si llega otra más pronto reemplaza a la última), de modo que
 * la memoria por (regla, activo) está acotada (~200 pares) aunque la telemetría llegue a 100 Hz.
 */
export class RocBuffer {
  private ts: number[] = [];
  private vs: number[] = [];
  private head = 0;

  /** Cobertura mínima de la ventana para dar una tasa fiable (fracción de `windowMs`). */
  static readonly MIN_COVERAGE = 0.5;

  /** Añade la muestra y devuelve la tasa (unidades por MINUTO, con signo) o undefined si aún no hay cobertura. */
  push(now: number, value: number, windowMs: number): number | undefined {
    const last = this.ts.length - 1;
    if (last >= this.head && now - this.ts[last] < windowMs / 200) {
      this.ts[last] = now;
      this.vs[last] = value;
    } else {
      this.ts.push(now);
      this.vs.push(value);
    }
    const cutoff = now - windowMs;
    while (this.head < this.ts.length - 1 && this.ts[this.head] < cutoff) this.head++;
    if (this.head > 64 && this.head * 2 > this.ts.length) {
      this.ts = this.ts.slice(this.head);
      this.vs = this.vs.slice(this.head);
      this.head = 0;
    }
    const n = this.ts.length - 1;
    const span = this.ts[n] - this.ts[this.head];
    if (n <= this.head || span < windowMs * RocBuffer.MIN_COVERAGE) return undefined;
    return (this.vs[n] - this.vs[this.head]) / (span / 60_000);
  }

  get size(): number {
    return this.ts.length - this.head;
  }
}
