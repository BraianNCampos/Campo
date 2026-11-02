import type { TelemetryEvent } from '@campo/shared';
import { AlarmEvaluator } from './alarm-evaluator';
import type { AlarmRule } from './alarm.types';

/**
 * Prueba de carga ligera del evaluador (ruta caliente de la telemetría). El motor sólo hace trabajo síncrono
 * y en memoria por muestra; las transiciones (E/S) van a una cola aparte. Se mide con 5 000 muestras/s
 * sintéticas durante 20 s simulados (100 000 muestras) sobre 50 activos y los seis tipos de regla.
 */
const base = {
  plant: 'demo',
  forSeconds: 0,
  hysteresis: 1,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};
const rules: AlarmRule[] = [
  {
    ...base,
    id: 'hh',
    asset: 'tk-*',
    metric: 'level',
    operator: 'gt',
    threshold: 90,
    severity: 'critical',
  },
  {
    ...base,
    id: 'lo',
    asset: 'tk-*',
    metric: 'level',
    operator: 'lt',
    threshold: 10,
    severity: 'warning',
  },
  {
    ...base,
    id: 'dev',
    asset: 'tk-*',
    metric: 'level',
    operator: 'gt',
    threshold: 25,
    severity: 'warning',
    kind: 'DEV',
  },
  {
    ...base,
    id: 'roc',
    asset: 'tk-*',
    metric: 'level',
    operator: 'gt',
    threshold: 8,
    severity: 'warning',
    kind: 'ROC',
    rocWindowSeconds: 60,
  },
  {
    ...base,
    id: 'sup',
    asset: 'tk-*',
    metric: 'temp',
    operator: 'gt',
    threshold: 35,
    severity: 'warning',
    suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 },
  },
];

describe('carga del evaluador', () => {
  it('5 000 muestras/s: coste por muestra y memoria acotada', () => {
    const e = new AlarmEvaluator();
    e.setRules(rules, 0);
    e.setSetpoints(
      'demo',
      new Map(Array.from({ length: 50 }, (_, i) => [`tk-${i}`, { level: 50 }])),
    );
    const assets = Array.from({ length: 50 }, (_, i) => `tk-${i}`);
    const ev: TelemetryEvent = {
      type: 'telemetry',
      plant: 'demo',
      asset: 'tk-0',
      ts: 0,
      quality: 'good',
      values: { level: 50, temp: 20 },
    };

    const N = 100_000;
    const start = process.hrtime.bigint();
    let transitions = 0;
    for (let i = 0; i < N; i++) {
      const now = Math.floor(i / 5); // 5 muestras por ms = 5 000/s
      ev.asset = assets[i % 50];
      // senoide lenta con picos ocasionales: algunas alarmas se activan y se normalizan
      ev.values = {
        level: 50 + 45 * Math.sin(i / 8000 + (i % 50)),
        temp: 20 + (i % 997 === 0 ? 30 : 0),
      };
      transitions += e.evaluate(ev, now).length;
    }
    const perSampleUs = Number(process.hrtime.bigint() - start) / 1000 / N;

    console.log(
      `evaluador: ${perSampleUs.toFixed(2)} µs/muestra, ${transitions} transiciones en ${N} muestras`,
    );
    expect(perSampleUs).toBeLessThan(100); // 5 000 muestras/s = 200 µs de presupuesto: usa < 50 %
    const internals = e as unknown as { trackCount: number };
    expect(internals.trackCount).toBeLessThanOrEqual(5 * 50); // una pista por (regla, activo) como mucho
  });

  it('la memoria no crece con 100 000 muestras más (activos y valores repetidos)', () => {
    const e = new AlarmEvaluator();
    e.setRules(rules, 0);
    e.setSetpoints('demo', new Map([['tk-0', { level: 50 }]]));
    const ev: TelemetryEvent = {
      type: 'telemetry',
      plant: 'demo',
      asset: 'tk-0',
      ts: 0,
      quality: 'good',
      values: { level: 50 },
    };
    const feed = (from: number, n: number) => {
      for (let i = from; i < from + n; i++) {
        ev.values = { level: 50 + (i % 7) };
        e.evaluate(ev, i * 10);
      }
    };
    feed(0, 50_000);
    const tracks = (e as unknown as { trackCount: number }).trackCount;
    feed(50_000, 100_000);
    expect((e as unknown as { trackCount: number }).trackCount).toBe(tracks);
  });
});
