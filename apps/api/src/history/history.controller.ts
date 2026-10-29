import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { AssetParams } from '../common/params';
import { HistoryQueryDto } from './dto';
import { HistoryResponse, HistoryService } from './history.service';

@Controller('plants/:plant/assets/:asset/history')
@UseGuards(PlantAccessGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  get(@Param() p: AssetParams, @Query() q: HistoryQueryDto): Promise<HistoryResponse> {
    return this.history.get(p.plant, p.asset, q);
  }
}
