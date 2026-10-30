import { describe, expect, it } from 'vitest';
import type { AlarmEvent } from '@campo/shared';
import { mulberry32, PlantSimulator } from './simulator';

function run(sim: PlantSimulator, seconds: number, dt = 0.25) {
  const events: AlarmEvent[] = [];
  let last: ReturnType<PlantSimulator['step']> = [];
  for (let t = 0; t < seconds; t += dt) {
    last = sim.step(dt, 1_000_000 + t * 1000);
    for (const m of last) if (m.type === 'alarm') events.push(m);
  }
  return { events, last };
}

describe('PlantSimulator', () => {
  it('es determinista con la misma semilla', () => {
    expect(mulberry32(7)()).toBe(mulberry32(7)());
    const a = run(new PlantSimulator('demo', 1), 30).last;
    const b = run(new PlantSimulator('demo', 1), 30).last;
    expect(a).toEqual(b);
  });

  it('snapshot con los 8 activos de la planta demo con la forma del contrato', () => {
    const snap = new PlantSimulator('demo').snapshot(1000);
    expect(snap.type).toBe('snapshot');
    expect(Object.keys(snap.assets).sort()).toEqual(
      ['pump-01', 'pump-02', 'tk-01', 'tk-02', 'tk-03', 'tk-04', 'valve-01', 'valve-02'],
    );
    expect(snap.assets['tk-01']?.values).toHaveProperty('level');
    expect(snap.assets['tk-01']?.values).toHaveProperty('temp');
    expect(snap.assets['pump-01']?.values).toHaveProperty('rpm');
    expect(snap.assets['pump-01']?.values).toHaveProperty('current');
    expect(snap.assets['valve-01']?.values).toHaveProperty('position');
  });

  it('cada paso emite telemetría de todos los activos', () => {
    const msgs = new PlantSimulator('demo').step(0.25, 5);
    expect(msgs.filter((m) => m.type === 'telemetry')).toHaveLength(8);
  });

  it('genera alarmas level>90 (crítica) y level<10 (advertencia) en los primeros segundos y las limpia con el mismo id', () => {
    const { events } = run(new PlantSimulator('demo', 3), 120);
    const act = events.filter((e) => e.state === 'active');
    expect(act.some((e) => e.ruleId === 'level-high' && e.severity === 'critical' && e.value > 90)).toBe(true);
    expect(act.some((e) => e.ruleId === 'level-low' && e.severity === 'warning' && e.value < 10)).toBe(true);
    const first = act[0]!;
    const cleared = events.find((e) => e.id === first.id && e.state === 'cleared');
    expect(cleared).toBeDefined();
  });

  it('los niveles se mantienen en 0..100 y las alarmas activas no se duplican', () => {
    const sim = new PlantSimulator('demo', 9);
    const open = new Set<string>();
    for (let t = 0; t < 600; t += 0.25) {
      for (const m of sim.step(0.25, t * 1000)) {
        if (m.type === 'telemetry' && m.values.level !== undefined) {
          expect(m.values.level).toBeGreaterThanOrEqual(0);
          expect(m.values.level).toBeLessThanOrEqual(100);
        }
        if (m.type === 'alarm') {
          const key = `${m.asset}:${m.ruleId}`;
          if (m.state === 'active') {
            expect(open.has(key)).toBe(false);
            open.add(key);
          } else open.delete(key);
        }
      }
    }
  });
});

describe('PlantSimulator a ritmo reducido (modo demo)', () => {
  it('con speed 0.2 y niveles iniciales cercanos al límite alarma en pocos segundos y los tanques se mueven despacio', () => {
    const sim = new PlantSimulator('demo', 5, { speed: 0.2, levels: { 'tk-04': 89.5, 'tk-02': 10.5 } });
    const { events } = run(sim, 60);
    expect(events.some((e) => e.state === 'active')).toBe(true);
    const a = new PlantSimulator('demo', 5, { speed: 0.2 });
    const b = new PlantSimulator('demo', 5, { speed: 1 });
    run(a, 10);
    run(b, 10);
    const lvl = (s: PlantSimulator) => (s.snapshot(0).assets['tk-03']?.values.level ?? 0);
    expect(Math.abs(lvl(a) - 60)).toBeLessThan(Math.abs(lvl(b) - 60));
  });
});
