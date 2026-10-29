import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AlarmRule } from './alarm.types';
import { AlarmRulesService } from './alarm-rules.service';
import { CreateRuleDto, IdParam, RuleListQuery, UpdateRuleDto } from './dto';

/** Contrato: reglas gestionables por admin y engineer (admin siempre pasa el RolesGuard). */
@Controller('alarm-rules')
@Roles('admin', 'engineer')
export class AlarmRulesController {
  constructor(private readonly rules: AlarmRulesService) {}

  @Get()
  list(@Query() q: RuleListQuery, @CurrentUser() user: AuthUser): Promise<AlarmRule[]> {
    return this.rules.list(user, q.plant);
  }

  @Get(':id')
  get(@Param() p: IdParam, @CurrentUser() user: AuthUser): Promise<AlarmRule> {
    return this.rules.get(p.id, user);
  }

  @Post()
  create(@Body() dto: CreateRuleDto, @CurrentUser() user: AuthUser): Promise<AlarmRule> {
    return this.rules.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param() p: IdParam,
    @Body() dto: UpdateRuleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AlarmRule> {
    return this.rules.update(p.id, dto, user);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param() p: IdParam, @CurrentUser() user: AuthUser): Promise<void> {
    await this.rules.remove(p.id, user);
  }
}
