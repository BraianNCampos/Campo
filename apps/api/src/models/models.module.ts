import { Module } from '@nestjs/common';
import { ModelsController } from './models.controller';
import { ModelsRepository, PgModelsRepository } from './models.repository';
import { ModelsService } from './models.service';
import { RawGlbInterceptor } from './raw-glb.interceptor';

/** Exporta el repositorio: PlantsModule valida `model3dRef` y limpia los modelos al borrar una planta. */
@Module({
  controllers: [ModelsController],
  providers: [
    { provide: ModelsRepository, useClass: PgModelsRepository },
    ModelsService,
    RawGlbInterceptor,
  ],
  exports: [ModelsRepository],
})
export class ModelsModule {}
