import { Module } from '@nestjs/common';
import { HistoryController } from './history.controller';
import { HistoryRepository, PgHistoryRepository } from './history.repository';
import { HistoryService } from './history.service';

@Module({
  controllers: [HistoryController],
  providers: [HistoryService, { provide: HistoryRepository, useClass: PgHistoryRepository }],
})
export class HistoryModule {}
