import { BadRequestException } from '@nestjs/common';

export const BUCKETS = {
  '1s': 1,
  '10s': 10,
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21_600,
  '1d': 86_400,
} as const;
export type BucketName = keyof typeof BUCKETS;
export const BUCKET_NAMES = Object.keys(BUCKETS) as BucketName[];

export type HistorySource = 'raw' | '1m';

export interface HistoryPlan {
  source: HistorySource;
  bucket: BucketName;
  bucketSeconds: number;
  from: Date;
  to: Date;
  /** Tope de filas que se pedirá a la base de datos. */
  limit: number;
}

export interface PlanLimits {
  maxPoints: number;
  maxRangeDays: number;
}

/** Puntos que buscamos como máximo cuando el bucket se elige automáticamente. */
const AUTO_TARGET_POINTS = 1000;

/**
 * Decide tabla y bucket. Buckets < 1 min leen la hypertable `telemetry` (datos crudos);
 * buckets >= 1 min leen el agregado continuo `telemetry_1m`.
 */
export function planHistory(
  input: { from: Date; to: Date; bucket?: BucketName },
  limits: PlanLimits,
): HistoryPlan {
  const rangeMs = input.to.getTime() - input.from.getTime();
  if (!(rangeMs > 0)) throw new BadRequestException('"from" debe ser anterior a "to"');
  if (rangeMs > limits.maxRangeDays * 86_400_000) {
    throw new BadRequestException(`El rango máximo es ${limits.maxRangeDays} días`);
  }
  const rangeSec = rangeMs / 1000;

  let bucket = input.bucket;
  if (!bucket) {
    bucket =
      BUCKET_NAMES.find((b) => rangeSec / BUCKETS[b] <= AUTO_TARGET_POINTS) ??
      BUCKET_NAMES[BUCKET_NAMES.length - 1];
  }
  const bucketSeconds = BUCKETS[bucket];
  const points = Math.ceil(rangeSec / bucketSeconds);
  if (points > limits.maxPoints) {
    throw new BadRequestException(
      `El rango con bucket ${bucket} produciría ${points} puntos (máximo ${limits.maxPoints}); usa un bucket mayor o un rango menor`,
    );
  }
  return {
    source: bucketSeconds >= 60 ? '1m' : 'raw',
    bucket,
    bucketSeconds,
    from: input.from,
    to: input.to,
    limit: limits.maxPoints,
  };
}
