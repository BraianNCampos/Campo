import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Role } from '@campo/shared';
import type { AuthUser, AuthenticatedRequest } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Ruta sin autenticación (login, sondas). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Roles permitidos. `admin` siempre pasa. Sin decorador: cualquier usuario autenticado. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return req.user as AuthUser;
});
