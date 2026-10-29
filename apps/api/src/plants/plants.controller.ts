import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { SnapshotMessage } from '@campo/shared';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { PlantParams } from '../common/params';
import { Asset, AssetsRepository } from './assets.repository';
import { StateService } from './state.service';

@Controller('plants/:plant')
@UseGuards(PlantAccessGuard)
export class PlantsController {
  constructor(
    private readonly assets: AssetsRepository,
    private readonly state: StateService,
  ) {}

  @Get('assets')
  listAssets(@Param() p: PlantParams): Promise<Asset[]> {
    return this.assets.listByPlant(p.plant);
  }

  @Get('state')
  getState(@Param() p: PlantParams): Promise<SnapshotMessage> {
    return this.state.getSnapshot(p.plant);
  }
}
