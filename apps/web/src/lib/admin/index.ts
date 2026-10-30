import { withBase } from '../base-path';
import type { Role } from '@campo/shared';
import { clearToken, getToken } from '@/lib/auth';
import { getDemoOrgId, setDemoOrgId, DEMO_ORGS, type DemoOrgId } from '@/lib/demo-org';
import { config } from '@/lib/env';
import { HttpAdminApi } from './http-api';
import { MockAdminApi } from './mock-api';
import { ROLES } from './types';
import type { AdminApi } from './types';

const DEMO_ROLE_KEY = 'campo.demoRole';

/** Rol con el que se "inicia sesión" en modo demo (se cambia en Mi cuenta). */
export function getDemoRole(): Role {
  try {
    const v = localStorage.getItem(DEMO_ROLE_KEY);
    if (v && (ROLES as readonly string[]).includes(v)) return v as Role;
  } catch {
    /* almacenamiento bloqueado */
  }
  return 'admin';
}

export function setDemoRole(role: Role): void {
  try {
    localStorage.setItem(DEMO_ROLE_KEY, role);
  } catch {
    /* noop */
  }
}

/**
 * Identidad del modo demo: `getDemoOrgId()` manda (null = personal de plataforma). Con un cliente elegido el
 * rol demo nunca es `platform_admin`.
 */
export function getDemoIdentity(): { role: Role; org: DemoOrgId | null } {
  const org = getDemoOrgId();
  if (org === null) return { role: 'platform_admin', org: null };
  const role = getDemoRole();
  return { role: role === 'platform_admin' ? 'admin' : role, org };
}

/** Elige el usuario demo (rol y cliente) y lo recuerda; la página se recarga para reiniciar sesión y datos. */
export function setDemoIdentity(role: Role, org: DemoOrgId | null): void {
  setDemoRole(role);
  setDemoOrgId(role === 'platform_admin' ? null : (org ?? 'campos-demo'));
}

export { DEMO_ORGS };

/** 401: la sesión no vale → se limpia el token y se vuelve a /login (navegación completa: reinicia el estado). */
function handleUnauthorized(): void {
  clearToken();
  if (typeof window !== 'undefined' && !window.location.pathname.replace(/\/$/, '').endsWith('/login')) window.location.replace(withBase('/login'));
}

let instance: AdminApi | null = null;

/** Mock en modo demo (igual que el stream), HTTP en caso contrario. Singleton por pestaña. */
export function getAdminApi(): AdminApi {
  instance ??= config.mock
    ? new MockAdminApi({ ...getDemoIdentity(), latencyMs: 60 })
    : new HttpAdminApi({ baseUrl: config.apiUrl, getToken, onUnauthorized: handleUnauthorized });
  return instance;
}

/** Sólo para tests / cambio de rol demo. */
export function setAdminApi(api: AdminApi | null): void {
  instance = api;
}

export * from './types';
