import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ID_PATTERN } from '@campo/shared';
import type { AuthenticatedRequest } from './auth.types';
import { PlantCatalog } from './plant-catalog';
import { PlantAccessDenied, canAccessPlant } from './plant-access';

/**
 * Para rutas con `:plant`. Va después de JwtAuthGuard (global): usa `req.user`.
 * - formato inválido -> 400 (sin revelar nada);
 * - sin acceso -> 403 genérico (igual exista o no la planta);
 * - admin sobre una planta inexistente -> 404.
 */
@Injectable()
export class PlantAccessGuard implements CanActivate {
  constructor(private readonly catalog: PlantCatalog) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const plant: unknown = req.params?.['plant'];
    if (typeof plant !== 'string' || !ID_PATTERN.test(plant)) {
      throw new BadRequestException('plant inválida');
    }
    const user = req.user;
    if (!user || !canAccessPlant(user, plant)) throw new PlantAccessDenied(plant);
    if (user.role === 'admin' && !(await this.catalog.exists(plant))) {
      throw new NotFoundException('Planta no encontrada');
    }
    return true;
  }
}
