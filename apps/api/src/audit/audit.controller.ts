import { Controller, Get, Query } from '@nestjs/common';
import type { AuditEntry } from '@campo/shared';
import { Roles } from '../auth/decorators';
import { AuditService } from './audit.service';
import { AuditListQuery } from './dto';

/** Sólo lectura y sólo admin: la auditoría no se edita ni se borra desde la API. */
@Controller('audit')
@Roles('admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() q: AuditListQuery): Promise<AuditEntry[]> {
    return this.audit.list(q);
  }
}
