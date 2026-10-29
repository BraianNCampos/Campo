import { BadRequestException } from '@nestjs/common';
import { planHistory } from './history.planner';

const limits = { maxPoints: 5000, maxRangeDays: 366 };
const at = (ms: number) => new Date(ms);
const H = 3_600_000;
const D = 24 * H;

describe('planHistory', () => {
  it('rango corto -> buckets finos sobre la tabla cruda', () => {
    const p = planHistory({ from: at(0), to: at(H) }, limits);
    expect(p.source).toBe('raw');
    expect(p.bucket).toBe('10s'); // 360 puntos
  });

  it('rango largo -> agregado continuo telemetry_1m', () => {
    const p = planHistory({ from: at(0), to: at(30 * D) }, limits);
    expect(p.source).toBe('1m');
    expect(p.bucketSeconds).toBeGreaterThanOrEqual(60);
    expect(Math.ceil((30 * D) / 1000 / p.bucketSeconds)).toBeLessThanOrEqual(1000);
  });

  it('respeta el bucket pedido y elige la tabla por él', () => {
    expect(planHistory({ from: at(0), to: at(H), bucket: '1m' }, limits)).toMatchObject({
      source: '1m',
      bucketSeconds: 60,
    });
    expect(planHistory({ from: at(0), to: at(H), bucket: '1s' }, limits).source).toBe('raw');
  });

  it('rechaza demasiados puntos', () => {
    expect(() => planHistory({ from: at(0), to: at(D), bucket: '1s' }, limits)).toThrow(
      BadRequestException,
    );
  });

  it('rechaza rangos invertidos, vacíos o por encima del máximo', () => {
    expect(() => planHistory({ from: at(10), to: at(0) }, limits)).toThrow(BadRequestException);
    expect(() => planHistory({ from: at(5), to: at(5) }, limits)).toThrow(BadRequestException);
    expect(() => planHistory({ from: at(0), to: at(400 * D) }, limits)).toThrow(/366/);
  });

  it('el límite de filas coincide con el máximo de puntos', () => {
    expect(planHistory({ from: at(0), to: at(H) }, { maxPoints: 400, maxRangeDays: 1 }).limit).toBe(
      400,
    );
  });
});
