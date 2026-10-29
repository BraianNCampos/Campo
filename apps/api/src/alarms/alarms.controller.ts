import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { AlarmRecord } from './alarm.types';
import { AlarmsService } from './alarms.service';
import { IdParam, ListAlarmsQuery } from './dto';

@Controller('alarms')
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  @Get()
  list(@Query() q: ListAlarmsQuery): Promise<AlarmRecord[]> {
    return this.alarms.list(q);
  }

  @Post(':id/ack')
  @Roles('engineer', 'operator')
  @HttpCode(200)
  ack(@Param() p: IdParam, @CurrentUser() user: AuthUser): Promise<AlarmRecord> {
    return this.alarms.ack(p.id, user);
  }
}
