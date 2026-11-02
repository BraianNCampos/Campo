import { describe, expect, it } from 'vitest';
import { DEMO_ASSETS } from './demo-seed';
import { SeedSimulator } from '@/live/seed-simulator';

const sp = (plant: string, id: string, metric: string) =>
  (DEMO_ASSETS[plant]!.find((a) => a.id === id)!.metadata as { setpoints?: Record<string, number> }).setpoints?.[metric];

describe('setpoints sembrados (docs §12.4)', () => {
  it('nivel 60 en tanques, temperatura 20 en clima y presión 6 en pres-01', () => {
    for (const id of ['tk-01', 'tk-02', 'tk-03', 'tk-04']) expect(sp('demo', id, 'level')).toBe(60);
    for (const id of ['tk-a', 'tk-b']) expect(sp('tanques', id, 'level')).toBe(60);
    for (const id of ['clima-01', 'clima-02']) expect(sp('demo', id, 'temp')).toBe(20);
    expect(sp('demo', 'pres-01', 'pressure')).toBe(6);
  });
  it('los simuladores oscilan alrededor del SP: clima y presión pasan la mayor parte del tiempo cerca y hacen excursiones', () => {
    const sim = new SeedSimulator('demo', 3, { skip: (d) => ['tank', 'pump', 'valve'].includes(d.type) });
    const temp: number[] = [];
    const press: number[] = [];
    for (let t = 0; t < 900; t += 0.5) {
      for (const m of sim.step(0.5, t * 1000)) {
        if (m.type !== 'telemetry') continue;
        if (m.asset === 'clima-01') temp.push(m.values.temp!);
        if (m.asset === 'pres-01') press.push(m.values.pressure!);
      }
    }
    const near = (xs: number[], c: number, tol: number) => xs.filter((x) => Math.abs(x - c) <= tol).length / xs.length;
    expect(near(temp, 20, 4)).toBeGreaterThan(0.5);
    expect(Math.max(...temp)).toBeGreaterThan(29); // llega al 90 % del tramo SP→límite
    expect(near(press, 6, 1)).toBeGreaterThan(0.5);
    expect(Math.max(...press)).toBeGreaterThan(8);
  });
});
