import { Module } from '@nestjs/common';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmRulesController } from './alarm-rules.controller';
import { AlarmRulesRepository, PgAlarmRulesRepository } from './alarm-rules.repository';
import { AlarmRulesService } from './alarm-rules.service';
import { AlarmsController } from './alarms.controller';
import { AlarmsRepository, PgAlarmsRepository } from './alarms.repository';
import { AlarmsService } from './alarms.service';

@Module({
  controllers: [AlarmRulesController, AlarmsController],
  providers: [
    AlarmEngine,
    AlarmRulesService,
    AlarmsService,
    { provide: AlarmRulesRepository, useClass: PgAlarmRulesRepository },
    { provide: AlarmsRepository, useClass: PgAlarmsRepository },
  ],
  exports: [AlarmRulesRepository],
})
export class AlarmsModule {}
