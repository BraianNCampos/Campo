import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditRepository, PgAuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/** Global: lo usan users, plants, alarms y auth. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, { provide: AuditRepository, useClass: PgAuditRepository }],
  exports: [AuditService],
})
export class AuditModule {}
