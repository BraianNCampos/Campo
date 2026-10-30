import type { AlarmRule } from '../alarms/alarm.types';
import { resolveLimits } from './limits';

const rule = (o: Partial<AlarmRule>): AlarmRule => ({
  id: 'r',
  plant: 'demo',
  asset: '*',
  metric: 'level',
  operator: 'gt',
  threshold: 90,
  severity: 'critical',
  forSeconds: 0,
  hysteresis: 0,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...o,
});

describe('resolveLimits', () => {
  const assets = ['tk-02', 'tk-01', 'pump-01', 'clima-01'];

  it('expande el patrón con * a los activos existentes y ordena de forma estable', () => {
    const out = resolveLimits([rule({ asset: 'tk-*' })], assets);
    expect(out).toEqual([
      { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical' },
      { asset: 'tk-02', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical' },
    ]);
  });

  it('`*` abarca todos; un id exacto sólo a ese activo; un id que no existe no genera límite', () => {
    expect(resolveLimits([rule({ asset: '*' })], assets).map((l) => l.asset)).toEqual([
      'clima-01',
      'pump-01',
      'tk-01',
      'tk-02',
    ]);
    expect(resolveLimits([rule({ asset: 'pump-01' })], assets).map((l) => l.asset)).toEqual([
      'pump-01',
    ]);
    expect(resolveLimits([rule({ asset: 'fantasma' })], assets)).toEqual([]);
  });

  it('ignora las reglas deshabilitadas', () => {
    expect(resolveLimits([rule({ enabled: false })], assets)).toEqual([]);
  });

  it('el orden no depende del de las reglas ni del de los activos', () => {
    const rules = [
      rule({ asset: 'tk-*', metric: 'level', operator: 'lt', threshold: 10, severity: 'warning' }),
      rule({ asset: 'tk-01', metric: 'temp', threshold: 35, severity: 'warning' }),
      rule({ asset: 'tk-*', metric: 'level', operator: 'gt', threshold: 90 }),
    ];
    const a = resolveLimits(rules, assets);
    const b = resolveLimits([...rules].reverse(), [...assets].reverse());
    expect(b).toEqual(a);
    expect(a.map((l) => `${l.asset}/${l.metric}/${l.operator}${l.threshold}`)).toEqual([
      'tk-01/level/lt10',
      'tk-01/level/gt90',
      'tk-01/temp/gt35',
      'tk-02/level/lt10',
      'tk-02/level/gt90',
    ]);
  });

  it('reglas duplicadas (mismo activo, métrica, operador, umbral y severidad) dan un solo límite', () => {
    expect(
      resolveLimits([rule({ asset: 'tk-01' }), rule({ asset: 'tk-*', id: 'r2' })], assets).filter(
        (l) => l.asset === 'tk-01',
      ),
    ).toHaveLength(1);
  });

  it('dos severidades para la misma métrica se conservan (aviso y crítica)', () => {
    const out = resolveLimits(
      [
        rule({ asset: 'en-1', metric: 'kw', threshold: 198, severity: 'warning' }),
        rule({ asset: 'en-1', metric: 'kw', threshold: 220, severity: 'critical' }),
      ],
      ['en-1'],
    );
    expect(out.map((l) => [l.threshold, l.severity])).toEqual([
      [198, 'warning'],
      [220, 'critical'],
    ]);
  });

  it('el patrón escapa los metacaracteres: un punto no es un comodín', () => {
    expect(resolveLimits([rule({ asset: 'a.b' })], ['a.b', 'axb'])).toHaveLength(1);
  });
});
