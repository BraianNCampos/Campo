import type { TelemetryEvent } from '@campo/shared';
import { AlarmEvaluator, suppressHolds } from './alarm-evaluator';
import {
  AlarmRule,
  SuppressWhen,
  clearedLifecycle,
  deriveKind,
  kindOperatorError,
  lifecycleOf,
  matchesListState,
  resolveRule,
} from './alarm.types';
import { RocBuffer } from './roc-buffer';

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
  values: Record<string, number>,
  over: Partial<TelemetryEvent> = {},
): TelemetryEvent => ({
  type: 'telemetry',
  plant: 'demo',
  asset: 'tk-01',
  ts: 0,
  quality: 'good',
  values,
  ...over,
});
const lvl = (v: number, over: Partial<TelemetryEvent> = {}) => ev({ level: v }, over);

const S = 1000; // segundos -> ms

describe('kind: derivación y coherencia con el operador', () => {
  it.each([
    ['gt', 'critical', 'HH'],
    ['gte', 'critical', 'HH'],
    ['gt', 'warning', 'HI'],
    ['gte', 'warning', 'HI'],
    ['lt', 'critical', 'LL'],
    ['lte', 'critical', 'LL'],
    ['lt', 'warning', 'LO'],
    ['lte', 'warning', 'LO'],
  ] as const)('%s + %s -> %s', (operator, severity, kind) => {
    expect(deriveKind(operator, severity)).toBe(kind);
    expect(resolveRule(rule({ operator, severity })).kind).toBe(kind);
  });

  it.each([
    ['HH', 'gt', true],
    ['HH', 'gte', true],
    ['HH', 'lt', false],
    ['HI', 'lte', false],
    ['LO', 'lt', true],
    ['LL', 'lte', true],
    ['LL', 'gt', false],
    ['DEV', 'gt', true],
    ['DEV', 'gte', true],
    ['DEV', 'lt', false],
    ['ROC', 'gte', true],
    ['ROC', 'lte', false],
  ] as const)('%s con %s -> %s', (kind, operator, ok) => {
    expect(kindOperatorError(kind, operator) === null).toBe(ok);
  });

  it('resolveRule rellena los valores por defecto sin tocar lo que ya viene', () => {
    expect(resolveRule(rule())).toMatchObject({
      kind: 'HH',
      rocWindowSeconds: 60,
      rocDirection: 'any',
      offDelaySeconds: 0,
      suppressWhen: null,
      description: null,
      outOfServiceReason: null,
    });
    expect(resolveRule(rule({ kind: 'DEV', rocWindowSeconds: 30 }))).toMatchObject({
      kind: 'DEV',
      rocWindowSeconds: 30,
    });
  });
});

describe('ciclo de vida: tabla de §12.2', () => {
  it.each([
    [{ state: 'active', acknowledged: false }, 'unacked'],
    [{ state: 'active', acknowledged: true }, 'acked'],
    [{ state: 'cleared', acknowledged: false }, 'rtn_unacked'],
    [{ state: 'cleared', acknowledged: true }, 'closed'],
    [{ state: 'active', acknowledged: false, lifecycle: 'shelved' }, 'shelved'],
  ] as const)('lifecycleOf %j -> %s', (a, lc) => {
    expect(lifecycleOf(a)).toBe(lc);
  });

  it.each([
    [{ state: 'active', acknowledged: false, lifecycle: 'unacked' }, 'rtn_unacked'],
    [{ state: 'active', acknowledged: true, lifecycle: 'acked' }, 'closed'],
    [{ state: 'active', acknowledged: false, lifecycle: 'shelved' }, 'closed'],
  ] as const)('al normalizarse %j -> %s', (a, lc) => {
    expect(clearedLifecycle(a)).toBe(lc);
  });

  it('?state=active = unacked|acked|rtn_unacked; cleared = closed; shelved = shelved', () => {
    const all = ['unacked', 'acked', 'rtn_unacked', 'closed', 'shelved'] as const;
    const pick = (s: 'active' | 'cleared' | 'shelved') =>
      all.filter((lc) => matchesListState(lc, s));
    expect(pick('active')).toEqual(['unacked', 'acked', 'rtn_unacked']);
    expect(pick('cleared')).toEqual(['closed']);
    expect(pick('shelved')).toEqual(['shelved']);
  });
});

describe('HH/HI/LO/LL: banda muerta y retardos', () => {
  it.each([
    // operator, umbral, histéresis, valor, ¿limpia?
    ['gt', 90, 5, 85, true], // <= t-h
    ['gt', 90, 5, 85.01, false],
    ['gte', 90, 5, 85, false], // < t-h
    ['gte', 90, 5, 84.99, true],
    ['lt', 10, 2, 12, true], // >= t+h
    ['lt', 10, 2, 11.99, false],
    ['lte', 10, 2, 12, false], // > t+h
    ['lte', 10, 2, 12.01, true],
  ] as const)('%s thr=%d h=%d v=%d -> limpia=%s', (operator, threshold, hysteresis, v, cleared) => {
    const e = new AlarmEvaluator();
    const trip = operator.startsWith('g') ? threshold + 1 : threshold - 1;
    e.setRules([rule({ operator, threshold, hysteresis, severity: 'warning' })], 0);
    expect(e.evaluate(lvl(trip), 0)).toHaveLength(1);
    expect(e.evaluate(lvl(v), 1000).length === 1).toBe(cleared);
  });

  it('retardo de activación: la condición debe sostenerse; si se corta, se reinicia', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule({ forSeconds: 10 })], 0);
    expect(e.evaluate(lvl(95), 0)).toHaveLength(0);
    expect(e.evaluate(lvl(95), 9 * S)).toHaveLength(0);
    expect(e.evaluate(lvl(80), 9.5 * S)).toHaveLength(0); // se corta
    expect(e.evaluate(lvl(95), 10 * S)).toHaveLength(0); // vuelve a empezar
    expect(e.evaluate(lvl(95), 19 * S)).toHaveLength(0);
    expect(e.evaluate(lvl(95), 20 * S)).toHaveLength(1);
  });

  it('retardo de retorno: la alarma sólo se normaliza tras offDelaySeconds sin condición', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule({ offDelaySeconds: 5 })], 0);
    expect(e.evaluate(lvl(95), 0)).toHaveLength(1);
    expect(e.evaluate(lvl(80), 10 * S)).toHaveLength(0); // empieza el retardo
    expect(e.evaluate(lvl(80), 14.9 * S)).toHaveLength(0);
    expect(e.evaluate(lvl(95), 15 * S)).toHaveLength(0); // reincide: el retardo se reinicia
    expect(e.evaluate(lvl(80), 16 * S)).toHaveLength(0);
    expect(e.evaluate(lvl(80), 20.9 * S)).toHaveLength(0);
    const out = e.evaluate(lvl(80), 21 * S);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ state: 'cleared', lifecycle: 'rtn_unacked', ts: 21 * S });
  });

  it('con offDelay > 0 un valor dentro de la banda muerta tampoco cuenta como normalizado', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule({ offDelaySeconds: 5, hysteresis: 5 })], 0);
    e.evaluate(lvl(95), 0);
    e.evaluate(lvl(80), 1 * S); // limpia: empieza el retardo
    e.evaluate(lvl(88), 3 * S); // banda muerta: reinicia
    expect(e.evaluate(lvl(80), 7 * S)).toHaveLength(0);
    expect(e.evaluate(lvl(80), 12 * S)).toHaveLength(1);
  });

  it('el evento lleva kind, lifecycle y racionalización', () => {
    const e = new AlarmEvaluator();
    e.setRules(
      [rule({ description: 'Nivel muy alto', consequence: 'Rebalse', response: 'Cerrar válvula' })],
      0,
    );
    const [a] = e.evaluate(lvl(95), 0);
    expect(a).toMatchObject({
      kind: 'HH',
      lifecycle: 'unacked',
      rationale: {
        description: 'Nivel muy alto',
        consequence: 'Rebalse',
        response: 'Cerrar válvula',
      },
    });
  });

  it('sin racionalización no se publica el campo', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    expect(e.evaluate(lvl(95), 0)[0]).not.toHaveProperty('rationale');
  });
});

describe('DEV: desviación respecto del setpoint', () => {
  const dev = (over: Partial<AlarmRule> = {}) =>
    rule({ kind: 'DEV', threshold: 25, severity: 'warning', hysteresis: 2, ...over });
  const withSp = (sp: number | null) => {
    const e = new AlarmEvaluator();
    e.setRules([dev()], 0);
    if (sp !== null) e.setSetpoints('demo', new Map([['tk-01', { level: sp }]]));
    return e;
  };

  it.each([
    [85, false], // |85-60| = 25, no > 25
    [85.01, true],
    [35, false],
    [34.9, true],
    [60, false],
  ])('SP 60 (metadata), valor %d -> alarma=%s', (v, tripped) => {
    expect(withSp(60).evaluate(lvl(v), 0).length === 1).toBe(tripped);
  });

  it('la alarma lleva la desviación como valor y el kind DEV', () => {
    const [a] = withSp(60).evaluate(lvl(90), 0);
    expect(a).toMatchObject({ kind: 'DEV', value: 30, threshold: 25 });
    expect(a.message).toContain('SP 60');
  });

  it('el SP de la telemetría (<métrica>_sp) manda sobre el de metadata', () => {
    const e = withSp(60);
    // con SP 60 el valor 70 no dispara; con SP 40 (telemetría) la desviación es 30 -> sí
    expect(e.evaluate(ev({ level: 70 }), 0)).toHaveLength(0);
    expect(e.evaluate(ev({ level: 70, level_sp: 40 }), 1000)).toHaveLength(1);
  });

  it('recuerda el último SP de la telemetría cuando una muestra no lo trae', () => {
    const e = withSp(null);
    expect(e.evaluate(ev({ level: 70 }), 0)).toHaveLength(0); // sin SP: no se evalúa
    e.evaluate(ev({ level: 41, level_sp: 40 }), 1000);
    expect(e.evaluate(ev({ level: 70 }), 2000)).toHaveLength(1);
    expect(e.liveSetpoint('r1', 'tk-01')).toBe(40);
  });

  it('sin SP la regla no se evalúa (ni crea ni limpia alarmas)', () => {
    const e = withSp(null);
    for (const v of [0, 60, 100, 1000]) expect(e.evaluate(lvl(v), 0)).toEqual([]);
  });

  it('SP no finito en la telemetría se ignora', () => {
    const e = withSp(60);
    expect(e.evaluate(ev({ level: 70, level_sp: Number.NaN }), 0)).toHaveLength(0);
    expect(e.evaluate(ev({ level: 100, level_sp: Number.NaN }), 0)).toHaveLength(1);
  });

  it('vuelve a normal con banda muerta sobre la desviación', () => {
    const e = withSp(60);
    expect(e.evaluate(lvl(90), 0)).toHaveLength(1);
    expect(e.evaluate(lvl(84), 1000)).toHaveLength(0); // desv 24 > 25-2
    const out = e.evaluate(lvl(82), 2000); // desv 22 <= 23
    expect(out[0]).toMatchObject({ state: 'cleared', kind: 'DEV' });
  });

  it('también dispara por debajo del SP (magnitud absoluta)', () => {
    expect(withSp(60).evaluate(lvl(30), 0)[0]).toMatchObject({ value: 30 });
  });
});

describe('ROC: tasa de cambio con ventana deslizante', () => {
  const roc = (over: Partial<AlarmRule> = {}) =>
    rule({ kind: 'ROC', threshold: 8, severity: 'warning', rocWindowSeconds: 60, ...over });
  /** Alimenta una rampa de `perMin` unidades/min desde `start`, una muestra cada `step` s hasta `until` s. */
  function ramp(e: AlarmEvaluator, perMin: number, step: number, until: number, start = 50) {
    const out: ReturnType<AlarmEvaluator['evaluate']> = [];
    for (let t = 0; t <= until; t += step) {
      out.push(...e.evaluate(lvl(start + (perMin * t) / 60), t * S));
    }
    return out;
  }

  it('no dispara antes de cubrir la mitad de la ventana y sí al cubrirla', () => {
    const early = new AlarmEvaluator();
    early.setRules([roc()], 0);
    expect(ramp(early, 12, 5, 25)).toEqual([]); // 25 s < 50 % de la ventana de 60 s
    const e = new AlarmEvaluator();
    e.setRules([roc()], 0);
    const out = ramp(e, 12, 5, 30);
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(30 * S);
  });

  it('12/min con umbral 8/min: alarma con la tasa como valor', () => {
    const e = new AlarmEvaluator();
    e.setRules([roc()], 0);
    const out = ramp(e, 12, 10, 60);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'ROC', threshold: 8, state: 'active' });
    expect(out[0].value).toBeCloseTo(12, 5);
  });

  it('6/min con umbral 8/min: nunca', () => {
    const e = new AlarmEvaluator();
    e.setRules([roc()], 0);
    expect(ramp(e, 6, 10, 300)).toEqual([]);
  });

  it.each([
    ['any', 12, true],
    ['any', -12, true],
    ['rise', 12, true],
    ['rise', -12, false],
    ['fall', -12, true],
    ['fall', 12, false],
  ] as const)('dirección %s con %d/min -> alarma=%s', (rocDirection, perMin, fires) => {
    const e = new AlarmEvaluator();
    e.setRules([roc({ rocDirection })], 0);
    expect(ramp(e, perMin, 10, 90, 50).length > 0).toBe(fires);
  });

  it('se normaliza cuando la tasa baja (la ventana se desliza)', () => {
    const e = new AlarmEvaluator();
    e.setRules([roc()], 0);
    ramp(e, 12, 10, 60);
    // se estabiliza en 62: pasados 60 s la tasa de la ventana vuelve a ~0
    let cleared = false;
    for (let t = 70; t <= 150; t += 10) {
      if (e.evaluate(lvl(62), t * S).some((x) => x.state === 'cleared')) cleared = true;
    }
    expect(cleared).toBe(true);
  });

  it('un hueco de datos mayor que la ventana reinicia el cálculo', () => {
    const e = new AlarmEvaluator();
    e.setRules([roc()], 0);
    e.evaluate(lvl(0), 0);
    expect(e.evaluate(lvl(500), 600 * S)).toEqual([]); // un salto tras 10 min sin datos no es una tasa
  });

  it('el buffer está acotado aunque lleguen muchas muestras', () => {
    const b = new RocBuffer();
    for (let i = 0; i < 100_000; i++) b.push(i * 10, i, 60_000);
    expect(b.size).toBeLessThan(400);
  });

  it('la ventana configurable cambia la sensibilidad', () => {
    const slow = new AlarmEvaluator();
    slow.setRules([roc({ rocWindowSeconds: 600, threshold: 8 })], 0);
    // 12/min sostenido durante menos de 5 min no cubre el 50 % de una ventana de 10 min
    expect(ramp(slow, 12, 10, 290)).toEqual([]);
    const fast = new AlarmEvaluator();
    fast.setRules([roc({ rocWindowSeconds: 600 })], 0);
    expect(ramp(fast, 12, 10, 300)).toHaveLength(1);
  });
});

describe('supresión por estado', () => {
  const sup: SuppressWhen = { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 };
  const pump = (rpm: number) => ev({ rpm }, { asset: 'pump-01' });
  const make = (s: SuppressWhen | null = sup, over: Partial<AlarmRule> = {}) => {
    const e = new AlarmEvaluator();
    e.setRules([rule({ suppressWhen: s, ...over })], 0);
    return e;
  };

  it.each([
    ['eq', 5, 5, true],
    ['eq', 5, 6, false],
    ['neq', 5, 6, true],
    ['neq', 5, 5, false],
    ['gt', 5, 5.01, true],
    ['gt', 5, 5, false],
    ['lt', 5, 4.99, true],
    ['lt', 5, 5, false],
  ] as const)('%s %d con dato %d -> %s', (operator, value, v, expected) => {
    expect(suppressHolds({ operator, value }, v)).toBe(expected);
  });

  it('sin dato (o dato no finito) no se suprime', () => {
    expect(suppressHolds({ operator: 'lt', value: 1 }, undefined)).toBe(false);
    expect(suppressHolds({ operator: 'neq', value: 1 }, Number.NaN)).toBe(false);
  });

  it('con la bomba parada no se genera la alarma y se cuenta una sola vez por episodio', () => {
    const e = make();
    e.evaluate(pump(0), 0);
    expect(e.evaluate(lvl(95), 1000)).toEqual([]);
    expect(e.evaluate(lvl(96), 2000)).toEqual([]);
    const s = e.takeSuppressions();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      plant: 'demo',
      ruleId: 'r1',
      asset: 'tk-01',
      metric: 'level',
      value: 95,
    });
    expect(e.takeSuppressions()).toEqual([]);
  });

  it('al arrancar la bomba la alarma se genera si la condición persiste', () => {
    const e = make();
    e.evaluate(pump(0), 0);
    e.evaluate(lvl(95), 1000);
    e.evaluate(pump(1450), 2000);
    expect(e.evaluate(lvl(95), 3000)).toHaveLength(1);
  });

  it('un nuevo episodio de supresión se cuenta de nuevo', () => {
    const e = make();
    e.evaluate(pump(0), 0);
    e.evaluate(lvl(95), 1000);
    e.evaluate(lvl(50), 2000); // la condición cesa: fin del episodio
    e.evaluate(lvl(95), 3000);
    expect(e.takeSuppressions()).toHaveLength(2);
  });

  it('sin ningún dato del activo referenciado no se suprime (falla a favor de alarmar)', () => {
    expect(make().evaluate(lvl(95), 0)).toHaveLength(1);
  });

  it('seedState (Redis al arrancar) sirve como último dato', () => {
    const e = make();
    e.seedState('demo', 'pump-01', { rpm: 0 });
    expect(e.evaluate(lvl(95), 0)).toEqual([]);
  });

  it('una alarma ya activa no se ve afectada por una supresión posterior', () => {
    const e = make();
    expect(e.evaluate(lvl(95), 0)).toHaveLength(1);
    e.evaluate(pump(0), 1000);
    expect(e.evaluate(lvl(96), 2000)).toEqual([]);
    expect(e.evaluate(lvl(10), 3000)[0]).toMatchObject({ state: 'cleared' });
  });

  it('con patrón basta con que un activo coincidente cumpla la condición', () => {
    const e = make({ asset: 'pump-*', metric: 'rpm', operator: 'lt', value: 1 });
    e.evaluate(ev({ rpm: 1500 }, { asset: 'pump-01' }), 0);
    expect(e.evaluate(lvl(95), 1000)).toHaveLength(1);
    const e2 = make({ asset: 'pump-*', metric: 'rpm', operator: 'lt', value: 1 });
    e2.evaluate(ev({ rpm: 1500 }, { asset: 'pump-01' }), 0);
    e2.evaluate(ev({ rpm: 0 }, { asset: 'pump-02' }), 0);
    expect(e2.evaluate(lvl(95), 1000)).toEqual([]);
  });

  it('la supresión aplica también a DEV y ROC y respeta el retardo de activación', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule({ kind: 'DEV', threshold: 10, suppressWhen: sup, forSeconds: 5 })], 0);
    e.setSetpoints('demo', new Map([['tk-01', { level: 50 }]]));
    e.evaluate(pump(0), 0);
    expect(e.evaluate(lvl(90), 1000)).toEqual([]);
    expect(e.takeSuppressions()).toHaveLength(1);
  });
});

describe('estado interno y huérfanas', () => {
  it('las reglas deshabilitadas o eliminadas cierran sus alarmas (lifecycle closed)', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    e.evaluate(lvl(95), 0);
    const orphans = e.setRules([], 5000);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ state: 'cleared', lifecycle: 'closed', ts: 5000 });
    expect(e.activeAlarms()).toEqual([]);
  });

  it('patchActive/markAcknowledged actualizan la alarma en memoria', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    const [a] = e.evaluate(lvl(95), 0);
    e.markAcknowledged(a.id);
    expect(e.getActive(a.id)).toMatchObject({ acknowledged: true, lifecycle: 'acked' });
    const out = e.evaluate(lvl(10), 1000);
    expect(out[0]).toMatchObject({ lifecycle: 'closed', acknowledged: true });
  });

  it('una postergada que se normaliza queda closed y sin campos de postergación', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    const [a] = e.evaluate(lvl(95), 0);
    e.patchActive(a.id, { lifecycle: 'shelved', shelvedUntil: 9999, shelvedReason: 'mant' });
    expect(e.evaluate(lvl(96), 500)).toEqual([]); // no se duplica mientras sigue la condición
    const out = e.evaluate(lvl(10), 1000);
    expect(out[0]).toMatchObject({ state: 'cleared', lifecycle: 'closed' });
    expect(out[0]).not.toHaveProperty('shelvedUntil');
  });

  it('una alarma restaurada postergada no se vuelve a crear mientras persiste la condición', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    const [a] = e.evaluate(lvl(95), 0);
    const e2 = new AlarmEvaluator();
    e2.setRules([rule()], 0);
    e2.restore([{ ...a, lifecycle: 'shelved' }], 0);
    expect(e2.evaluate(lvl(97), 1000)).toEqual([]);
    expect(e2.getActive(a.id)?.lifecycle).toBe('shelved');
  });

  it('la telemetría de mala calidad no dispara, limpia ni suprime', () => {
    const e = new AlarmEvaluator();
    e.setRules(
      [rule({ suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 } })],
      0,
    );
    e.evaluate(ev({ rpm: 0 }, { asset: 'pump-01', quality: 'bad' }), 0);
    expect(e.evaluate(lvl(95), 1000)).toHaveLength(1); // el dato malo de la bomba no suprimió
    expect(e.evaluate(lvl(10, { quality: 'bad' }), 2000)).toEqual([]);
  });

  it('el estado por (regla, activo) no crece con muestras que no cumplen ninguna condición', () => {
    const e = new AlarmEvaluator();
    e.setRules([rule()], 0);
    for (let i = 0; i < 50_000; i++) {
      e.evaluate(lvl(50, { asset: `tk-${i % 7}` }), i);
    }
    // si hubiese una pista por activo habría 7; no hay ninguna porque la condición nunca se cumple
    expect((e as unknown as { trackCount: number }).trackCount).toBe(0);
  });
});
