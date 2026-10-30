import { describe, expect, it } from 'vitest';
import type { AlarmEvent } from '@campo/shared';
import { rankAlarms, summarizeAlarms } from './alarm-summary';

const a = (id: string, over: Partial<AlarmEvent> = {}): AlarmEvent => ({
  type: 'alarm', id, ruleId: 'r', plant: 'p', asset: 'x', metric: 'level', severity: 'warning', state: 'active', value: 1, threshold: 2, ts: 100, message: '', ...over,
});
const map = (...l: AlarmEvent[]) => Object.fromEntries(l.map((x) => [x.id, x]));

describe('resumen de alarmas del pie global', () => {
  it('sin alarmas: todo en cero', () => {
    expect(summarizeAlarms({})).toEqual({ critical: 0, warning: 0, total: 0, unacked: 0, top: [] });
  });
  it('cuenta por prioridad y sin reconocer', () => {
    const s = summarizeAlarms(map(a('1', { severity: 'critical' }), a('2'), a('3', { acknowledged: true }), a('4', { severity: 'critical', acknowledged: true })));
    expect(s).toMatchObject({ critical: 2, warning: 2, total: 4, unacked: 2 });
  });
  it('las 3 más importantes: críticas primero, sin reconocer primero, más recientes primero', () => {
    const s = summarizeAlarms(
      map(
        a('w-old', { ts: 10 }),
        a('w-new', { ts: 90 }),
        a('c-ack', { severity: 'critical', acknowledged: true, ts: 95 }),
        a('c-new', { severity: 'critical', ts: 50 }),
        a('c-old', { severity: 'critical', ts: 20 }),
      ),
    );
    expect(s.top.map((x) => x.id)).toEqual(['c-new', 'c-old', 'c-ack']);
    expect(rankAlarms(Object.values(map(a('1', { ts: 1 }), a('2', { ts: 2 })))).map((x) => x.id)).toEqual(['2', '1']);
  });
  it('ignora las alarmas ya limpiadas', () => {
    expect(summarizeAlarms(map(a('1', { state: 'cleared' }))).total).toBe(0);
  });
});
