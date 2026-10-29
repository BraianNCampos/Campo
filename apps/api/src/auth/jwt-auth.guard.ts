import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { IS_PUBLIC_KEY } from './decorators';

/** 401 de un usuario con token válido pero inexistente/inactivo; lleva el id para el log de denegaciones. */
export class SessionInvalid extends UnauthorizedException {
  constructor(readonly userId: string) {
    super('Sesión no válida');
  }
}

/**
 * Autenticación: firma del JWT y, en CADA petición, usuario vigente en la base (vía caché de 30 s) y
 * versión de sesión `tv` del token igual a la actual (si no: 401, token revocado).
 * El rol y las plantas del request salen de la base, no del token.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly access: AccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedException('Falta el token Bearer');
    const claims = await this.auth.verifyToken(match[1]);
    if (!claims) throw new UnauthorizedException('Token inválido o expirado');
    const user = await this.access.getAccess(claims.id, { tv: claims.tv });
    if (!user) throw new SessionInvalid(claims.id);
    req.user = user;
    return true;
  }
}
