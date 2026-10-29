import type { TelemetryEvent } from '@campo/shared';
import { AlarmEvaluator, clears, compileAssetPattern, trips } from './alarm-evaluator';
import type { AlarmRule } from './alarm.types';

const rule = (over: Partial<AlarmRule> = {}): AlarmRule => ({
  id: 'r1',
  plant: 'demo',
  asset: 'tk-*',
  metric: 'level',
  operator: 'gt',
  threshold: 90,
  severity: 'critical',
  forSeconds: 0,
  hysteresis: 0,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ev = (
  value: number,
  over: Partial<TelemetryEvent> = {},
  metric = 'level',
): TelemetryEvent => ({
  type: 'telemetry',
  plant: 'demo',
  asset: 'tk-01',
  ts: 0,
  quality: 'good',
  values: { [metric]: value },
  ...over,
});

describe('AlarmEvaluator', () => {
  describe('operadores', () => {
    it.each([
      ['gt', 90, 91, true],
      ['gt', 90, 90, false],
      ['gte', 90, 90, true],
      ['lt', 10, 9, true],
      ['lt', 10, 10, false],
      ['lte', 10, 10, true],
    ] as const)('trips %s thr=%d v=%d -> %s', (operator, threshold, v, expected) => {
      expect(trips({ operator, threshold }, v)).toBe(expected);
    });

    it('con histéresis 0 clears es la negación de trips', () => {
      for (const operator of ['gt', 'gte', 'lt', 'lte'] as const) {
        for (const v of [8, 9, 10, 11, 12]) {
          const r = { operator, threshold: 10, hysteresis: 0 };
          expect(clears(r, v)).toBe(!trips(r, v));
        }
      }
    });
  });

  it('activa de inmediato con forSeconds=0 y publica los campos del contrato', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    const out = e.evaluate(ev(95), 1000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'alarm',
      ruleId: 'r1',
      plant: 'demo',
      asset: 'tk-01',
      metric: 'level',
      severity: 'critical',
      state: 'active',
      value: 95,
      threshold: 90,
      ts: 1000,
      acknowledged: false,
    });
    expect(out[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out[0].message).toContain('tk-01');
  });

  it('no repite la alarma mientras sigue activa', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    expect(e.evaluate(ev(95), 1000)).toHaveLength(1);
    expect(e.evaluate(ev(96), 2000)).toHaveLength(0);
    expect(e.activeAlarms()).toHaveLength(1);
  });

  describe('debounce (forSeconds)', () => {
    it('activa sólo cuando la condición se sostiene el tiempo requerido', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ forSeconds: 5 })], 0);
      expect(e.evaluate(ev(95), 0)).toHaveLength(0);
      expect(e.evaluate(ev(95), 4999)).toHaveLength(0);
      const out = e.evaluate(ev(95), 5000);
      expect(out).toHaveLength(1);
      expect(out[0].state).toBe('active');
    });

    it('un valor normal intermedio reinicia el temporizador', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ forSeconds: 5 })], 0);
      e.evaluate(ev(95), 0);
      e.evaluate(ev(50), 3000); // glitch normal -> reinicia
      expect(e.evaluate(ev(95), 4000)).toHaveLength(0);
      expect(e.evaluate(ev(95), 8999)).toHaveLength(0);
      expect(e.evaluate(ev(95), 9000)).toHaveLength(1);
    });

    it('lleva el debounce por activo de forma independiente', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ forSeconds: 5 })], 0);
      e.evaluate(ev(95, { asset: 'tk-01' }), 0);
      e.evaluate(ev(95, { asset: 'tk-02' }), 3000);
      const out = e.evaluate(ev(95, { asset: 'tk-01' }), 5000);
      expect(out.map((a) => a.asset)).toEqual(['tk-01']);
    });
  });

  describe('histéresis', () => {
    it('gt: no limpia dentro de la banda muerta y limpia al cruzar threshold - h', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ hysteresis: 5 })], 0);
      e.evaluate(ev(95), 0);
      expect(e.evaluate(ev(89), 1000)).toHaveLength(0); // bajó del umbral pero dentro de banda
      expect(e.evaluate(ev(85.1), 2000)).toHaveLength(0);
      const out = e.evaluate(ev(85), 3000); // <= 90 - 5
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ state: 'cleared', value: 85, ts: 3000 });
    });

    it('lt: limpia al subir a threshold + h', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ operator: 'lt', threshold: 10, hysteresis: 2, severity: 'warning' })], 0);
      expect(e.evaluate(ev(5), 0)).toHaveLength(1);
      expect(e.evaluate(ev(11), 1000)).toHaveLength(0);
      expect(e.evaluate(ev(12), 2000)[0].state).toBe('cleared');
    });

    it('una vez limpia puede volver a activarse con un id nuevo', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ hysteresis: 1 })], 0);
      const first = e.evaluate(ev(95), 0)[0];
      e.evaluate(ev(80), 1000);
      const second = e.evaluate(ev(95), 2000)[0];
      expect(second.state).toBe('active');
      expect(second.id).not.toBe(first.id);
    });

    it('el evento cleared conserva el id de la alarma activa', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule()], 0);
      const active = e.evaluate(ev(95), 0)[0];
      const cleared = e.evaluate(ev(50), 1000)[0];
      expect(cleared.id).toBe(active.id);
      expect(cleared.state).toBe('cleared');
    });
  });

  describe('filtrado', () => {
    it('respeta planta, patrón de activo y métrica', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule()], 0);
      expect(e.evaluate(ev(95, { plant: 'otra' }), 0)).toHaveLength(0);
      expect(e.evaluate(ev(95, { asset: 'pump-01' }), 0)).toHaveLength(0);
      expect(e.evaluate(ev(95, {}, 'temp'), 0)).toHaveLength(0);
      expect(e.evaluate(ev(95, { asset: 'tk-02' }), 0)).toHaveLength(1);
    });

    it('ignora reglas deshabilitadas', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule({ enabled: false })], 0);
      expect(e.evaluate(ev(95), 0)).toHaveLength(0);
    });

    it('ignora datos de calidad bad y valores no finitos', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule()], 0);
      expect(e.evaluate(ev(95, { quality: 'bad' }), 0)).toHaveLength(0);
      expect(e.evaluate(ev(Number.NaN), 0)).toHaveLength(0);
    });

    it('un dato bad no limpia una alarma activa', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule()], 0);
      e.evaluate(ev(95), 0);
      expect(e.evaluate(ev(10, { quality: 'bad' }), 1000)).toHaveLength(0);
      expect(e.activeAlarms()).toHaveLength(1);
    });

    it('compileAssetPattern escapa metacaracteres y soporta *', () => {
      expect(compileAssetPattern('tk-*').test('tk-01')).toBe(true);
      expect(compileAssetPattern('tk-*').test('xtk-01')).toBe(false);
      expect(compileAssetPattern('*').test('cualquiera')).toBe(true);
      expect(compileAssetPattern('tk-01').test('tk-010')).toBe(false);
      expect(compileAssetPattern('a.b').test('axb')).toBe(false);
    });

    it('varias reglas sobre la misma métrica generan alarmas independientes', () => {
      const e = new AlarmEvaluator();
      e.setRules(
        [
          rule({ id: 'warn', threshold: 80, severity: 'warning' }),
          rule({ id: 'crit', threshold: 90, severity: 'critical' }),
        ],
        0,
      );
      const out = e.evaluate(ev(95), 0);
      expect(out.map((a) => a.severity).sort()).toEqual(['critical', 'warning']);
    });
  });

  describe('cambios de reglas y restauración', () => {
    it('cierra alarmas cuyas reglas se eliminan o deshabilitan', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule()], 0);
      const active = e.evaluate(ev(95), 0)[0];
      const closed = e.setRules([rule({ enabled: false })], 5000);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({ id: active.id, state: 'cleared', ts: 5000 });
      expect(e.activeAlarms()).toHaveLength(0);
    });

    it('mantiene las alarmas activas si la regla sigue existiendo (aunque cambie el umbral)', () => {
      const e = new AlarmEvaluator();
      e.setRules([rule()], 0);
      e.evaluate(ev(95), 0);
      expect(e.setRules([rule({ threshold: 92 })], 1000)).toHaveLength(0);
      expect(e.activeAlarms()).toHaveLength(1);
    });

    it('restore evita duplicar una alarma ya activa tras un reinicio', () => {
      const first = new AlarmEvaluator();
      first.setRules([rule()], 0);
      const active = first.evaluate(ev(95), 0)[0];

      const second = new AlarmEvaluator();
      second.setRules([rule()], 0);
      expect(second.restore([active], 10)).toHaveLength(0);
      expect(second.evaluate(ev(96), 20)).toHaveLength(0);
      expect(second.evaluate(ev(50), 30)[0]).toMatchObject({ id: active.id, state: 'cleared' });
    });

    it('restore devuelve como huérfanas las alarmas sin regla', () => {
      const e = new AlarmEvaluator();
      e.setRules([], 0);
      const orphan = new AlarmEvaluator();
      orphan.setRules([rule()], 0);
      const a = orphan.evaluate(ev(95), 0)[0];
      expect(e.restore([a], 10)[0]).toMatchObject({ id: a.id, state: 'cleared' });
    });
  });
});
