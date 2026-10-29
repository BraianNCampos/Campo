import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import type { AlarmRule } from './alarm.types';
import { AlarmRulesService } from './alarm-rules.service';
import { CreateRuleDto, IdParam, RuleListQuery, UpdateRuleDto } from './dto';

/** Contrato: reglas gestionables por admin y engineer (admin siempre pasa el RolesGuard). */
@Controller('alarm-rules')
@Roles('admin', 'engineer')
export class AlarmRulesController {
  constructor(private readonly rules: AlarmRulesService) {}

  @Get()
  list(@Query() q: RuleListQuery): Promise<AlarmRule[]> {
    return this.rules.list(q.plant);
  }

  @Get(':id')
  get(@Param() p: IdParam): Promise<AlarmRule> {
    return this.rules.get(p.id);
  }

  @Post()
  create(@Body() dto: CreateRuleDto): Promise<AlarmRule> {
    return this.rules.create(dto);
  }

  @Patch(':id')
  update(@Param() p: IdParam, @Body() dto: UpdateRuleDto): Promise<AlarmRule> {
    return this.rules.update(p.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param() p: IdParam): Promise<void> {
    await this.rules.remove(p.id);
  }
}
