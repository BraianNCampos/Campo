import type { Role } from '@campo/shared';
import type { Request } from 'express';

export interface AuthUser {
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
