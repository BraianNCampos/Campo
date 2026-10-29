import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { Plant } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { PlantParams } from '../common/params';
import { CreatePlantDto, UpdatePlantDto } from './dto';
import { PlantsService } from './plants.service';

/** Plantas: listado para todos (según asignación); alta, nombre y baja sólo admin. */
@Controller('plants')
export class PlantsAdminController {
  constructor(private readonly plants: PlantsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<Plant[]> {
    return this.plants.list(user);
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreatePlantDto, @CurrentUser() actor: AuthUser): Promise<Plant> {
    return this.plants.create(dto.id, dto.name, actor);
  }

  @Patch(':plant')
  @Roles('admin')
  update(
    @Param() p: PlantParams,
    @Body() dto: UpdatePlantDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<Plant> {
    return this.plants.rename(p.plant, dto.name, actor);
  }

  @Delete(':plant')
  @Roles('admin')
  @HttpCode(200)
  remove(@Param() p: PlantParams, @CurrentUser() actor: AuthUser): Promise<{ deleted: true }> {
    return this.plants.remove(p.plant, actor);
  }
}
