import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  createParamDecorator,
} from '@nestjs/common';
import { raw } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Observable } from 'rxjs';
import { GLB_LIMITS } from './glb-validator';

const GLB_CONTENT_TYPE = /^(model\/gltf-binary|application\/octet-stream)\s*(;|$)/i;

/**
 * Lee el cuerpo CRUDO (sin multipart) de la subida de modelos con el *body parser* `raw` de Express y un
 * límite de 10 MB, SÓLO en esta ruta (el límite global del resto de la API no cambia). Se ejecuta como
 * interceptor, es decir DESPUÉS de los guards (JWT, rol, acceso a la planta): un cliente sin permiso nunca
 * llega a hacer que el servidor almacene un cuerpo de hasta 10 MB. Más de 10 MB -> 413.
 */
@Injectable()
export class RawGlbInterceptor implements NestInterceptor {
  private readonly parse: RequestHandler = raw({
    type: () => true, // el Content-Type ya se comprobó antes
    limit: GLB_LIMITS.maxBytes,
  });

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    if (!GLB_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
      throw new UnsupportedMediaTypeException(
        'Content-Type debe ser model/gltf-binary (GLB crudo, sin multipart)',
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.parse(req, http.getResponse<Response>(), (err?: unknown) =>
        err ? reject(toHttpError(err)) : resolve(),
      );
    });
    return next.handle();
  }
}

/** Errores del parser (http-errors) -> excepciones de Nest con mensaje en español. */
function toHttpError(err: unknown): HttpException {
  const e = err as { type?: string; status?: number };
  if (e.type === 'entity.too.large') {
    return new PayloadTooLargeException('El modelo supera el límite de 10 MB');
  }
  if (e.type === 'request.aborted') return new BadRequestException('Subida interrumpida');
  return new BadRequestException('Cuerpo de la petición no válido');
}

/** El GLB crudo de la petición (Buffer; vacío si el cliente no envió nada). */
export const RawGlb = createParamDecorator((_data: unknown, ctx: ExecutionContext): Buffer => {
  const body = ctx.switchToHttp().getRequest<{ body?: unknown }>().body;
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
});
