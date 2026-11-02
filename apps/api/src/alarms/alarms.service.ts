import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { TenantScope } from '../auth/tenant-scope';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmJournalRepository, JournalRow } from './alarm-journal.repository';
import { AlarmRecord } from './alarm.types';
import { AlarmsRepository } from './alarms.repository';
import { ListAlarmsQuery, ShelveDto } from './dto';

@Injectable()
export class AlarmsService {
  constructor(
    private readonly repo: AlarmsRepository,
    private readonly engine: AlarmEngine,
    private readonly journal: AlarmJournalRepository,
    private readonly audit: AuditService,
    private readonly tenant: TenantScope,
  ) {}

  /** Sólo alarmas de las plantas y el cliente del usuario; `?plant=` pedido y no permitido -> 403. */
  async list(q: ListAlarmsQuery, user: AuthUser): Promise<AlarmRecord[]> {
    if (q.plant) await this.tenant.assertPlant(user, q.plant);
    return this.repo.list({
      state: q.state,
      plant: q.plant,
      scope: this.tenant.scope(user),
      limit: q.limit ?? 100,
    });
  }

  /**
   * La planta de la alarma decide: 404 si no existe, 403 (genérico) si el usuario no tiene esa planta o es de
   * otro cliente. Devuelve el cliente propietario para la auditoría.
   */
  private async load(
    id: string,
    user: AuthUser,
  ): Promise<{ alarm: AlarmRecord; orgId: string | null }> {
    const alarm = await this.repo.findById(id);
    if (!alarm) throw new NotFoundException('Alarma no encontrada');
    return { alarm, orgId: await this.tenant.assertPlant(user, alarm.plant) };
  }

  /** Reconoce una alarma (idempotente): unacked -> acked; normalizada sin reconocer -> closed. */
  async ack(id: string, user: AuthUser, now = Date.now()): Promise<AlarmRecord> {
    const { orgId } = await this.load(id, user);
    const res = await this.repo.ack(id, user.id, now);
    if (!res) throw new NotFoundException('Alarma no encontrada');
    if (res.record.lifecycle === 'shelved') {
      throw new ConflictException('La alarma está postergada: levante la postergación primero');
    }
    if (res.changed) {
      await this.engine.onAcked(res.record, user.id);
      // Sólo el primer ack (el idempotente que no cambia nada no se audita).
      await this.audit.record(user, 'alarm.ack', `alarm:${id}`, orgId, {
        plant: res.record.plant,
        asset: res.record.asset,
        metric: res.record.metric,
        severity: res.record.severity,
      });
    }
    return res.record;
  }

  /** Posterga una alarma activa `minutes` minutos; al vencer se reanuncia sola si sigue activa. */
  async shelve(id: string, dto: ShelveDto, user: AuthUser, now = Date.now()): Promise<AlarmRecord> {
    const { alarm, orgId } = await this.load(id, user);
    const record = await this.repo.shelve(id, now + dto.minutes * 60_000, user.id, dto.reason);
    if (!record) {
      throw new ConflictException(
        alarm.lifecycle === 'shelved'
          ? 'La alarma ya está postergada'
          : 'Sólo se puede postergar una alarma activa',
      );
    }
    await this.engine.onShelved(record, user.id, dto.minutes);
    await this.audit.record(user, 'alarm.shelve', `alarm:${id}`, orgId, {
      plant: record.plant,
      asset: record.asset,
      metric: record.metric,
      severity: record.severity,
      minutes: dto.minutes,
    });
    return record;
  }

  /** Levanta la postergación: la alarma vuelve a la lista como `unacked`. */
  async unshelve(id: string, user: AuthUser): Promise<AlarmRecord> {
    const { orgId } = await this.load(id, user);
    const record = await this.engine.unshelve(id, user.id);
    if (!record) throw new ConflictException('La alarma no está postergada');
    await this.audit.record(user, 'alarm.unshelve', `alarm:${id}`, orgId, {
      plant: record.plant,
      asset: record.asset,
      metric: record.metric,
      severity: record.severity,
    });
    return record;
  }

  /** Diario de la alarma (activación, reconocimiento, normalización, postergación...). */
  async journalOf(id: string, user: AuthUser): Promise<JournalRow[]> {
    await this.load(id, user);
    return this.journal.list(id);
  }
}
