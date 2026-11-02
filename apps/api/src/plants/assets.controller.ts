import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, PlantOrgId, Roles } from '../auth/decorators';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { AssetParams, PlantParams } from '../common/params';
import { AssetResult, AssetsService } from './assets.service';
import { CreateAssetDto, SetpointDto, SetpointParams, UpdateAssetDto } from './dto';

/**
 * Altas/ediciones/bajas de activos: admin y engineer. El rol lo comprueba el RolesGuard global y la
 * pertenencia a la planta el PlantAccessGuard (engineer sin esa planta -> 403). Los GET siguen en PlantsController.
 */
@Controller('plants/:plant/assets')
@UseGuards(PlantAccessGuard)
@Roles('engineer')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post()
  create(
    @Param() p: PlantParams,
    @Body() dto: CreateAssetDto,
    @CurrentUser() actor: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<AssetResult> {
    return this.assets.create(p.plant, orgId, dto, actor);
  }

  @Patch(':asset')
  update(
    @Param() p: AssetParams,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() actor: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<AssetResult> {
    return this.assets.update(p.plant, orgId, p.asset, dto, actor);
  }

  /** Ajusta el setpoint de una métrica (§14.2). Auditado `asset.setpoint`. */
  @Put(':asset/setpoints/:metric')
  setSetpoint(
    @Param() p: SetpointParams,
    @Body() dto: SetpointDto,
    @CurrentUser() actor: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<AssetResult> {
    return this.assets.setSetpoint(p.plant, orgId, p.asset, p.metric, dto.value, actor);
  }

  @Delete(':asset')
  @HttpCode(200)
  remove(
    @Param() p: AssetParams,
    @CurrentUser() actor: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<{ deleted: true; affectedRules: number }> {
    return this.assets.remove(p.plant, orgId, p.asset, actor);
  }
}
