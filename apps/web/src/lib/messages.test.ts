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

describe('alarmas REST (AlarmEvent + clearedAt/acknowledgedBy/…)', () => {
  it('acepta los campos extra y conserva acknowledged', () => {
    const m = parseServerMessage({
      type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level',
      severity: 'warning', state: 'active', value: 5, threshold: 10, ts: 1, message: 'm',
      acknowledged: true, acknowledgedBy: 'u1', acknowledgedAt: 2, clearedAt: null,
    });
    expect(m).toMatchObject({ id: 'a1', acknowledged: true });
  });
});

describe('mensaje catalog', () => {
  it('{type:"catalog", plant} es válido y exige la planta', () => {
    expect(parseServerMessage({ type: 'catalog', plant: 'demo' })).toEqual({ type: 'catalog', plant: 'demo' });
    expect(parseServerMessage('{"type":"catalog","plant":"norte"}')).toEqual({ type: 'catalog', plant: 'norte' });
    expect(parseServerMessage({ type: 'catalog' })).toBeNull();
    expect(parseServerMessage({ type: 'catalog', plant: '' })).toBeNull();
  });
});

describe('alarmas ISA-18.2 en el parser', () => {
  const base = { type: 'alarm', id: 'a', plant: 'p', asset: 'x', metric: 'level', severity: 'critical', state: 'active' };
  it('conserva kind, lifecycle, rationale y shelving', () => {
    const m = parseServerMessage({
      ...base, kind: 'HH', lifecycle: 'shelved', shelvedUntil: 123, shelvedReason: 'mantenimiento',
      rationale: { description: ' Nivel alto ', consequence: 'Rebalse', response: '', extra: 1 },
    });
    expect(m).toMatchObject({ kind: 'HH', lifecycle: 'shelved', shelvedUntil: 123, shelvedReason: 'mantenimiento', rationale: { description: 'Nivel alto', consequence: 'Rebalse' } });
    expect((m as { rationale: object }).rationale).not.toHaveProperty('response');
  });
  it('descarta valores inválidos de kind y lifecycle', () => {
    const m = parseServerMessage({ ...base, kind: 'XX', lifecycle: 'raro', rationale: 5, shelvedUntil: 'x' });
    expect(m).not.toHaveProperty('kind');
    expect(m).not.toHaveProperty('lifecycle');
    expect(m).not.toHaveProperty('rationale');
    expect(m).not.toHaveProperty('shelvedUntil');
  });
});
