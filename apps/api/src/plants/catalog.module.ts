import { Module } from '@nestjs/common';
import { AssetsRepository, PgAssetsRepository } from './assets.repository';

/** El catálogo de activos como proveedor aislado: lo usan plantas y el motor de alarmas (setpoints) sin ciclos. */
@Module({
  providers: [{ provide: AssetsRepository, useClass: PgAssetsRepository }],
  exports: [AssetsRepository],
})
export class CatalogModule {}
