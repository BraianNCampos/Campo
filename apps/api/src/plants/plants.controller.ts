import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { Limit, SnapshotMessage } from '@campo/shared';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { PlantParams } from '../common/params';
import { AlarmRulesRepository } from '../alarms/alarm-rules.repository';
import { Asset, AssetsRepository } from './assets.repository';
import { resolveLimits } from './limits';
import { StateService } from './state.service';

@Controller('plants/:plant')
@UseGuards(PlantAccessGuard)
export class PlantsController {
  constructor(
    private readonly assets: AssetsRepository,
    private readonly state: StateService,
    private readonly rules: AlarmRulesRepository,
  ) {}

  @Get('assets')
  listAssets(@Param() p: PlantParams): Promise<Asset[]> {
    return this.assets.listByPlant(p.plant);
  }

  @Get('state')
  getState(@Param() p: PlantParams): Promise<SnapshotMessage> {
    return this.state.getSnapshot(p.plant);
  }

  /** Límites de alarma resueltos contra los activos de la planta. Cualquier rol con acceso a la planta. */
  @Get('limits')
  async limits(@Param() p: PlantParams): Promise<Limit[]> {
    const [rules, assets] = await Promise.all([
      this.rules.list(p.plant),
      this.assets.listByPlant(p.plant),
    ]);
    return resolveLimits(
      rules,
      assets.map((a) => a.id),
    );
  }
}
