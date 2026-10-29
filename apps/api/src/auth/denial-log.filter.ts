import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ID_PATTERN } from '@campo/shared';
import type { AuthenticatedRequest } from './auth.types';

const log = new Logger('authz');

const plantOf = (candidate: unknown): string | undefined =>
  typeof candidate === 'string' && ID_PATTERN.test(candidate) ? candidate : undefined;

/**
 * Registra en el log estructurado toda denegación 401/403 (quién, qué ruta, qué planta) y deja la
 * respuesta tal cual la generaría Nest. Sólo path (sin query ni cuerpo) y nada sensible.
 */
@Catch(HttpException)
export class DenialLogFilter extends BaseExceptionFilter {
  override catch(exception: HttpException, host: ArgumentsHost): void {
    const status = exception.getStatus();
    if ((status === 401 || status === 403) && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<AuthenticatedRequest>();
      const ex = exception as HttpException & { plant?: string; userId?: string };
      const body = req.body as { plant?: unknown } | undefined;
      log.warn({
        msg: 'acceso denegado',
        status,
        userId: ex.userId ?? req.user?.id,
        method: req.method,
        path: req.path,
        plant:
          plantOf(ex.plant) ??
          plantOf(req.params?.['plant']) ??
          plantOf(req.query?.['plant']) ??
          plantOf(body?.plant),
      });
    }
    super.catch(exception, host);
  }
}
