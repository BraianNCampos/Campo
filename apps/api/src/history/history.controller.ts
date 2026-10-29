import { Controller, Get, Param, Query } from '@nestjs/common';
import { AssetParams } from '../common/params';
import { HistoryQueryDto } from './dto';
import { HistoryResponse, HistoryService } from './history.service';

@Controller('plants/:plant/assets/:asset/history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  get(@Param() p: AssetParams, @Query() q: HistoryQueryDto): Promise<HistoryResponse> {
    return this.history.get(p.plant, p.asset, q);
  }
}
