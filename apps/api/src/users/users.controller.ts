import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import type { ManagedUser } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { CreateUserDto, SetPlantsDto, UpdateUserDto, UserIdParam } from './dto';
import { UsersService } from './users.service';

/** Administración de usuarios: sólo admin. */
@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<ManagedUser[]> {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser): Promise<ManagedUser> {
    return this.users.create(dto, actor);
  }

  @Patch(':id')
  update(
    @Param() p: UserIdParam,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManagedUser> {
    return this.users.update(p.id, dto, actor);
  }

  @Put(':id/plants')
  @HttpCode(200)
  setPlants(
    @Param() p: UserIdParam,
    @Body() dto: SetPlantsDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManagedUser> {
    return this.users.setPlants(p.id, dto.plants, actor);
  }
}
