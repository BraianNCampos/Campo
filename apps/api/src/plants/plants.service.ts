import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ID_PATTERN, redisKeys } from '@campo/shared';
import type { Plant } from '@campo/shared';
import type Redis from 'ioredis';
import { AccessService } from '../auth/access.service';
import type { AuthUser } from '../auth/auth.types';
import { PlantCatalog } from '../auth/plant-catalog';
import { AuditService } from '../audit/audit.service';
import { REDIS } from '../redis/tokens';
import { PlantsRepository } from './plants.repository';

const STATE_PREFIX = redisKeys.state('');

@Injectable()
export class PlantsService {
  private readonly log = new Logger(PlantsService.name);

  constructor(
    private readonly repo: PlantsRepository,
    private readonly catalog: PlantCatalog,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Plantas visibles: admin = `plants` ∪ plantas con activos ∪ plantas con estado vivo en Redis;
   * resto = las asignadas (aunque aún no estén registradas: nombre = id).
   */
  async list(user: AuthUser): Promise<Plant[]> {
    const byId = new Map<string, Plant>();
    if (user.role === 'admin') {
      for (const p of await this.repo.list()) byId.set(p.id, p);
      for (const id of await this.liveIds()) {
        if (!byId.has(id)) byId.set(id, { id, name: id, assets: 0 });
      }
    } else {
      if (user.plants.length > 0) {
        for (const p of await this.repo.list(user.plants)) byId.set(p.id, p);
      }
      for (const id of user.plants) {
        if (!byId.has(id)) byId.set(id, { id, name: id, assets: 0 });
      }
    }
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async create(id: string, name: string, actor: AuthUser): Promise<Plant> {
    if (!(await this.repo.create(id, name))) throw new ConflictException('La planta ya existe');
    await this.audit.record(actor, 'plant.create', `plant:${id}`, { name });
    return { id, name, assets: 0 };
  }

  async rename(id: string, name: string, actor: AuthUser): Promise<Plant> {
    if (!(await this.catalog.exists(id))) throw new NotFoundException('Planta no encontrada');
    const plant = await this.repo.rename(id, name);
    await this.audit.record(actor, 'plant.update', `plant:${id}`, { name });
    return plant;
  }

  /** 409 si tiene activos; limpia las asignaciones de usuario (y cierra sus sesiones WS de esa planta). */
  async remove(id: string, actor: AuthUser): Promise<{ deleted: true }> {
    const res = await this.repo.remove(id);
    if (res.status === 'not_found') throw new NotFoundException('Planta no encontrada');
    if (res.status === 'has_assets') {
      throw new ConflictException('La planta tiene activos: bórrelos antes de eliminarla');
    }
    for (const userId of res.unassignedUserIds) await this.access.invalidate(userId);
    await this.audit.record(actor, 'plant.delete', `plant:${id}`, {
      unassignedUsers: res.unassignedUserIds.length,
    });
    return { deleted: true };
  }

  /** Ids de planta con estado vivo en Redis. Si Redis falla se degrada a "ninguna". */
  private async liveIds(): Promise<string[]> {
    const ids = new Set<string>();
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${STATE_PREFIX}*`,
          'COUNT',
          200,
        );
        cursor = next;
        for (const key of keys) {
          const id = key.slice(STATE_PREFIX.length);
          if (ID_PATTERN.test(id)) ids.add(id);
        }
      } while (cursor !== '0');
    } catch (err) {
      this.log.warn({ msg: 'no se pudo listar plantas de Redis', error: (err as Error).message });
    }
    return [...ids];
  }
}
