import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export type JournalType = 'activate' | 'ack' | 'rtn' | 'shelve' | 'unshelve' | 'suppress' | 'close';

/** Una entrada a escribir. `alarmId` es null sólo en `suppress` (la alarma suprimida no llega a existir). */
export interface JournalEntry {
  alarmId: string | null;
  plant: string;
  ruleId?: string;
  asset?: string;
  metric?: string;
  ts: number;
  type: JournalType;
  /** null/ausente = el sistema (activación, normalización, vencimiento de una postergación). */
  userId?: string | null;
  value?: number;
  note?: string;
}

/** Una entrada del diario tal como la devuelve `GET /api/alarms/:id/journal`. */
export interface JournalRow {
  id: string;
  ts: number;
  type: JournalType;
  userId: string | null;
  userEmail: string | null;
  note: string | null;
  value: number | null;
}

export abstract class AlarmJournalRepository {
  /** Escribe varias entradas de una vez (una sola consulta). */
  abstract add(entries: JournalEntry[]): Promise<void>;
  /** Diario de una alarma en orden cronológico, con el email de quien actuó (un solo JOIN, sin N+1). */
  abstract list(alarmId: string, limit?: number): Promise<JournalRow[]>;
}

interface Row {
  id: string;
  ts: Date;
  type: JournalType;
  user_id: string | null;
  email: string | null;
  note: string | null;
  value: number | null;
}

@Injectable()
export class PgAlarmJournalRepository extends AlarmJournalRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async add(entries: JournalEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.pool.query(
      `INSERT INTO alarm_events (alarm_id, plant, rule_id, asset, metric, ts, type, user_id, value, note)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::text[],
                            $6::timestamptz[], $7::text[], $8::uuid[], $9::double precision[], $10::text[])`,
      [
        entries.map((e) => e.alarmId),
        entries.map((e) => e.plant),
        entries.map((e) => e.ruleId ?? null),
        entries.map((e) => e.asset ?? null),
        entries.map((e) => e.metric ?? null),
        entries.map((e) => new Date(e.ts).toISOString()),
        entries.map((e) => e.type),
        entries.map((e) => e.userId ?? null),
        entries.map((e) => e.value ?? null),
        entries.map((e) => e.note ?? null),
      ],
    );
  }

  async list(alarmId: string, limit = 200): Promise<JournalRow[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT e.id, e.ts, e.type, e.user_id, u.email, e.note, e.value
         FROM alarm_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.alarm_id = $1 ORDER BY e.ts, e.id LIMIT $2`,
      [alarmId, limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      ts: r.ts.getTime(),
      type: r.type,
      userId: r.user_id,
      userEmail: r.email,
      note: r.note,
      value: r.value === null ? null : Number(r.value),
    }));
  }
}
