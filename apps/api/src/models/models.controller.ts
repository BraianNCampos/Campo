import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { ModelInfo } from '@campo/shared';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, PlantOrgId, Roles } from '../auth/decorators';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { PlantParams } from '../common/params';
import { ModelParams, PlantModelParams, UploadModelQuery } from './dto';
import { ModelsService } from './models.service';
import { RawGlb, RawGlbInterceptor } from './raw-glb.interceptor';

/**
 * Modelos 3D (docs/architecture.md §10.2). Subir/borrar: admin y engineer con acceso a la planta
 * (RolesGuard + PlantAccessGuard). Listar: cualquier rol con acceso a la planta. Descargar:
 * cualquier usuario autenticado con acceso a la planta del modelo (se comprueba en el servicio).
 */
@Controller()
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Post('plants/:plant/models')
  @UseGuards(PlantAccessGuard)
  @Roles('engineer')
  @UseInterceptors(RawGlbInterceptor)
  async upload(
    @Param() p: PlantParams,
    @Query() q: UploadModelQuery,
    @RawGlb() body: Buffer,
    @CurrentUser() actor: AuthUser,
    @PlantOrgId() orgId: string | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ModelInfo> {
    const { model, created } = await this.models.upload(p.plant, orgId, q.name, body, actor);
    res.status(created ? 201 : 200);
    return model;
  }

  @Get('plants/:plant/models')
  @UseGuards(PlantAccessGuard)
  list(@Param() p: PlantParams): Promise<ModelInfo[]> {
    return this.models.list(p.plant);
  }

  @Delete('plants/:plant/models/:id')
  @UseGuards(PlantAccessGuard)
  @Roles('engineer')
  @HttpCode(200)
  remove(
    @Param() p: PlantModelParams,
    @CurrentUser() actor: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<{ deleted: true }> {
    return this.models.remove(p.plant, orgId, p.id, actor);
  }

  /** El id es inmutable (contenido direccionado por sha256): caché privada de un año + ETag. */
  @Get('models/:id')
  async download(
    @Param() p: ModelParams,
    @CurrentUser() user: AuthUser,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { info, data } = await this.models.download(user, p.id, ifNoneMatch);
    res.set({
      ETag: `"${info.sha256}"`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Type': 'model/gltf-binary',
    });
    if (data) res.status(200).send(data);
    else res.status(304).end();
  }
}
