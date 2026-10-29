import { ID_PATTERN } from '@campo/shared';

export interface RawEnv {
  MOCK?: string;
  WS_URL?: string;
  API_URL?: string;
  PLANT?: string;
}

export interface AppConfig {
  /** true → el stream WebSocket se simula en el cliente */
  mock: boolean;
  /** URL base del WS (sin query). null → se deriva del origen de la página */
  wsUrl: string | null;
  /** URL base de la API REST ('' = mismo origen) */
  apiUrl: string;
  plant: string;
}

const TRUE = new Set(['1', 'true', 'yes']);
const FALSE = new Set(['0', 'false', 'no']);

/** Modo demo por defecto si no hay NEXT_PUBLIC_WS_URL; NEXT_PUBLIC_MOCK=0|1 lo fuerza. */
export function resolveConfig(env: RawEnv): AppConfig {
  const wsUrl = env.WS_URL?.trim() || null;
  const flag = env.MOCK?.trim().toLowerCase() ?? '';
  const mock = TRUE.has(flag) ? true : FALSE.has(flag) ? false : wsUrl === null;
  const plantRaw = env.PLANT?.trim() ?? '';
  return {
    mock,
    wsUrl,
    apiUrl: (env.API_URL?.trim() ?? '').replace(/\/+$/, ''),
    plant: ID_PATTERN.test(plantRaw) ? plantRaw : 'demo',
  };
}

// Next sólo sustituye referencias literales a process.env.NEXT_PUBLIC_*.
export const config: AppConfig = resolveConfig({
  MOCK: process.env.NEXT_PUBLIC_MOCK,
  WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  API_URL: process.env.NEXT_PUBLIC_API_URL,
  PLANT: process.env.NEXT_PUBLIC_PLANT,
});

/** Construye `ws(s)://host/ws?plant=..&token=..`. `loc` se inyecta en tests. */
export function buildWsUrl(
  base: string | null,
  plant: string,
  token: string | null,
  loc: { protocol: string; host: string } = window.location,
): string {
  const fallback = `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
  const url = new URL(base ?? fallback, `${loc.protocol}//${loc.host}`);
  if (url.pathname === '/') url.pathname = '/ws'; // el endpoint del servidor es siempre /ws
  url.searchParams.set('plant', plant);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
