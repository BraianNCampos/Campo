import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Plant } from '@campo/shared';
import { AccessService } from '../auth/access.service';
import type { AuthUser } from '../auth/auth.types';
import { isPlatform, orgIdOf } from '../auth/plant-access';
import { PlantCatalog } from '../auth/plant-catalog';
import { TenantScope } from '../auth/tenant-scope';
import { AuditService } from '../audit/audit.service';
import { ModelsRepository } from '../models/models.repository';
import { OrgsRepository } from '../orgs/orgs.repository';
import { CatalogNotifier } from '../redis/catalog-notifier';
import { PlantsRepository } from './plants.repository';

@Injectable()
export class PlantsService {
  private readonly log = new Logger(PlantsService.name);

  constructor(
    private readonly repo: PlantsRepository,
    private readonly catalog: PlantCatalog,
    private readonly tenant: TenantScope,
    private readonly orgs: OrgsRepository,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly models: ModelsRepository,
    private readonly notifier: CatalogNotifier,
  ) {}

  /**
   * Plantas visibles: platform_admin = todas las registradas (`orgId` opcional filtra por cliente);
   * admin = las de su cliente; engineer/operator/viewer = las asignadas de su cliente.
   */
  list(user: AuthUser, orgId?: string): Promise<Plant[]> {
    const scope = this.tenant.scope(user);
    return this.repo.list({ ids: scope.plants, orgId: isPlatform(user) ? orgId : scope.orgId });
  }

  /** `admin`: siempre en su cliente. `platform_admin`: `orgId` obligatorio (400). */
  async create(
    id: string,
    name: string,
    requestedOrg: string | undefined,
    actor: AuthUser,
  ): Promise<Plant> {
    const orgId = await this.resolveOrg(actor, requestedOrg);
    if (!isPlatform(actor) && (await this.catalog.isLive(id))) {
      // Telemetría de una planta aún sin registrar: sólo plataforma puede adjudicarla a un cliente.
      throw new ConflictException('La planta ya existe');
    }
    if (!(await this.repo.create(id, name, orgId)))
      throw new ConflictException('La planta ya existe');
    await this.notifier.changed(id);
    await this.audit.record(actor, 'plant.create', `plant:${id}`, orgId, { name });
    return { id, name, assets: 0, orgId };
  }

  async rename(id: string, name: string, actor: AuthUser): Promise<Plant> {
    const orgId = await this.tenant.assertPlant(actor, id);
    const plant = await this.repo.rename(id, name);
    if (!plant) throw new NotFoundException('Planta no encontrada');
    await this.notifier.changed(id);
    await this.audit.record(actor, 'plant.update', `plant:${id}`, orgId, { name });
    return plant;
  }

  /**
   * 409 si tiene activos; limpia asignaciones, reglas, alarmas y modelos (en la misma transacción) y
   * cierra las sesiones WS de esa planta.
   */
  async remove(id: string, actor: AuthUser): Promise<{ deleted: true }> {
    const orgId = await this.tenant.assertPlant(actor, id);
    const res = await this.repo.remove(id);
    if (res.status === 'not_found') throw new NotFoundException('Planta no encontrada');
    if (res.status === 'has_assets') {
      throw new ConflictException('La planta tiene activos: bórrelos antes de eliminarla');
    }
    for (const userId of res.unassignedUserIds) await this.access.invalidate(userId);
    try {
      await this.models.deleteByPlant(id); // idempotente: ya lo hizo la transacción
    } catch (err) {
      this.log.warn({
        msg: 'no se pudieron borrar los modelos de la planta',
        plant: id,
        error: (err as Error).message,
      });
    }
    await this.notifier.changed(id);
    await this.audit.record(actor, 'plant.delete', `plant:${id}`, orgId, {
      unassignedUsers: res.unassignedUserIds.length,
    });
    return { deleted: true };
  }

  private async resolveOrg(actor: AuthUser, requested: string | undefined): Promise<string> {
    if (!isPlatform(actor)) {
      const own = orgIdOf(actor);
      if (own === null || (requested !== undefined && requested !== own)) {
        throw new ForbiddenException('No puede crear plantas en otro cliente');
      }
      return own;
    }
    if (requested === undefined) throw new BadRequestException('orgId es obligatorio');
    if (!(await this.orgs.findById(requested)))
      throw new NotFoundException('Cliente no encontrado');
    return requested;
  }
}
