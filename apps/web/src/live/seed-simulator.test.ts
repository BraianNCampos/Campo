import { describe, expect, it } from 'vitest';
import type { AlarmEvent, ServerMessage } from '@campo/shared';
import { DEMO_ASSETS } from '@/lib/demo-seed';
import { bump, SeedSimulator } from './seed-simulator';

const isCore = (d: { type: string }) => ['tank', 'pump', 'valve'].includes(d.type);

function run(sim: SeedSimulator, seconds: number, dt = 0.5) {
  const msgs: ServerMessage[] = [];
  for (let t = 0; t < seconds; t += dt) msgs.push(...sim.step(dt, 1_000_000 + t * 1000));
  return msgs;
}
const telemetry = (msgs: ServerMessage[], asset: string) => msgs.flatMap((m) => (m.type === 'telemetry' && m.asset === asset ? [m.values] : []));

describe('SeedSimulator (clientes demo)', () => {
  it('genera telemetría para TODOS los activos sembrados de demo (salvo los que mueve PlantSimulator) con las métricas de su tipo', () => {
    const sim = new SeedSimulator('demo', 1, { skip: (d) => isCore(d) });
    const snap = sim.snapshot(1).assets;
    const expected = DEMO_ASSETS.demo!.filter((d) => !isCore(d));
    expect(Object.keys(snap).sort()).toEqual(expected.map((d) => d.id).sort());
    const need: Record<string, string[]> = { climate: ['temp', 'humidity'], energy: ['kw', 'kwh', 'pf'], gas: ['flow', 'total'], machine: ['state'], pressure: ['pressure'], flow: ['flow'] };
    for (const d of expected) for (const m of need[d.type]!) expect(snap[d.id]?.values[m], `${d.id}.${m}`).toBeTypeOf('number');
  });
  it('la planta tanques simula sus dos tanques completos', () => {
    const snap = new SeedSimulator('tanques', 1).snapshot(1).assets;
    expect(Object.keys(snap).sort()).toEqual(['tk-a', 'tk-b']);
    expect(snap['tk-a']?.values).toHaveProperty('level');
  });
  it('los contadores (kWh, m³) son monótonos y avanzan', () => {
    const msgs = run(new SeedSimulator('demo', 2, { skip: isCore }), 120);
    for (const [asset, metric] of [['en-linea1', 'kwh'], ['gas-01', 'total']] as const) {
      const v = telemetry(msgs, asset).map((x) => x[metric]!);
      expect(v.every((x, i) => i === 0 || x >= v[i - 1]!)).toBe(true);
      expect(v.at(-1)!).toBeGreaterThan(v[0]!);
    }
  });
  it('las máquinas cambian de estado de vez en cuando (0/1)', () => {
    const msgs = run(new SeedSimulator('demo', 3, { skip: isCore }), 600);
    const states = telemetry(msgs, 'maq-01').map((x) => x.state!);
    expect(states.every((s) => s === 0 || s === 1)).toBe(true);
    expect(new Set(states).size).toBe(2);
  });
  it('la presión tiene alguna excursión por encima de 8 y la potencia se acerca a la contratada', () => {
    const msgs = run(new SeedSimulator('demo', 4, { skip: isCore }), 400);
    expect(Math.max(...telemetry(msgs, 'pres-01').map((x) => x.pressure!))).toBeGreaterThan(8);
    const kw = telemetry(msgs, 'en-compresores').map((x) => x.kw!);
    expect(Math.max(...kw)).toBeGreaterThan(117); // límite de advertencia (90 % de 130)
    expect(Math.min(...kw)).toBeLessThan(100);
  });
  it('temperatura y humedad varían con ciclos suaves (sin saltos bruscos)', () => {
    const t = telemetry(run(new SeedSimulator('demo', 5, { skip: isCore }), 300), 'clima-02').map((x) => x.temp!);
    for (let i = 1; i < t.length; i++) expect(Math.abs(t[i]! - t[i - 1]!)).toBeLessThan(1);
    expect(Math.max(...t) - Math.min(...t)).toBeGreaterThan(2);
  });
  it('emite y limpia alarmas según DEMO_LIMITS, sin duplicados activos', () => {
    const msgs = run(new SeedSimulator('demo', 6, { skip: isCore }), 600);
    const alarms = msgs.filter((m): m is AlarmEvent => m.type === 'alarm');
    expect(alarms.some((a) => a.state === 'active' && a.asset === 'pres-01' && a.severity === 'critical' && a.value > 8)).toBe(true);
    expect(alarms.some((a) => a.state === 'cleared')).toBe(true);
    const open = new Set<string>();
    for (const a of alarms) {
      if (a.state === 'active') {
        expect(open.has(a.ruleId)).toBe(false);
        open.add(a.ruleId);
      } else open.delete(a.ruleId);
    }
  });
  it('tanques de la planta tanques cruzan los límites en cada extremo', () => {
    const alarms = run(new SeedSimulator('tanques', 7), 120).filter((m): m is AlarmEvent => m.type === 'alarm' && m.state === 'active');
    expect(alarms.some((a) => a.asset === 'tk-a' && a.ruleId.includes('gt'))).toBe(true);
    expect(alarms.some((a) => a.asset === 'tk-b' && a.ruleId.includes('lt'))).toBe(true);
  });
  it('es determinista con la misma semilla', () => {
    const a = run(new SeedSimulator('demo', 9, { skip: isCore }), 60);
    const b = run(new SeedSimulator('demo', 9, { skip: isCore }), 60);
    expect(a).toEqual(b);
  });
  it('bump: 0 antes del inicio, sube, se sostiene, baja y se repite', () => {
    const b = { start: 10, period: 100, rise: 10, hold: 10, fall: 10 };
    expect([bump(5, b), bump(15, b), bump(25, b), bump(35, b), bump(60, b), bump(115, b)]).toEqual([0, 0.5, 1, 0.5, 0, 0.5]);
  });
});
