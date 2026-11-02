import { Injectable, NotFoundException } from '@nestjs/common';
import type { AlarmKpis, AlarmPolicy } from '@campo/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { AlarmHealthRepository } from './alarm-health.repository';
import { DAY_MS, KPI_WINDOWS, kpiStatus } from './alarm-kpis';
import { AlarmPolicyDto } from './dto';

/** Salud de alarmas (EEMUA 191 / ISA-18.2): política por planta y KPIs contra esa política. */
@Injectable()
export class AlarmHealthService {
  constructor(
    private readonly repo: AlarmHealthRepository,
    private readonly audit: AuditService,
  ) {}

  getPolicy(plant: string): Promise<AlarmPolicy> {
    return this.repo.getPolicy(plant);
  }

  async setPolicy(
    plant: string,
    orgId: string | null,
    dto: AlarmPolicyDto,
    user: AuthUser,
  ): Promise<AlarmPolicy> {
    const policy: AlarmPolicy = {
      ratePerDay: dto.ratePerDay,
      peak10min: dto.peak10min,
      staleHours: dto.staleHours,
    };
    if (!(await this.repo.setPolicy(plant, policy))) {
      throw new NotFoundException('Planta no registrada: créela primero (POST /api/plants)');
    }
    await this.audit.record(user, 'plant.alarm_policy', `plant:${plant}`, orgId, { ...policy });
    return policy;
  }

  /** KPIs de la ventana que termina en `now`. `perDay` = total / días de la ventana. */
  async kpis(
    plant: string,
    window: AlarmKpis['window'] = '24h',
    now = Date.now(),
  ): Promise<AlarmKpis> {
    const days = KPI_WINDOWS[window];
    const from = now - days * DAY_MS;
    const policy = await this.repo.getPolicy(plant);
    const data = await this.repo.data(plant, from, now, now - policy.staleHours * 3_600_000);
    const perDay = data.total / days;
    return {
      window,
      from,
      to: now,
      policy,
      total: data.total,
      perDay,
      perHour: data.total / (days * 24),
      peak10min: data.peak10min,
      byPriority: data.byPriority,
      top: data.top,
      chattering: data.chattering,
      stale: data.stale,
      shelved: data.shelved,
      suppressed: data.suppressed,
      outOfService: data.outOfService,
      status: kpiStatus(perDay, data.peak10min.count, policy),
    };
  }
}
