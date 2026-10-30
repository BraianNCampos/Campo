import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { ManagedUser, Org } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, PlatformOnly } from '../auth/decorators';
import { CreateOrgAdminDto, CreateOrgDto, OrgIdParam, UpdateOrgDto } from './dto';
import { OrgsService } from './orgs.service';

/** Clientes: sólo personal de plataforma (un `admin` de cliente recibe 403 en todas las rutas). */
@Controller('orgs')
@PlatformOnly()
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get()
  list(): Promise<Org[]> {
    return this.orgs.list();
  }

  @Post()
  create(@Body() dto: CreateOrgDto, @CurrentUser() actor: AuthUser): Promise<Org> {
    return this.orgs.create(dto, actor);
  }

  @Get(':id')
  get(@Param() p: OrgIdParam): Promise<Org> {
    return this.orgs.get(p.id);
  }

  @Patch(':id')
  update(
    @Param() p: OrgIdParam,
    @Body() dto: UpdateOrgDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<Org> {
    return this.orgs.update(p.id, dto, actor);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param() p: OrgIdParam, @CurrentUser() actor: AuthUser): Promise<{ deleted: true }> {
    return this.orgs.remove(p.id, actor);
  }

  @Post(':id/admins')
  createAdmin(
    @Param() p: OrgIdParam,
    @Body() dto: CreateOrgAdminDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManagedUser> {
    return this.orgs.createAdmin(p.id, dto, actor);
  }
}
