import { describe, expect, it } from 'vitest';
import type { AssetDef, Limit } from '@campo/shared';
import type { LiveAlarm } from '@/lib/alarm-lifecycle';
import { ANOMALY_HEX, anomalyAt, anomalyBase, anomalyText, outlineWidthPx, pulseAt, STALE_UNACKED_MS, type AnomalyInput } from './anomaly';

const NOW = 10_000_000;
const alarm = (over: Partial<LiveAlarm>): LiveAlarm => ({
  type: 'alarm', id: 'a', ruleId: 'r', plant: 'p', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active',
  value: 95, threshold: 90, ts: NOW - 1000, message: '', kind: 'HH', lifecycle: 'unacked', acknowledged: false, ...over,
});
const state = (level: number) => ({ ts: NOW, quality: 'good' as const, values: { level } });
const def: Pick<AssetDef, 'metadata' | 'type'> = { type: 'tank', metadata: {} };
const hi: Limit = { asset: 'tk-01', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical', kind: 'HH' };
const input = (o: Partial<AnomalyInput> = {}): AnomalyInput => ({ state: state(50), alarms: [], limits: [], def, ...o });
const level = (o: Partial<AnomalyInput>, now = NOW) => anomalyAt(anomalyBase(input(o)), now)?.level ?? null;

describe('anomalías: nivel y color', () => {
  it('sin alarmas y en rango → ninguna', () => {
    expect(level({ limits: [hi] })).toBeNull();
    expect(level({})).toBeNull();
  });
  it('alarma crítica reciente → rojo; media → ámbar', () => {
    expect(level({ alarms: [alarm({})] })).toBe('critical');
    expect(level({ alarms: [alarm({ severity: 'warning', kind: 'HI' })] })).toBe('attention');
  });
  it('alarma reconocida (aunque lleve horas) conserva su color y no es magenta', () => {
    const acked = alarm({ lifecycle: 'acked', acknowledged: true, ts: NOW - 3_600_000 });
    expect(level({ alarms: [acked] })).toBe('critical');
    expect(level({ alarms: [{ ...acked, severity: 'warning' }] })).toBe('attention');
  });
  it('sin reconocer de más de 5 min → magenta; justo en 5 min todavía no', () => {
    expect(level({ alarms: [alarm({ ts: NOW - STALE_UNACKED_MS })] })).toBe('critical');
    expect(level({ alarms: [alarm({ ts: NOW - STALE_UNACKED_MS - 1 })] })).toBe('stale');
    expect(level({ alarms: [alarm({ severity: 'warning', ts: NOW - 10 * 60_000 })] })).toBe('stale');
  });
  it('el paso a magenta depende del reloj con la misma base', () => {
    const base = anomalyBase(input({ alarms: [alarm({ ts: NOW })] }));
    expect(anomalyAt(base, NOW + 1000)?.level).toBe('critical');
    expect(anomalyAt(base, NOW + STALE_UNACKED_MS + 1)?.level).toBe('stale');
  });
  it('normalizada sin reconocer: ámbar (y magenta pasados 5 min)', () => {
    const rtn = alarm({ state: 'cleared', lifecycle: 'rtn_unacked', ts: NOW - 1000 });
    expect(level({ alarms: [rtn] })).toBe('attention');
    expect(level({ alarms: [{ ...rtn, ts: NOW - 6 * 60_000 }] })).toBe('stale');
  });
  it('postergadas y cerradas no cuentan', () => {
    expect(level({ alarms: [alarm({ lifecycle: 'shelved' })] })).toBeNull();
    expect(level({ alarms: [alarm({ lifecycle: 'closed', state: 'cleared' })] })).toBeNull();
  });
  it('cerca del límite (≥ 90 % del camino) sin alarma → ámbar con el límite', () => {
    const a = anomalyAt(anomalyBase(input({ state: state(85), limits: [hi] })), NOW);
    expect(a?.level).toBe('attention');
    expect(a?.near).toBe(true);
    expect(a?.limit).toBe(90);
    expect(level({ state: state(60), limits: [hi] })).toBeNull();
  });
  it('sin telemetría o con dato malo no hay «cerca del límite»', () => {
    expect(level({ state: undefined, limits: [hi] })).toBeNull();
    expect(level({ state: { ts: NOW, quality: 'bad', values: { level: 95 } }, limits: [hi] })).toBeNull();
  });
  it('con varias alarmas se muestra la más grave y la sin reconocer más antigua decide el magenta', () => {
    const w = alarm({ id: 'w', severity: 'warning', metric: 'temp', threshold: 30, value: 31, ts: NOW - 10 * 60_000 });
    const c = alarm({ id: 'c', ts: NOW - 1000 });
    const a = anomalyAt(anomalyBase(input({ alarms: [w, c] })), NOW);
    expect(a?.level).toBe('stale');
    expect(a?.metric).toBe('level'); // la crítica es la que se describe
    expect(a?.activeCritical).toBe(true);
  });
  it('los tres colores son distintos', () => {
    expect(new Set(Object.values(ANOMALY_HEX)).size).toBe(3);
  });
});

describe('marcador: texto, contorno y pulso', () => {
  it('tag, valor vivo y límite', () => {
    const a = anomalyBase(input({ alarms: [alarm({})] }))!;
    const t = anomalyText(a, { level: 94.2 }, 'TNK-101', 'Tanque 01');
    expect(t.head).toBe('TNK-101 · HH');
    expect(t.value).toContain('94.2');
    expect(t.limit).toContain('90');
    expect(t.line).toContain('TNK-101');
  });
  it('sin tag usa el nombre; sin telemetría, el valor de la alarma; sin límite, omite el límite', () => {
    const a = anomalyBase(input({ alarms: [alarm({ value: 97, threshold: NaN })] }))!;
    const t = anomalyText(a, undefined, null, 'Tanque 01');
    expect(t.head).toBe('Tanque 01 · HH');
    expect(t.value).toContain('97');
    expect(t.limit).toBe('');
  });
  it('contraste alto: contornos más gruesos', () => {
    for (const l of ['attention', 'critical', 'stale'] as const) expect(outlineWidthPx(l, true)).toBeGreaterThan(outlineWidthPx(l, false));
  });
  it('prefers-reduced-motion: sin pulso (constante); con movimiento oscila dentro de [0,1]', () => {
    const still = [0, 0.13, 0.4, 1.7].map((t) => pulseAt(t, true, 'critical'));
    expect(new Set(still).size).toBe(1);
    const moving = Array.from({ length: 40 }, (_, i) => pulseAt(i * 0.05, false, 'critical'));
    expect(Math.max(...moving) - Math.min(...moving)).toBeGreaterThan(0.1);
    for (const v of moving) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
