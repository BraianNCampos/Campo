import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { JournalRow } from './alarm-journal.repository';
import { AlarmRecord } from './alarm.types';
import { AlarmsService } from './alarms.service';
import { IdParam, ListAlarmsQuery, ShelveDto } from './dto';

@Controller('alarms')
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  @Get()
  list(@Query() q: ListAlarmsQuery, @CurrentUser() user: AuthUser): Promise<AlarmRecord[]> {
    return this.alarms.list(q, user);
  }

  @Post(':id/ack')
  @Roles('engineer', 'operator')
  @HttpCode(200)
  ack(@Param() p: IdParam, @CurrentUser() user: AuthUser): Promise<AlarmRecord> {
    return this.alarms.ack(p.id, user);
  }

  /** Postergar y levantar la postergación: engineer, admin y platform_admin (el operador reconoce, no posterga). */
  @Post(':id/shelve')
  @Roles('engineer')
  @HttpCode(200)
  shelve(
    @Param() p: IdParam,
    @Body() dto: ShelveDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AlarmRecord> {
    return this.alarms.shelve(p.id, dto, user);
  }

  @Post(':id/unshelve')
  @Roles('engineer')
  @HttpCode(200)
  unshelve(@Param() p: IdParam, @CurrentUser() user: AuthUser): Promise<AlarmRecord> {
    return this.alarms.unshelve(p.id, user);
  }

  /** Diario de la alarma: cualquier rol con acceso a su planta. */
  @Get(':id/journal')
  journal(@Param() p: IdParam, @CurrentUser() user: AuthUser): Promise<JournalRow[]> {
    return this.alarms.journalOf(p.id, user);
  }
}
