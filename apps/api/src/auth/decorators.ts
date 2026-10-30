import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Role } from '@campo/shared';
import type { AuthUser, AuthenticatedRequest } from './auth.types';
import type { PlantRequest } from './plant-access.guard';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Ruta sin autenticación (login, sondas). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Roles permitidos. `platform_admin` y `admin` siempre pasan, salvo que la lista incluya `platform_admin`:
 * entonces sólo ese rol. Sin decorador: cualquier usuario autenticado.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Rutas de plataforma (clientes): sólo personal de Campos Ingeniería. */
export const PlatformOnly = () => Roles('platform_admin');

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return req.user as AuthUser;
  },
);

/** Cliente propietario de la planta de la ruta (lo resuelve PlantAccessGuard). */
export const PlantOrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<PlantRequest>().plantOrgId ?? null,
);
