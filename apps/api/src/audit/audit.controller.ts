import { Controller, Get, Query } from '@nestjs/common';
import type { AuditEntry } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuditService } from './audit.service';
import { AuditListQuery } from './dto';

/** Sólo lectura y sólo admin (de su cliente) / platform_admin (todos): la auditoría no se edita ni se borra desde la API. */
@Controller('audit')
@Roles('admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() q: AuditListQuery, @CurrentUser() user: AuthUser): Promise<AuditEntry[]> {
    return this.audit.list(q, user);
  }
}
