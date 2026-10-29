import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_BACKOFF } from './backoff';

describe('backoffDelay', () => {
  it('crece exponencialmente sin jitter (rng=0)', () => {
    const d = [0, 1, 2, 3, 4].map((n) => backoffDelay(n, DEFAULT_BACKOFF, () => 0));
    expect(d).toEqual([500, 1000, 2000, 4000, 8000]);
  });
  it('se acota en maxMs', () => {
    expect(backoffDelay(50, DEFAULT_BACKOFF, () => 0)).toBe(DEFAULT_BACKOFF.maxMs);
  });
  it('el jitter reduce el retardo dentro de [exp·(1−j), exp]', () => {
    const lo = backoffDelay(3, DEFAULT_BACKOFF, () => 0.999999);
    const hi = backoffDelay(3, DEFAULT_BACKOFF, () => 0);
    expect(hi).toBe(4000);
    expect(lo).toBeGreaterThanOrEqual(2000);
    expect(lo).toBeLessThan(2100);
  });
  it('intentos negativos o fraccionarios no rompen', () => {
    expect(backoffDelay(-3, DEFAULT_BACKOFF, () => 0)).toBe(500);
    expect(backoffDelay(1.9, DEFAULT_BACKOFF, () => 0)).toBe(1000);
  });
  it('con rng aleatorio siempre queda en rango', () => {
    for (let n = 0; n < 20; n++) {
      const d = backoffDelay(n);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
  });
});
