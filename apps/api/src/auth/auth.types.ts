import type { Me, Role } from '@campo/shared';
import type { Request } from 'express';

/** Usuario adjunto a la petición: rol y plantas vienen de la base (vía AccessService), no del token. */
export type AuthUser = Me;

/** Lo que afirma el JWT. Sólo `sub` es de fiar; el resto se vuelve a consultar en cada petición. */
export interface TokenClaims {
  id: string;
  email: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const ROLES: readonly Role[] = ['admin', 'engineer', 'operator', 'viewer'];
