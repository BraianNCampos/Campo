import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@campo/shared';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/tokens';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  /** Versión de sesión: el JWT lleva `tv` y sólo vale mientras coincida (revocación de tokens). */
  tokenVersion: number;
  /** Cliente del usuario; `null` = personal de plataforma (`platform_admin`). */
  orgId: string | null;
  /** Plantas asignadas (user_plants) que pertenecen a su cliente, ordenadas. Sin asignaciones = []. */
  plants: string[];
}

export interface NewUser {
  email: string;
  passwordHash: string;
  role: Role;
  /** Obligatorio salvo para `platform_admin` (la base lo exige: CHECK users_org_role_check). */
  orgId: string | null;
}

export interface UserPatch {
  role?: Role;
  active?: boolean;
  passwordHash?: string;
  /** Incrementa `token_version`: invalida todos los tokens emitidos hasta ahora. */
  revokeTokens?: boolean;
}

export type UpdateResult =
  | { status: 'ok'; user: User }
  | { status: 'not_found' }
  /** El cambio dejaría a su cliente (o a la plataforma) sin ningún administrador activo. */
  | { status: 'last_admin' };

export abstract class UsersRepository {
  abstract findByEmail(email: string): Promise<User | null>;
  abstract findById(id: string): Promise<User | null>;
  /** `orgId` restringe a los usuarios de ese cliente (undefined = todos, incluido el personal de plataforma). */
  abstract list(filter?: { orgId?: string }): Promise<User[]>;
  /** Crea el usuario; devuelve null si el email ya existe. */
  abstract create(input: NewUser): Promise<User | null>;
  /** Aplica el cambio garantizando (atómicamente) que queda al menos un admin activo en su cliente. */
  abstract update(id: string, patch: UserPatch): Promise<UpdateResult>;
  /** Reemplaza las plantas asignadas. Devuelve null si el usuario no existe. */
  abstract setPlants(id: string, plants: string[]): Promise<User | null>;
  /** Ids de los usuarios de un cliente. */
  abstract idsByOrg(orgId: string): Promise<string[]>;
  /** Sube `token_version` de todos los usuarios del cliente (cierra sus sesiones). Devuelve sus ids. */
  abstract revokeByOrg(orgId: string): Promise<string[]>;
  /**
   * Lo convierte en `platform_admin` sin cliente y sin plantas asignadas, y cierra sus sesiones.
   * null si no existe. No hace nada (devuelve el usuario) si ya lo es.
   */
  abstract promoteToPlatformAdmin(id: string): Promise<User | null>;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  active: boolean;
  token_version: number;
  org_id: string | null;
  plants: string[];
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  active: r.active,
  tokenVersion: r.token_version,
  orgId: r.org_id,
  plants: r.plants ?? [],
});

// Las plantas asignadas sólo cuentan si pertenecen al cliente del usuario (una fila cruzada es inerte).
const SELECT_USER = `SELECT u.id, u.email, u.password_hash, u.role, u.active, u.token_version, u.org_id,
  ARRAY(SELECT up.plant FROM user_plants up JOIN plants p ON p.id = up.plant AND p.org_id = u.org_id
         WHERE up.user_id = u.id ORDER BY up.plant) AS plants
  FROM users u`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles cuyo último miembro activo (por cliente; el personal de plataforma, en conjunto) no se puede quitar. */
const GUARDED_ROLES: Role[] = ['admin', 'platform_admin'];

/** Clave del advisory lock que serializa los cambios que pueden afectar al "último admin". */
const ADMIN_LOCK_KEY = 730_001;

@Injectable()
export class PgUsersRepository extends UsersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `${SELECT_USER} WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(id: string): Promise<User | null> {
    if (!UUID.test(id)) return null; // un `sub` que no es UUID no puede existir (y evitaría un error de tipo en SQL)
    const { rows } = await this.pool.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async list(filter: { orgId?: string } = {}): Promise<User[]> {
    const { rows } = await this.pool.query<UserRow>(
      `${SELECT_USER} WHERE ($1::text IS NULL OR u.org_id = $1) ORDER BY lower(u.email)`,
      [filter.orgId ?? null],
    );
    return rows.map(toUser);
  }

  async create(input: NewUser): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, role, org_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, email, password_hash, role, active, token_version, org_id, ARRAY[]::text[] AS plants`,
      [input.email, input.passwordHash, input.role, input.orgId],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async update(id: string, patch: UserPatch): Promise<UpdateResult> {
    if (!UUID.test(id)) return { status: 'not_found' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializa los cambios entre sí: dos peticiones concurrentes no pueden quitar los dos últimos admins.
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_LOCK_KEY]);
      const cur = await client.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
      if (!cur.rows[0]) {
        await client.query('ROLLBACK');
        return { status: 'not_found' };
      }
      const before = cur.rows[0];
      const role = patch.role ?? before.role;
      const active = patch.active ?? before.active;
      if (
        GUARDED_ROLES.includes(before.role) &&
        before.active &&
        !(role === before.role && active)
      ) {
        const others = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM users
            WHERE role = $2 AND active AND id <> $1 AND org_id IS NOT DISTINCT FROM $3`,
          [id, before.role, before.org_id],
        );
        if (others.rows[0].n === 0) {
          await client.query('ROLLBACK');
          return { status: 'last_admin' };
        }
      }
      const tokenVersion = before.token_version + (patch.revokeTokens ? 1 : 0);
      await client.query(
        'UPDATE users SET role = $2, active = $3, password_hash = $4, token_version = $5 WHERE id = $1',
        [id, role, active, patch.passwordHash ?? before.password_hash, tokenVersion],
      );
      await client.query('COMMIT');
      return { status: 'ok', user: { ...toUser(before), role, active, tokenVersion } };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async setPlants(id: string, plants: string[]): Promise<User | null> {
    if (!UUID.test(id)) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (exists.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('DELETE FROM user_plants WHERE user_id = $1', [id]);
      if (plants.length > 0) {
        await client.query(
          'INSERT INTO user_plants (user_id, plant) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
          [id, plants],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.findById(id);
  }

  async idsByOrg(orgId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM users WHERE org_id = $1',
      [orgId],
    );
    return rows.map((r) => r.id);
  }

  async revokeByOrg(orgId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      'UPDATE users SET token_version = token_version + 1 WHERE org_id = $1 RETURNING id',
      [orgId],
    );
    return rows.map((r) => r.id);
  }

  async promoteToPlatformAdmin(id: string): Promise<User | null> {
    if (!UUID.test(id)) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_LOCK_KEY]);
      const cur = await client.query<{ role: Role }>(
        'SELECT role FROM users WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!cur.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      if (cur.rows[0].role !== 'platform_admin') {
        await client.query('DELETE FROM user_plants WHERE user_id = $1', [id]);
        await client.query(
          `UPDATE users SET role = 'platform_admin', org_id = NULL, token_version = token_version + 1 WHERE id = $1`,
          [id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.findById(id);
  }
}
