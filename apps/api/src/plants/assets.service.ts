import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { AlarmRulesRepository } from '../alarms/alarm-rules.repository';
import { compileAssetPattern } from '../alarms/alarm-evaluator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PlantCatalog } from '../auth/plant-catalog';
import { REDIS } from '../redis/tokens';
import { Asset, AssetPatch, AssetsRepository } from './assets.repository';
import { CreateAssetDto, UpdateAssetDto } from './dto';

/** Canal Redis: los clientes refrescan el catálogo de la planta. Payload: `{"plant":"..."}`. */
export const CATALOG_CHANGED_CHANNEL = 'campo:catalog:changed';

/**
 * Altas/ediciones/bajas del catálogo. El acceso (rol y planta) lo decide el controlador
 * (RolesGuard + PlantAccessGuard); aquí sólo la lógica.
 */
@Injectable()
export class AssetsService {
  private readonly log = new Logger(AssetsService.name);

  constructor(
    private readonly repo: AssetsRepository,
    private readonly rules: AlarmRulesRepository,
    private readonly catalog: PlantCatalog,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async create(plant: string, dto: CreateAssetDto, actor: AuthUser): Promise<Asset> {
    if (!(await this.catalog.exists(plant))) throw new NotFoundException('Planta no encontrada');
    const asset = await this.repo.create({
      plant,
      id: dto.id,
      name: dto.name,
      type: dto.type,
      model3dRef: dto.model3dRef ?? null,
      metadata: dto.metadata ?? {},
    });
    if (!asset) throw new ConflictException('El activo ya existe en la planta');
    await this.notifyChanged(plant);
    await this.audit.record(actor, 'asset.create', `asset:${plant}/${asset.id}`, {
      name: asset.name,
      type: asset.type,
      model3dRef: asset.model3dRef,
    });
    return asset;
  }

  async update(plant: string, id: string, dto: UpdateAssetDto, actor: AuthUser): Promise<Asset> {
    if (dto.name === null || dto.type === null) {
      throw new BadRequestException('name y type no pueden ser null');
    }
    const patch: AssetPatch = {
      name: dto.name,
      type: dto.type,
      model3dRef: dto.model3dRef,
      metadata: dto.metadata === null ? {} : dto.metadata,
    };
    const changed = (Object.keys(patch) as (keyof AssetPatch)[]).filter(
      (k) => patch[k] !== undefined,
    );
    if (changed.length === 0) {
      throw new BadRequestException('Nada que modificar (name, type, model3dRef o metadata)');
    }
    const asset = await this.repo.update(plant, id, patch);
    if (!asset) throw new NotFoundException('Activo no encontrado');
    await this.notifyChanged(plant);
    await this.audit.record(actor, 'asset.update', `asset:${plant}/${id}`, {
      changed, // sólo nombres de campo; el contenido de metadata no se audita
      name: patch.name,
      type: patch.type,
      model3dRef: patch.model3dRef,
    });
    return asset;
  }

  /** Las reglas que nombran el activo (id exacto o patrón) NO se tocan: se informa de cuántas son. */
  async remove(
    plant: string,
    id: string,
    actor: AuthUser,
  ): Promise<{ deleted: true; affectedRules: number }> {
    if (!(await this.repo.delete(plant, id))) throw new NotFoundException('Activo no encontrado');
    const affectedRules = (await this.rules.list(plant)).filter((r) =>
      compileAssetPattern(r.asset).test(id),
    ).length;
    await this.notifyChanged(plant);
    await this.audit.record(actor, 'asset.delete', `asset:${plant}/${id}`, { affectedRules });
    return { deleted: true, affectedRules };
  }

  /** Best effort: el catálogo ya cambió; si Redis falla sólo se registra (los clientes refrescan al reconectar). */
  private async notifyChanged(plant: string): Promise<void> {
    try {
      await this.redis.publish(CATALOG_CHANGED_CHANNEL, JSON.stringify({ plant }));
    } catch (err) {
      this.log.warn({
        msg: 'no se pudo publicar catalog:changed',
        plant,
        error: (err as Error).message,
      });
    }
  }
}
