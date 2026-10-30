import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@campo/shared';
import { AuthenticatedRequest } from './auth.types';
import { ROLES_KEY } from './decorators';

/**
 * `platform_admin` pasa siempre; `admin` pasa siempre salvo en rutas que nombran `platform_admin`
 * (sólo personal de plataforma); el resto, si su rol está en la lista.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    // Si no hay usuario es una ruta @Public con @Roles: se deniega por seguridad.
    if (!user) throw new ForbiddenException('Permisos insuficientes');
    if (user.role === 'platform_admin') return true;
    if (required.includes('platform_admin')) throw new ForbiddenException('Permisos insuficientes');
    if (user.role === 'admin' || required.includes(user.role)) return true;
    throw new ForbiddenException('Permisos insuficientes');
  }
}
