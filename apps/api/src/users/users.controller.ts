import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { ManagedUser } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { CreateUserDto, SetPlantsDto, UpdateUserDto, UserIdParam, UserListQuery } from './dto';
import { UsersService } from './users.service';

/** Administración de usuarios: admin (sólo de su cliente) y platform_admin. */
@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() q: UserListQuery, @CurrentUser() actor: AuthUser): Promise<ManagedUser[]> {
    return this.users.list(actor, q.orgId);
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

  /** Cierra todas las sesiones del usuario (invalida sus JWT y cierra sus WebSockets). */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Param() p: UserIdParam, @CurrentUser() actor: AuthUser): Promise<ManagedUser> {
    return this.users.revoke(p.id, actor);
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
