import { Inject, Injectable } from '@nestjs/common';
import type { AuditEntry } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export interface NewAuditEntry {
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string;
  /** Cliente del recurso afectado (`null` = acción de plataforma sin cliente). */
  orgId: string | null;
  detail: Record<string, unknown>;
}

export interface AuditQuery {
  /** Sólo entradas de este cliente (undefined = todos; sólo platform_admin). */
  orgId?: string;
  limit: number;
  /** Sólo entradas con id < before. */
  before?: string;
  /** id (UUID) o email del actor. */
  actor?: string;
  action?: string;
}

/** Sólo se inserta y se lee: la auditoría no se edita ni se borra. */
export abstract class AuditRepository {
  abstract insert(entry: NewAuditEntry): Promise<void>;
  /** Más recientes primero (id descendente). */
  abstract list(q: AuditQuery): Promise<AuditEntry[]>;
}

interface AuditRow {
  id: string;
  ts: Date;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target: string;
  org_id: string | null;
  detail: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PgAuditRepository extends AuditRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async insert(e: NewAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, target, org_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [e.actorId, e.actorEmail, e.action, e.target, e.orgId, JSON.stringify(e.detail)],
    );
  }

  async list(q: AuditQuery): Promise<AuditEntry[]> {
    // `actor` casa con el id (si parece un UUID) o con el email, sin distinguir mayúsculas.
    const actorId = q.actor && UUID.test(q.actor) ? q.actor : null;
    const actorEmail = q.actor && !actorId ? q.actor.toLowerCase() : null;
    // `ORDER BY audit_log.id` calificado a propósito: con `ORDER BY id` Postgres usaría el alias de salida
    // `id::text` y ordenaría como cadena ("9" > "21").
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT id::text AS id, ts, actor_id, actor_email, action, target, org_id, detail
         FROM audit_log
        WHERE ($1::bigint IS NULL OR id < $1)
          AND ($2::uuid IS NULL OR actor_id = $2)
          AND ($3::text IS NULL OR lower(actor_email) = $3)
          AND ($4::text IS NULL OR action = $4)
          AND ($6::text IS NULL OR org_id = $6)
        ORDER BY audit_log.id DESC
        LIMIT $5`,
      [q.before ?? null, actorId, actorEmail, q.action ?? null, q.limit, q.orgId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      action: r.action,
      target: r.target,
      orgId: r.org_id,
      detail: r.detail ?? {},
    }));
  }
}
