import { Inject, Injectable } from '@nestjs/common';
import type { ModuleId, Org, OrgSummary } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

/** Cliente tal como se guarda (sin contadores). */
export interface OrgRecord {
  id: string;
  name: string;
  modules: ModuleId[];
  active: boolean;
  createdAt: number;
}

export interface OrgPatch {
  name?: string;
  modules?: ModuleId[];
  active?: boolean;
}

export type OrgDeleteResult = 'ok' | 'not_found' | 'has_children';

export const toSummary = (o: Pick<OrgRecord, 'id' | 'name' | 'modules'>): OrgSummary => ({
  id: o.id,
  name: o.name,
  modules: [...o.modules],
});

export abstract class OrgsRepository {
  abstract findById(id: string): Promise<OrgRecord | null>;
  /** Todos los clientes con contadores de plantas y usuarios, por id. */
  abstract list(): Promise<Org[]>;
  /** null si el id ya existe. */
  abstract create(org: Omit<OrgRecord, 'createdAt'>): Promise<OrgRecord | null>;
  /** null si no existe. */
  abstract update(id: string, patch: OrgPatch): Promise<OrgRecord | null>;
  /** `has_children`: aún tiene plantas o usuarios. */
  abstract delete(id: string): Promise<OrgDeleteResult>;
}

interface OrgRow {
  id: string;
  name: string;
  modules: ModuleId[];
  active: boolean;
  created_at: Date;
}

const COLUMNS = 'id, name, modules, active, created_at';

const toRecord = (r: OrgRow): OrgRecord => ({
  id: r.id,
  name: r.name,
  modules: r.modules ?? [],
  active: r.active,
  createdAt: r.created_at.getTime(),
});

@Injectable()
export class PgOrgsRepository extends OrgsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async findById(id: string): Promise<OrgRecord | null> {
    const { rows } = await this.pool.query<OrgRow>(
      `SELECT ${COLUMNS} FROM organizations WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(): Promise<Org[]> {
    const { rows } = await this.pool.query<OrgRow & { plants: number; users: number }>(
      `SELECT o.id, o.name, o.modules, o.active, o.created_at,
              (SELECT count(*) FROM plants p WHERE p.org_id = o.id)::int AS plants,
              (SELECT count(*) FROM users u WHERE u.org_id = o.id)::int AS users
         FROM organizations o ORDER BY o.id`,
    );
    return rows.map((r) => ({ ...toRecord(r), plants: r.plants, users: r.users }));
  }

  async create(o: Omit<OrgRecord, 'createdAt'>): Promise<OrgRecord | null> {
    const { rows } = await this.pool.query<OrgRow>(
      `INSERT INTO organizations (id, name, modules, active) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING RETURNING ${COLUMNS}`,
      [o.id, o.name, o.modules, o.active],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(id: string, patch: OrgPatch): Promise<OrgRecord | null> {
    const { rows } = await this.pool.query<OrgRow>(
      `UPDATE organizations
          SET name = COALESCE($2, name), modules = COALESCE($3, modules), active = COALESCE($4, active)
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, patch.name ?? null, patch.modules ?? null, patch.active ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async delete(id: string): Promise<OrgDeleteResult> {
    try {
      const res = await this.pool.query('DELETE FROM organizations WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0 ? 'ok' : 'not_found';
    } catch (err) {
      // 23503: las FK (plants.org_id, users.org_id) impiden borrar un cliente con datos.
      if ((err as { code?: string }).code === '23503') return 'has_children';
      throw err;
    }
  }
}
