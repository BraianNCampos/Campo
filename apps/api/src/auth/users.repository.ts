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
}

export abstract class UsersRepository {
  abstract findByEmail(email: string): Promise<User | null>;
  /** Crea el usuario; devuelve null si el email ya existe. */
  abstract create(input: { email: string; passwordHash: string; role: Role }): Promise<User | null>;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  active: boolean;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  active: r.active,
});

@Injectable()
export class PgUsersRepository extends UsersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    super();
  }

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, email, password_hash, role, active FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async create(input: { email: string; passwordHash: string; role: Role }): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id, email, password_hash, role, active`,
      [input.email, input.passwordHash, input.role],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }
}
