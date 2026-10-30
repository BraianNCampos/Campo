import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ID_PATTERN } from '@campo/shared';
import type { AuthenticatedRequest } from './auth.types';
import { PlantAccessDenied } from './plant-access';
import { TenantScope } from './tenant-scope';

/** Petición con el cliente propietario de la planta ya resuelto por el guard. */
export type PlantRequest = AuthenticatedRequest & { plantOrgId?: string | null };

/**
 * Para rutas con `:plant`. Va después de JwtAuthGuard (global): usa `req.user`.
 * - formato inválido -> 400 (sin revelar nada);
 * - sin acceso (otra planta, otro cliente o inexistente) -> 403 genérico (ver TenantScope);
 * - platform_admin sobre una planta inexistente -> 404.
 */
@Injectable()
export class PlantAccessGuard implements CanActivate {
  constructor(private readonly tenant: TenantScope) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<PlantRequest>();
    const plant: unknown = req.params?.['plant'];
    if (typeof plant !== 'string' || !ID_PATTERN.test(plant)) {
      throw new BadRequestException('plant inválida');
    }
    if (!req.user) throw new PlantAccessDenied(plant);
    req.plantOrgId = await this.tenant.assertPlant(req.user, plant);
    return true;
  }
}
