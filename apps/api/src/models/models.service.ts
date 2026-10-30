import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { ModelInfo } from '@campo/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { assertPlantAccess } from '../auth/plant-access';
import { CatalogNotifier } from '../redis/catalog-notifier';
import { GLB_LIMITS, validateGlb } from './glb-validator';
import { ModelsRepository } from './models.repository';

/** ¿`If-None-Match` casa con este sha256? Admite lista, comillas, `W/` y `*`. */
export function etagMatches(header: string | undefined, sha256: string): boolean {
  if (!header) return false;
  return header.split(',').some((part) => {
    const tag = part.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    return tag === '*' || tag === sha256;
  });
}

/**
 * Modelos 3D (GLB) por planta. El acceso (rol y planta) de subida/listado/borrado lo deciden los guards del
 * controlador; la descarga comprueba aquí la planta del modelo (el id no lleva `:plant`).
 */
@Injectable()
export class ModelsService {
  constructor(
    private readonly repo: ModelsRepository,
    private readonly audit: AuditService,
    private readonly notifier: CatalogNotifier,
  ) {}

  /** Valida, deduplica por sha256 y guarda. `created: false` = ya existía en la planta (200). */
  async upload(
    plant: string,
    name: string,
    data: Buffer,
    actor: AuthUser,
  ): Promise<{ model: ModelInfo; created: boolean }> {
    if (data.length === 0) {
      throw new BadRequestException('El cuerpo está vacío: envíe el GLB crudo (model/gltf-binary)');
    }
    if (data.length > GLB_LIMITS.maxBytes) {
      throw new PayloadTooLargeException(
        `El modelo supera el límite de ${GLB_LIMITS.maxBytes} bytes (10 MB)`,
      );
    }
    const check = validateGlb(data);
    if (!check.ok) throw new BadRequestException(`GLB no válido: ${check.error}`);

    const sha256 = createHash('sha256').update(data).digest('hex');
    const res = await this.repo.insert({ plant, name, sha256, data, createdBy: actor.id });
    if (res.created) await this.notifier.changed(plant);
    await this.audit.record(actor, 'model.upload', `model:${plant}/${res.model.id}`, {
      name: res.model.name,
      size: res.model.size,
      sha256,
      dedup: !res.created,
    });
    return res;
  }

  list(plant: string): Promise<ModelInfo[]> {
    return this.repo.list(plant);
  }

  /**
   * Descarga con control de acceso a la planta del modelo (403 genérico). Si `If-None-Match` casa con el
   * sha256 no se lee el contenido: `data: null` = responder 304.
   */
  async download(
    user: AuthUser,
    id: string,
    ifNoneMatch?: string,
  ): Promise<{ info: ModelInfo; data: Buffer | null }> {
    const info = await this.repo.getInfo(id);
    if (!info) throw new NotFoundException('Modelo no encontrado');
    assertPlantAccess(user, info.plant);
    if (etagMatches(ifNoneMatch, info.sha256)) return { info, data: null };
    const data = await this.repo.getData(id);
    if (!data) throw new NotFoundException('Modelo no encontrado');
    return { info, data };
  }

  /** 409 con la lista de activos que lo usan; no se borra nada mientras haya referencias. */
  async remove(plant: string, id: string, actor: AuthUser): Promise<{ deleted: true }> {
    const info = await this.repo.getInfo(id);
    if (!info || info.plant !== plant) throw new NotFoundException('Modelo no encontrado');
    const assets = await this.repo.assetsUsing(plant, id);
    if (assets.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `El modelo está en uso por ${assets.length} activo(s): quite su model3dRef antes de borrarlo`,
        assets,
      });
    }
    if (!(await this.repo.delete(plant, id))) throw new NotFoundException('Modelo no encontrado');
    await this.notifier.changed(plant);
    await this.audit.record(actor, 'model.delete', `model:${plant}/${id}`, { name: info.name, id });
    return { deleted: true };
  }
}
