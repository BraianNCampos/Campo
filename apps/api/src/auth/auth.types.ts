import type { Me, Role } from '@campo/shared';
import type { Request } from 'express';

/** Usuario adjunto a la petición: rol, cliente y plantas vienen de la base (vía AccessService), no del token. */
export type AuthUser = Me;

/** Lo que afirma el JWT. Sólo `sub` es de fiar; el resto se vuelve a consultar en cada petición. */
export interface TokenClaims {
  id: string;
  email: string;
  role: Role;
  /** Versión de sesión del token (`tv`). Los emitidos antes de existir la revocación no la llevan: 0. */
  tv: number;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  tv?: number;
}

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const ROLES: readonly Role[] = ['platform_admin', 'admin', 'engineer', 'operator', 'viewer'];
/** Roles que pertenecen siempre a un cliente (todos salvo `platform_admin`). */
export const ORG_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'platform_admin');
