import { Injectable, NotFoundException } from '@nestjs/common';
import type { AlarmRule } from './alarm.types';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmRulesRepository } from './alarm-rules.repository';
import { CreateRuleDto, UpdateRuleDto } from './dto';

@Injectable()
export class AlarmRulesService {
  constructor(
    private readonly repo: AlarmRulesRepository,
    private readonly engine: AlarmEngine,
  ) {}

  list(plant?: string): Promise<AlarmRule[]> {
    return this.repo.list(plant);
  }

  async get(id: string): Promise<AlarmRule> {
    const rule = await this.repo.get(id);
    if (!rule) throw new NotFoundException('Regla no encontrada');
    return rule;
  }

  async create(dto: CreateRuleDto): Promise<AlarmRule> {
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
    return rule;
  }

  async update(id: string, dto: UpdateRuleDto): Promise<AlarmRule> {
    const rule = await this.repo.update(id, { ...dto });
    if (!rule) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    return rule;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
  }
}
