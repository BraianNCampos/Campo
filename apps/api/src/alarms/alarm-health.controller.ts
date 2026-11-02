import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import type { AlarmKpis, AlarmPolicy } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, PlantOrgId, Roles } from '../auth/decorators';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { PlantParams } from '../common/params';
import { AlarmHealthService } from './alarm-health.service';
import { AlarmPolicyDto, KpiQuery } from './dto';

/**
 * Salud de alarmas por planta. El PlantAccessGuard decide el acceso (cliente y planta): 403 genérico a quien
 * no la tenga. Lectura: cualquier rol con acceso; escritura de la política: admin y platform_admin.
 */
@Controller('plants/:plant')
@UseGuards(PlantAccessGuard)
export class AlarmHealthController {
  constructor(private readonly health: AlarmHealthService) {}

  @Get('alarm-policy')
  getPolicy(@Param() p: PlantParams): Promise<AlarmPolicy> {
    return this.health.getPolicy(p.plant);
  }

  @Put('alarm-policy')
  @Roles('admin')
  setPolicy(
    @Param() p: PlantParams,
    @Body() dto: AlarmPolicyDto,
    @CurrentUser() user: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<AlarmPolicy> {
    return this.health.setPolicy(p.plant, orgId, dto, user);
  }

  @Get('alarm-kpis')
  kpis(@Param() p: PlantParams, @Query() q: KpiQuery): Promise<AlarmKpis> {
    return this.health.kpis(p.plant, q.window);
  }
}
