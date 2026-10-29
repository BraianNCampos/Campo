import { describe, expect, it } from 'vitest';
import { assetKind, assetLabel, primaryValue, pumpRunning, sortAssetIds } from './assets';
import { buildWsUrl, resolveConfig } from './env';
import { clamp, damp, formatAgo, formatNumber, lerp } from './math';
import { formatMetric } from './metrics';
import { assetStatus, maxSeverity } from './status';

describe('math', () => {
  it('clamp / lerp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });
  it('damp converge sin sobrepasar y no depende del framerate', () => {
    const slow = (() => {
      let v = 0;
      for (let i = 0; i < 60; i++) v = damp(v, 100, 4, 1 / 60);
      return v;
    })();
    const fast = (() => {
      let v = 0;
      for (let i = 0; i < 30; i++) v = damp(v, 100, 4, 1 / 30);
      return v;
    })();
    expect(slow).toBeCloseTo(fast, 5);
    expect(slow).toBeLessThan(100);
    expect(damp(0, 100, 4, 1000)).toBeCloseTo(100, 5);
    expect(damp(7, 100, 4, 0)).toBe(7);
  });
  it('formatNumber y formatAgo', () => {
    expect(formatNumber(1.234, 1)).toBe('1.2');
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatAgo(4000)).toBe('hace 4 s');
    expect(formatAgo(125_000)).toBe('hace 2 min');
    expect(formatAgo(7_300_000)).toBe('hace 2 h');
  });
});

describe('assets', () => {
  it('detecta tipo por id y por métricas', () => {
    expect(assetKind('tk-01')).toBe('tank');
    expect(assetKind('pump-02')).toBe('pump');
    expect(assetKind('valve-01')).toBe('valve');
    expect(assetKind('x1', { rpm: 1 })).toBe('pump');
    expect(assetKind('x1', { level: 1 })).toBe('tank');
    expect(assetKind('zzz')).toBe('other');
  });
  it('etiquetas y orden', () => {
    expect(assetLabel('tk-01')).toBe('Tanque 01');
    expect(assetLabel('pump-12')).toBe('Bomba 12');
    expect(assetLabel('abc')).toBe('abc');
    expect(sortAssetIds(['valve-01', 'tk-10', 'pump-01', 'tk-02'])).toEqual(['tk-02', 'tk-10', 'pump-01', 'valve-01']);
  });
  it('pumpRunning y primaryValue', () => {
    expect(pumpRunning({ rpm: 1450 })).toBe(true);
    expect(pumpRunning({ rpm: 10 })).toBe(false);
    expect(pumpRunning(undefined)).toBe(false);
    expect(primaryValue('tk-01', { ts: 1, quality: 'good', values: { temp: 20, level: 55 } })).toBe(55);
  });
});

describe('status / metrics', () => {
  const st = (quality: 'good' | 'uncertain' | 'bad') => ({ ts: 1, quality, values: {} });
  it('prioridad: sin dato > alarma > calidad', () => {
    expect(assetStatus(undefined)).toBe('bad');
    expect(assetStatus(st('bad'), 'critical')).toBe('bad');
    expect(assetStatus(st('good'), 'critical')).toBe('critical');
    expect(assetStatus(st('good'), 'warning')).toBe('warning');
    expect(assetStatus(st('uncertain'))).toBe('uncertain');
    expect(assetStatus(st('good'))).toBe('ok');
  });
  it('maxSeverity', () => {
    expect(maxSeverity(undefined, 'warning')).toBe('warning');
    expect(maxSeverity('critical', 'warning')).toBe('critical');
    expect(maxSeverity('warning', 'critical')).toBe('critical');
  });
  it('formatMetric usa unidad y decimales', () => {
    expect(formatMetric('level', 72.46)).toBe('72.5 %');
    expect(formatMetric('rpm', 1449.6)).toBe('1450 rpm');
    expect(formatMetric('temp', 18.25, false)).toBe('18.3');
    expect(formatMetric('level', undefined)).toBe('—');
    expect(formatMetric('desconocida', 3.14159)).toBe('3.14');
  });
});

describe('env', () => {
  it('demo por defecto sin WS_URL; MOCK lo fuerza', () => {
    expect(resolveConfig({}).mock).toBe(true);
    expect(resolveConfig({ WS_URL: 'ws://x/ws' }).mock).toBe(false);
    expect(resolveConfig({ WS_URL: 'ws://x/ws', MOCK: '1' }).mock).toBe(true);
    expect(resolveConfig({ MOCK: '0' }).mock).toBe(false);
  });
  it('sanea plant y apiUrl', () => {
    expect(resolveConfig({ PLANT: 'Bad Plant!' }).plant).toBe('demo');
    expect(resolveConfig({ PLANT: 'planta-1' }).plant).toBe('planta-1');
    expect(resolveConfig({ API_URL: 'http://api:3000/' }).apiUrl).toBe('http://api:3000');
  });
  it('buildWsUrl añade plant y token', () => {
    const loc = { protocol: 'https:', host: 'app.test' };
    expect(buildWsUrl('wss://api.test/ws', 'demo', 'abc.def', loc)).toBe('wss://api.test/ws?plant=demo&token=abc.def');
    expect(buildWsUrl('ws://api.test:3001', 'demo', null, loc)).toBe('ws://api.test:3001/ws?plant=demo');
    expect(buildWsUrl(null, 'demo', null, loc)).toBe('wss://app.test/ws?plant=demo');
    expect(buildWsUrl(null, 'p', 't', { protocol: 'http:', host: 'localhost:3000' })).toBe('ws://localhost:3000/ws?plant=p&token=t');
  });
});
