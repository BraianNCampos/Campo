import { describe, expect, it } from 'vitest';
import { agoText, countdown, isCancellable, isFinalStatus, orderText, outcomeText, sortOrders, STATUS_LABEL } from './flow';

describe('flow de órdenes', () => {
  it('cuenta regresiva de 60 s', () => {
    expect(countdown(60_000, 0)).toEqual({ seconds: 60, fraction: 1, expired: false });
    expect(countdown(60_000, 30_500)).toMatchObject({ seconds: 30, expired: false });
    expect(countdown(60_000, 59_001).seconds).toBe(1);
    expect(countdown(60_000, 60_000)).toEqual({ seconds: 0, fraction: 0, expired: true });
    expect(countdown(60_000, 90_000).expired).toBe(true);
  });
  it('textos de orden y resultado', () => {
    expect(orderText({ command: 'fill', target: 80 })).toBe('Llenar a 80 %');
    expect(orderText({ command: 'drain', target: 42.5 })).toBe('Vaciar a 42,5 %');
    expect(orderText({ command: 'stop' })).toBe('Detener');
    expect(outcomeText({ status: 'rejected', reason: 'válvula trabada' })).toBe('El equipo la rechazó: válvula trabada');
    expect(outcomeText({ status: 'done' })).toBe('Se completó.');
    expect(outcomeText({ status: 'timeout' })).toMatch(/no respondió/);
    for (const s of Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]) expect(outcomeText({ status: s }).length).toBeGreaterThan(3);
  });
  it('estados finales y cancelables', () => {
    expect(isFinalStatus('running')).toBe(false);
    expect(isFinalStatus('done')).toBe(true);
    expect(isCancellable({ status: 'running', command: 'fill' })).toBe(true);
    expect(isCancellable({ status: 'pending', command: 'drain' })).toBe(true);
    expect(isCancellable({ status: 'running', command: 'stop' })).toBe(false);
    expect(isCancellable({ status: 'done', command: 'fill' })).toBe(false);
  });
  it('tiempos relativos y orden', () => {
    expect(agoText(2000)).toBe('ahora');
    expect(agoText(30_000)).toBe('hace 30 s');
    expect(agoText(5 * 60_000)).toBe('hace 5 min');
    expect(agoText(3 * 3_600_000)).toBe('hace 3 h');
    expect(sortOrders([{ id: 'a', requestedAt: 1 }, { id: 'b', requestedAt: 3 }, { id: 'c', requestedAt: 2 }]).map((o) => o.id)).toEqual(['b', 'c', 'a']);
  });
});
