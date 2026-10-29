import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from './auth.types';

/**
 * Rate limit (mismos LOGIN_RATE_LIMIT / LOGIN_RATE_TTL_MS que el login) por USUARIO autenticado en lugar
 * de por IP: quien tenga un token robado no evita el límite cambiando de IP, y varios usuarios tras un
 * mismo NAT no se bloquean entre sí. Va después del JwtAuthGuard global, así que `req.user` ya existe.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as AuthenticatedRequest;
    return Promise.resolve(r.user?.id ?? r.ip ?? 'unknown');
  }
}
