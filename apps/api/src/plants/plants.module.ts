import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { ModelsModule } from '../models/models.module';
import { AssetsController } from './assets.controller';
import { CatalogModule } from './catalog.module';
import { AssetsService } from './assets.service';
import { PlantsAdminController } from './plants-admin.controller';
import { PlantsController } from './plants.controller';
import { PlantsRepository, PgPlantsRepository } from './plants.repository';
import { PlantsService } from './plants.service';
import { StateService } from './state.service';

@Module({
  // AlarmRulesRepository: contar las reglas afectadas al borrar un activo; ModelsRepository: validar model3dRef
  imports: [AlarmsModule, ModelsModule, CatalogModule],
  controllers: [PlantsController, PlantsAdminController, AssetsController],
  providers: [
    { provide: PlantsRepository, useClass: PgPlantsRepository },
    AssetsService,
    PlantsService,
    StateService,
  ],
  exports: [StateService],
})
export class PlantsModule {}
