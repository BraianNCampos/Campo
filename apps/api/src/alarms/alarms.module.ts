import { Module } from '@nestjs/common';
import { CatalogModule } from '../plants/catalog.module';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmHealthController } from './alarm-health.controller';
import { AlarmHealthRepository, PgAlarmHealthRepository } from './alarm-health.repository';
import { AlarmHealthService } from './alarm-health.service';
import { AlarmJournalRepository, PgAlarmJournalRepository } from './alarm-journal.repository';
import { AlarmRulesController } from './alarm-rules.controller';
import { AlarmRulesRepository, PgAlarmRulesRepository } from './alarm-rules.repository';
import { AlarmRulesService } from './alarm-rules.service';
import { AlarmsController } from './alarms.controller';
import { AlarmsRepository, PgAlarmsRepository } from './alarms.repository';
import { AlarmsService } from './alarms.service';

@Module({
  imports: [CatalogModule],
  controllers: [AlarmRulesController, AlarmsController, AlarmHealthController],
  providers: [
    AlarmEngine,
    AlarmRulesService,
    AlarmsService,
    AlarmHealthService,
    { provide: AlarmRulesRepository, useClass: PgAlarmRulesRepository },
    { provide: AlarmsRepository, useClass: PgAlarmsRepository },
    { provide: AlarmJournalRepository, useClass: PgAlarmJournalRepository },
    { provide: AlarmHealthRepository, useClass: PgAlarmHealthRepository },
  ],
  exports: [AlarmRulesRepository],
})
export class AlarmsModule {}
