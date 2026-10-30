import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MODEL_REF_PATTERN } from '@campo/shared';
import { AlarmRulesRepository } from '../alarms/alarm-rules.repository';
import { compileAssetPattern } from '../alarms/alarm-evaluator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PlantCatalog } from '../auth/plant-catalog';
import { ModelsRepository } from '../models/models.repository';
import { CatalogNotifier } from '../redis/catalog-notifier';
import { assetMetadataError, unknownConnections } from './asset-metadata';
import { Asset, AssetPatch, AssetsRepository } from './assets.repository';
import { CreateAssetDto, UpdateAssetDto } from './dto';

export { CATALOG_CHANGED_CHANNEL } from '../redis/catalog-notifier';

/** Respuesta de crear/editar: el activo y, si `metadata.connectsTo` nombra ids que aún no existen, avisos. */
export type AssetResult = Asset & { warnings?: string[] };

/**
 * Altas/ediciones/bajas del catálogo. El acceso (rol y planta) lo decide el controlador
 * (RolesGuard + PlantAccessGuard); aquí sólo la lógica.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly repo: AssetsRepository,
    private readonly rules: AlarmRulesRepository,
    private readonly catalog: PlantCatalog,
    private readonly audit: AuditService,
    private readonly models: ModelsRepository,
    private readonly notifier: CatalogNotifier,
  ) {}

  async create(plant: string, dto: CreateAssetDto, actor: AuthUser): Promise<AssetResult> {
    this.checkMetadata(dto.metadata, dto.id);
    if (!(await this.catalog.exists(plant))) throw new NotFoundException('Planta no encontrada');
    await this.checkModelRef(plant, dto.model3dRef);
    const asset = await this.repo.create({
      plant,
      id: dto.id,
      name: dto.name,
      type: dto.type,
      model3dRef: dto.model3dRef ?? null,
      metadata: dto.metadata ?? {},
    });
    if (!asset) throw new ConflictException('El activo ya existe en la planta');
    await this.notifier.changed(plant);
    await this.audit.record(actor, 'asset.create', `asset:${plant}/${asset.id}`, {
      name: asset.name,
      type: asset.type,
      model3dRef: asset.model3dRef,
    });
    return this.withWarnings(asset);
  }

  async update(
    plant: string,
    id: string,
    dto: UpdateAssetDto,
    actor: AuthUser,
  ): Promise<AssetResult> {
    if (dto.name === null || dto.type === null) {
      throw new BadRequestException('name y type no pueden ser null');
    }
    this.checkMetadata(dto.metadata ?? undefined, id);
    if (typeof dto.model3dRef === 'string') {
      // Un valor ya guardado (p. ej. texto libre de antes de la Fase 5) no se revalida si no cambia.
      const current = await this.repo.get(plant, id);
      await this.checkModelRef(plant, dto.model3dRef, current?.model3dRef);
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
    await this.notifier.changed(plant);
    await this.audit.record(actor, 'asset.update', `asset:${plant}/${id}`, {
      changed, // sólo nombres de campo; el contenido de metadata no se audita
      name: patch.name,
      type: patch.type,
      model3dRef: patch.model3dRef,
    });
    return patch.metadata === undefined ? asset : this.withWarnings(asset);
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
    await this.notifier.changed(plant);
    await this.audit.record(actor, 'asset.delete', `asset:${plant}/${id}`, { affectedRules });
    return { deleted: true, affectedRules };
  }

  /** `metadata.layout` / `metadata.connectsTo` según docs/architecture.md §10.3 (el resto de claves es libre). */
  private checkMetadata(metadata: Record<string, unknown> | undefined, selfId: string): void {
    const error = metadata && assetMetadataError(metadata, selfId);
    if (error) throw new BadRequestException(error);
  }

  /** `null` o `model:<uuid>` de un modelo de la MISMA planta. `current` = valor ya guardado (se tolera tal cual). */
  private async checkModelRef(
    plant: string,
    ref: string | null | undefined,
    current?: string | null,
  ): Promise<void> {
    if (ref === undefined || ref === null || ref === current) return;
    if (!MODEL_REF_PATTERN.test(ref)) {
      throw new BadRequestException(
        'model3dRef debe ser null o "model:<uuid>" de un modelo de la planta',
      );
    }
    if (!(await this.models.exists(plant, ref.slice('model:'.length)))) {
      throw new BadRequestException('model3dRef: el modelo no existe en esta planta');
    }
  }

  /** Añade `warnings` si `connectsTo` nombra activos que (todavía) no existen en la planta. Informativo. */
  private async withWarnings(asset: Asset): Promise<AssetResult> {
    const known = new Set((await this.repo.listByPlant(asset.plant)).map((a) => a.id));
    const missing = unknownConnections(asset.metadata, known);
    if (missing.length === 0) return asset;
    return {
      ...asset,
      warnings: missing.map((id) => `connectsTo: el activo "${id}" no existe todavía en la planta`),
    };
  }
}
