import type { TelemetryEvent } from '@campo/shared';
import { TelemetryCoalescer } from './telemetry-coalescer';

const tel = (
  asset: string,
  values: Record<string, number>,
  ts = 0,
  plant = 'demo',
): TelemetryEvent => ({ type: 'telemetry', plant, asset, ts, quality: 'good', values });

describe('TelemetryCoalescer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emite sólo el último valor por activo al cerrar la ventana', () => {
    const out: [string, TelemetryEvent[]][] = [];
    const c = new TelemetryCoalescer(100, (plant, events) => out.push([plant, events]));
    c.push(tel('tk-01', { level: 1 }, 1));
    c.push(tel('tk-01', { level: 2 }, 2));
    c.push(tel('tk-01', { level: 3 }, 3));
    c.push(tel('tk-02', { level: 50 }, 4));
    jest.advanceTimersByTime(99);
    expect(out).toHaveLength(0);
    jest.advanceTimersByTime(1);

    expect(out).toHaveLength(1);
    const [plant, events] = out[0];
    expect(plant).toBe('demo');
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.asset === 'tk-01')).toMatchObject({ ts: 3, values: { level: 3 } });
    expect(events.find((e) => e.asset === 'tk-02')?.values).toEqual({ level: 50 });
  });

  it('conserva el último valor de cada métrica cuando llegan en mensajes distintos', () => {
    const out: TelemetryEvent[][] = [];
    const c = new TelemetryCoalescer(100, (_p, events) => out.push(events));
    c.push(tel('tk-01', { level: 10, temp: 20 }, 1));
    c.push(tel('tk-01', { level: 11 }, 2));
    c.push(tel('tk-01', { temp: 21 }, 3));
    jest.advanceTimersByTime(100);
    expect(out[0]).toHaveLength(1);
    expect(out[0][0]).toMatchObject({ ts: 3, values: { level: 11, temp: 21 } });
  });

  it('separa por planta y abre una ventana nueva tras cada flush', () => {
    const out: [string, TelemetryEvent[]][] = [];
    const c = new TelemetryCoalescer(100, (plant, events) => out.push([plant, events]));
    c.push(tel('tk-01', { level: 1 }, 1, 'a'));
    c.push(tel('tk-01', { level: 2 }, 2, 'b'));
    jest.advanceTimersByTime(100);
    expect(out.map(([p]) => p).sort()).toEqual(['a', 'b']);

    c.push(tel('tk-01', { level: 9 }, 9, 'a'));
    jest.advanceTimersByTime(100);
    expect(out).toHaveLength(3);
    expect(out[2][1][0].values.level).toBe(9);
  });

  it('no emite nada si no hay eventos y dispose descarta lo pendiente', () => {
    const onFlush = jest.fn();
    const c = new TelemetryCoalescer(100, onFlush);
    jest.advanceTimersByTime(500);
    expect(onFlush).not.toHaveBeenCalled();
    c.push(tel('tk-01', { level: 1 }));
    c.dispose();
    jest.advanceTimersByTime(500);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
