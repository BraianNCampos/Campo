import { describe, expect, it } from 'vitest';
import { parseServerMessage } from './messages';

describe('parseServerMessage', () => {
  it('snapshot válido, descarta valores no numéricos y normaliza calidad', () => {
    const m = parseServerMessage(
      JSON.stringify({
        type: 'snapshot',
        plant: 'demo',
        assets: { 'tk-01': { ts: 5, values: { level: 10, temp: 'x', bad: null }, quality: 'weird' }, rota: 7 },
      }),
    );
    expect(m).toEqual({
      type: 'snapshot',
      plant: 'demo',
      assets: { 'tk-01': { ts: 5, values: { level: 10 }, quality: 'good' } },
    });
  });
  it('telemetry y alarm', () => {
    const t = parseServerMessage({ type: 'telemetry', plant: 'demo', asset: 'tk-01', ts: 9, values: { level: 1 }, quality: 'bad' });
    expect(t).toMatchObject({ type: 'telemetry', asset: 'tk-01', quality: 'bad', ts: 9 });
    const a = parseServerMessage({
      type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level',
      severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 1, message: 'm',
    });
    expect(a).toMatchObject({ type: 'alarm', id: 'a1', severity: 'critical', value: 95 });
  });
  it('rechaza basura', () => {
    expect(parseServerMessage('no json')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
    expect(parseServerMessage({ type: 'otro' })).toBeNull();
    expect(parseServerMessage({ type: 'telemetry', plant: 'demo' })).toBeNull();
    expect(parseServerMessage({ type: 'alarm', id: 'x', plant: 'p', asset: 'a', metric: 'm', severity: 'meh', state: 'active' })).toBeNull();
  });
  it('ts ausente usa now', () => {
    const t = parseServerMessage({ type: 'telemetry', plant: 'p', asset: 'a', values: { v: 1 } }, 1234);
    expect(t).toMatchObject({ ts: 1234 });
  });
});
