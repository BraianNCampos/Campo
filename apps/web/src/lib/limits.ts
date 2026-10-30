import type { Limit } from '@campo/shared';
import { DEMO_LIMITS } from './demo-seed';
import { getToken } from './auth';
import { config } from './env';

const OPERATORS = new Set(['gt', 'lt', 'gte', 'lte']);

/** Sólo acepta límites bien formados (la API es la autoridad, pero un dato roto no debe romper la pantalla). */
export function parseLimits(raw: unknown): Limit[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is Limit =>
      !!l && typeof l === 'object' &&
      typeof (l as Limit).asset === 'string' && typeof (l as Limit).metric === 'string' &&
      OPERATORS.has((l as Limit).operator) && Number.isFinite((l as Limit).threshold) &&
      ((l as Limit).severity === 'warning' || (l as Limit).severity === 'critical'),
  );
}

export class LimitsError extends Error {
  constructor(readonly status: number) {
    super(`limits ${status}`);
  }
}

/** Límites de una planta: en modo demo salen de `DEMO_LIMITS`; si no, `GET /api/plants/:plant/limits`. */
export async function loadLimits(plant: string, fetcher: typeof fetch = fetch): Promise<Limit[]> {
  if (config.mock) return (DEMO_LIMITS[plant] ?? []).map((l) => ({ ...l }));
  const token = getToken();
  let res: Response;
  try {
    res = await fetcher(`${config.apiUrl}/api/plants/${encodeURIComponent(plant)}/limits`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new LimitsError(0);
  }
  if (!res.ok) throw new LimitsError(res.status);
  return parseLimits(await res.json().catch(() => []));
}
