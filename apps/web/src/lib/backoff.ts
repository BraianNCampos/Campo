export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** 0..1: fracción del retardo que se resta aleatoriamente */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0.5 };

/**
 * Backoff exponencial con jitter: retardo ∈ [exp·(1−jitter), exp], con
 * exp = min(maxMs, baseMs·factor^attempt). `attempt` empieza en 0.
 */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const n = Math.max(0, Math.floor(attempt));
  const exp = Math.min(opts.maxMs, opts.baseMs * Math.pow(opts.factor, n));
  return Math.round(exp * (1 - opts.jitter * rng()));
}
