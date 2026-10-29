const TOKEN_KEY = 'campo.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* almacenamiento bloqueado: la sesión dura lo que la pestaña */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** POST /api/auth/login → JWT. Contrato: `{email,password}` → `{accessToken}`. */
export async function login(apiUrl: string, email: string, password: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new ApiError('No se pudo contactar con el servidor', 0);
  }
  if (res.status === 401 || res.status === 403) throw new ApiError('Credenciales inválidas', res.status);
  if (!res.ok) throw new ApiError(`Error del servidor (${res.status})`, res.status);
  const body: unknown = await res.json().catch(() => null);
  const token =
    typeof body === 'object' && body !== null && 'accessToken' in body ? (body as { accessToken: unknown }).accessToken : null;
  if (typeof token !== 'string' || !token) throw new ApiError('Respuesta de login inválida', res.status);
  return token;
}
