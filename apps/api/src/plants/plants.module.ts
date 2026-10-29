import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { AssetsController } from './assets.controller';
import { AssetsRepository, PgAssetsRepository } from './assets.repository';
import { AssetsService } from './assets.service';
import { PlantsAdminController } from './plants-admin.controller';
import { PlantsController } from './plants.controller';
import { PlantsRepository, PgPlantsRepository } from './plants.repository';
import { PlantsService } from './plants.service';
import { StateService } from './state.service';

@Module({
  imports: [AlarmsModule], // AlarmRulesRepository: contar las reglas afectadas al borrar un activo
  controllers: [PlantsController, PlantsAdminController, AssetsController],
  providers: [
    { provide: AssetsRepository, useClass: PgAssetsRepository },
    { provide: PlantsRepository, useClass: PgPlantsRepository },
    AssetsService,
    PlantsService,
    StateService,
  ],
  exports: [StateService],
})
export class PlantsModule {}
