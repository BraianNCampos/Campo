import { Module } from '@nestjs/common';
import { AssetsRepository, PgAssetsRepository } from './assets.repository';
import { PlantsController } from './plants.controller';
import { StateService } from './state.service';

@Module({
  controllers: [PlantsController],
  providers: [{ provide: AssetsRepository, useClass: PgAssetsRepository }, StateService],
  exports: [StateService],
})
export class PlantsModule {}
