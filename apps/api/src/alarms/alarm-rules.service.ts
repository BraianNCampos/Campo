import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { assertPlantAccess, plantFilter } from '../auth/plant-access';
import type { AlarmRule } from './alarm.types';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmRulesRepository } from './alarm-rules.repository';
import { CreateRuleDto, UpdateRuleDto } from './dto';

/** CRUD de reglas limitado a las plantas del usuario (admin: todas). */
@Injectable()
export class AlarmRulesService {
  constructor(
    private readonly repo: AlarmRulesRepository,
    private readonly engine: AlarmEngine,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, plant?: string): Promise<AlarmRule[]> {
    if (plant) assertPlantAccess(user, plant);
    return this.repo.list(plant, plantFilter(user));
  }

  async get(id: string, user: AuthUser): Promise<AlarmRule> {
    const rule = await this.repo.get(id);
    if (!rule) throw new NotFoundException('Regla no encontrada');
    assertPlantAccess(user, rule.plant);
    return rule;
  }

  async create(dto: CreateRuleDto, user: AuthUser): Promise<AlarmRule> {
    assertPlantAccess(user, dto.plant);
    const rule = await this.repo.create({
      plant: dto.plant,
      asset: dto.asset,
      metric: dto.metric,
      operator: dto.operator,
      threshold: dto.threshold,
      severity: dto.severity,
      forSeconds: dto.forSeconds ?? 0,
      hysteresis: dto.hysteresis ?? 0,
      enabled: dto.enabled ?? true,
    });
    await this.engine.refresh();
    await this.audit.record(user, 'rule.create', `rule:${rule.id}`, { ...rule });
    return rule;
  }

  async update(id: string, dto: UpdateRuleDto, user: AuthUser): Promise<AlarmRule> {
    await this.get(id, user); // 404 si no existe; 403 si la regla es de otra planta
    if (dto.plant) assertPlantAccess(user, dto.plant); // tampoco se puede mover a una planta ajena
    const rule = await this.repo.update(id, { ...dto });
    if (!rule) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    const changed = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );
    await this.audit.record(user, 'rule.update', `rule:${id}`, { changed, plant: rule.plant });
    return rule;
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const rule = await this.get(id, user);
    if (!(await this.repo.delete(id))) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    await this.audit.record(user, 'rule.delete', `rule:${id}`, {
      plant: rule.plant,
      asset: rule.asset,
      metric: rule.metric,
    });
  }
}
