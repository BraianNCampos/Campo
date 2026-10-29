import { Injectable, Logger } from '@nestjs/common';
import type { AuditEntry } from '@campo/shared';
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
   * (audit.fields.ts). Decisión: la auditoría es "best effort" y NO tumba la operación principal: si
   * escribirla falla, la operación (ya confirmada) sigue siendo válida, el error se registra en el log de
   * errores y este método no lanza. Es preferible un hueco visible en los logs a deshacer o rechazar un
   * cambio legítimo (p. ej. un ack de alarma) por un fallo de la tabla de auditoría.
   */
  async record(
    actor: AuditActor | null,
    action: AuditAction,
    target: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.repo.insert({
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action,
        target,
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

  list(q: AuditListQuery): Promise<AuditEntry[]> {
    return this.repo.list({
      limit: q.limit ?? 50,
      before: q.before,
      actor: q.actor?.trim() || undefined,
      action: q.action,
    });
  }
}
