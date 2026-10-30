import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { TenantScope } from '../auth/tenant-scope';
import type { AlarmRule } from './alarm.types';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmRulesRepository } from './alarm-rules.repository';
import { CreateRuleDto, UpdateRuleDto } from './dto';

/** CRUD de reglas limitado a las plantas del usuario y de su cliente (admin: todas las de su cliente). */
@Injectable()
export class AlarmRulesService {
  constructor(
    private readonly repo: AlarmRulesRepository,
    private readonly engine: AlarmEngine,
    private readonly audit: AuditService,
    private readonly tenant: TenantScope,
  ) {}

  async list(user: AuthUser, plant?: string): Promise<AlarmRule[]> {
    if (plant) await this.tenant.assertPlant(user, plant);
    return this.repo.list(plant, this.tenant.scope(user));
  }

  async get(id: string, user: AuthUser): Promise<AlarmRule> {
    return (await this.load(id, user)).rule;
  }

  /** 404 si la regla no existe; 403 genérico si su planta es de otro cliente o no asignada. */
  private async load(
    id: string,
    user: AuthUser,
  ): Promise<{ rule: AlarmRule; orgId: string | null }> {
    const rule = await this.repo.get(id);
    if (!rule) throw new NotFoundException('Regla no encontrada');
    return { rule, orgId: await this.tenant.assertPlant(user, rule.plant) };
  }

  async create(dto: CreateRuleDto, user: AuthUser): Promise<AlarmRule> {
    const orgId = await this.tenant.assertPlant(user, dto.plant);
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
    await this.audit.record(user, 'rule.create', `rule:${rule.id}`, orgId, { ...rule });
    return rule;
  }

  async update(id: string, dto: UpdateRuleDto, user: AuthUser): Promise<AlarmRule> {
    const { orgId } = await this.load(id, user); // 404 si no existe; 403 si la regla es de otra planta/cliente
    if (dto.plant) {
      // Tampoco se puede mover a una planta ajena, ni sacarla de su cliente (ni siquiera un platform_admin).
      const target = await this.tenant.assertPlant(user, dto.plant);
      if (target !== orgId) {
        throw new BadRequestException('Una regla no se puede mover a una planta de otro cliente');
      }
    }
    const rule = await this.repo.update(id, { ...dto });
    if (!rule) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    const changed = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );
    await this.audit.record(user, 'rule.update', `rule:${id}`, orgId, {
      changed,
      plant: rule.plant,
    });
    return rule;
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const { rule, orgId } = await this.load(id, user);
    if (!(await this.repo.delete(id))) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    await this.audit.record(user, 'rule.delete', `rule:${id}`, orgId, {
      plant: rule.plant,
      asset: rule.asset,
      metric: rule.metric,
    });
  }
}
