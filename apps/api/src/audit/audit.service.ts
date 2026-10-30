import { Injectable, Logger } from '@nestjs/common';
import type { AuditEntry } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { isPlatform, orgIdOf } from '../auth/plant-access';
import { AuditAction, sanitizeDetail } from './audit.fields';
import { AuditRepository } from './audit.repository';
import type { AuditListQuery } from './dto';

/** Quién actúa: lo que lleva `req.user`. */
export interface AuditActor {
  id: string;
  email: string;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly repo: AuditRepository) {}

  /**
   * Registra una acción ya realizada. `detail` pasa por la lista de campos permitidos de la acción
   * (audit.fields.ts). `orgId` = cliente del recurso AFECTADO (no el del actor: un platform_admin que
   * edita una planta de un cliente la registra en ese cliente); `null` sólo para acciones de plataforma.
   * Decisión: la auditoría es "best effort" y NO tumba la operación principal: si
   * escribirla falla, la operación (ya confirmada) sigue siendo válida, el error se registra en el log de
   * errores y este método no lanza. Es preferible un hueco visible en los logs a deshacer o rechazar un
   * cambio legítimo (p. ej. un ack de alarma) por un fallo de la tabla de auditoría.
   */
  async record(
    actor: AuditActor | null,
    action: AuditAction,
    target: string,
    orgId: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.repo.insert({
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action,
        target,
        orgId,
        detail: sanitizeDetail(action, detail),
      });
    } catch (err) {
      this.log.error({
        msg: 'no se pudo escribir la auditoría',
        action,
        target,
        actorId: actor?.id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Un admin ve SIEMPRE sólo la auditoría de su cliente (ignora cualquier filtro de cliente que mande);
   * platform_admin ve todo y puede filtrar con `orgId`/`org`.
   */
  list(q: AuditListQuery, user: AuthUser): Promise<AuditEntry[]> {
    const own = orgIdOf(user);
    if (!isPlatform(user) && own === null) return Promise.resolve([]);
    return this.repo.list({
      orgId: isPlatform(user) ? (q.orgId ?? q.org) : (own as string),
      limit: q.limit ?? 50,
      before: q.before,
      actor: q.actor?.trim() || undefined,
      action: q.action,
    });
  }
}
